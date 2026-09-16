import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import {
  MessageBoundaryError,
  describeMessageType,
  structuredCloneProblem,
} from '../../../src/diagnostics/MessageBoundaryCheck.js';
import {
  MessageBoundaryOptions,
  MessageBoundaryOptionsValidator,
  readMessageBoundaryOptionsFromConfig,
} from '../../../src/diagnostics/MessageBoundaryOptions.js';
import { SystemGroups } from '../../../src/internal/SystemPaths.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { PoisonPill, Terminated } from '../../../src/SystemMessages.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestProbe } from '../../../src/testkit/TestProbe.js';
import { isFrameworkMessage } from '../../../src/util/FrameworkMessage.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/**
 * The message-boundary check (#1386): what the worker hop would do to a
 * message, decided at `tell` time on the sender's stack.
 */

class Deposit {
  constructor(readonly amount: number) {}
  double(): number { return this.amount * 2; }
}

class NotAnError extends Error {}

type Command = { readonly kind: 'count' } | { readonly kind: 'report'; readonly replyTo: ActorRef<number> };

class Counter extends Actor<unknown> {
  private count = 0;
  override onReceive(message: unknown): void {
    const command = message as Command;
    if (command.kind === 'count') this.count++;
    else if (command.kind === 'report') command.replyTo.tell(this.count);
  }
}

function systemOptions(): ReturnType<typeof ActorSystemOptions.create> {
  return ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
}

describe('structuredCloneProblem — what a worker hop would do to a message', () => {
  test('plain data, and everything the clone algorithm preserves, arrives intact', () => {
    const probe = { kind: 'ok', when: new Date(), pattern: /x/, tags: new Set(['a']), byName: new Map([['k', { n: 1 }]]),
      bytes: new Uint8Array(2), big: new BigInt64Array(1), error: new RangeError('r'), nested: [{ deep: [1, 2] }] };
    expect(structuredCloneProblem(probe)).toBeNull();
  });

  test('a class instance is reported as losing its prototype, at the top and at any depth', () => {
    expect(structuredCloneProblem(new Deposit(1))).toMatch(/instance of Deposit.*plain object without its prototype/);
    expect(structuredCloneProblem({ kind: 'wrap', payload: { items: [new Deposit(2)] } }))
      .toMatch(/value at \$\.payload\.items\[0\] is an instance of Deposit/);
    expect(structuredCloneProblem({ kind: 'map', byId: new Map([[7, new Deposit(3)]]) }))
      .toMatch(/\$\.byId\.get\(7\) is an instance of Deposit/);
    // A custom Error comes back as a plain Error — a subclass is lost too.
    expect(structuredCloneProblem({ kind: 'failed', cause: new NotAnError('x') })).toMatch(/instance of NotAnError/);
  });

  test('a value that cannot be cloned at all is reported as such', () => {
    expect(structuredCloneProblem({ kind: 'call', onDone: () => {} })).toMatch(/cannot be cloned at all/);
    expect(structuredCloneProblem({ kind: 'sym', tag: Symbol('s') })).toMatch(/cannot be cloned at all/);
  });

  test('an ActorRef anywhere in the message is fine — the wire rewrites refs before the port sees them', () => {
    const system = ActorSystem.create('refs', systemOptions());
    try {
      const probe = new TestProbe(system);
      expect(structuredCloneProblem({ kind: 'ask', replyTo: probe })).toBeNull();
      expect(structuredCloneProblem({ kind: 'many', targets: [probe, { inner: probe }] })).toBeNull();
    } finally {
      void system.terminate();
    }
  });

  test('a cyclic message does not hang the walk', () => {
    const cyclic: Record<string, unknown> = { kind: 'loop' };
    cyclic.self = cyclic;
    expect(structuredCloneProblem(cyclic)).toBeNull();
  });

  test('describeMessageType names the class, else the kind, else the shape', () => {
    expect(describeMessageType(new Deposit(1))).toBe('Deposit');
    expect(describeMessageType({ kind: 'count' })).toBe("{ kind: 'count' }");
    expect(describeMessageType({ value: 1 })).toBe('object');
    expect(describeMessageType([1])).toBe('array');
  });
});

describe('the framework marker', () => {
  test('the framework’s own message classes are marked, an application class is not', () => {
    expect(isFrameworkMessage(PoisonPill.instance)).toBe(true);
    expect(isFrameworkMessage(new Deposit(1))).toBe(false);
    expect(isFrameworkMessage({ kind: 'x' })).toBe(false);
    expect(isFrameworkMessage(null)).toBe(false);
  });
});

describe('MessageBoundaryCheck on a system', () => {
  test('off by default: a class instance is delivered like anything else', async () => {
    const system = ActorSystem.create('off', systemOptions());
    try {
      expect(system._messageBoundary).toBeNull();
      const counter = system.spawn(Counter, 'counter');
      expect(() => counter.tell(new Deposit(1))).not.toThrow();
    } finally {
      await system.terminate();
    }
  });

  test('fail: a lossy message throws out of tell, naming the type and the recipient; plain data passes', async () => {
    const options = systemOptions().withMessageBoundary(MessageBoundaryOptions.create().withStructuredClone('fail'));
    const system = ActorSystem.create('strict', options);
    try {
      const counter = system.spawn(Counter, 'counter');
      let caught: unknown;
      try { counter.tell(new Deposit(1)); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(MessageBoundaryError);
      const error = caught as MessageBoundaryError;
      expect(error.boundary).toBe('structured-clone');
      expect(error.messageType).toBe('Deposit');
      expect(error.recipient).toBe('actor-ts://strict/user/counter');
      expect(error.message).toContain('kind');

      counter.tell({ kind: 'count' });
      expect(await counter.ask<number>({ kind: 'report' })).toBe(1);
    } finally {
      await system.terminate();
    }
  });

  test('fail: the framework’s own messages pass — stop(), a watch’s Terminated, a PoisonPill by hand', async () => {
    const options = systemOptions().withMessageBoundary({ structuredClone: 'fail' });
    const system = ActorSystem.create('framework', options);
    try {
      const probe = new TestProbe(system);
      const watched = system.spawn(Counter, 'watched');
      const watcher = system.spawnAnonymous(class extends Actor<unknown> {
        override preStart(): void { this.context.watch(watched); }
        override onReceive(message: unknown): void { if (message instanceof Terminated) probe.tell('terminated'); }
      });
      expect(watcher).toBeDefined();
      expect(() => watched.tell(PoisonPill.instance)).not.toThrow();
      expect(await probe.receiveOne()).toBe('terminated');
    } finally {
      await system.terminate();
    }
  });

  test('fail: a system actor is never the far side of a hop, so messages to /system are exempt', async () => {
    const options = systemOptions().withMessageBoundary({ structuredClone: 'fail' });
    const system = ActorSystem.create('sys', options);
    try {
      const internal = system._spawnSystemActor(Counter, SystemGroups.delivery, 'internal');
      expect(internal.path.toString()).toBe('actor-ts://sys/system/delivery/internal');
      expect(() => internal.tell(new Deposit(1))).not.toThrow();
    } finally {
      await system.terminate();
    }
  });

  test('warn: one line per message type, and delivery goes ahead', async () => {
    const logger = new RecordingLogger(LogLevel.Warn);
    const options = ActorSystemOptions.create()
      .withLogger(logger)
      .withMessageBoundary({ structuredClone: 'warn' });
    const system = ActorSystem.create('lenient', options);
    try {
      const counter = system.spawn(Counter, 'counter');
      counter.tell(new Deposit(1));
      counter.tell(new Deposit(2));
      counter.tell({ kind: 'call', onDone: () => {} });
      const warnings = logger.records.filter((r) => r.message.includes('[message-boundary]'));
      expect(warnings).toHaveLength(2);
      expect(warnings[0]!.message).toContain('Deposit to actor-ts://lenient/user/counter');
      expect(warnings[1]!.message).toContain("{ kind: 'call' }");
    } finally {
      await system.terminate();
    }
  });

  test('serializer-round-trip: a message the serializer cannot take is reported through the same channel', async () => {
    const options = systemOptions().withMessageBoundary({ serializerRoundTrip: 'fail' });
    const system = ActorSystem.create('wire', options);
    try {
      const counter = system.spawn(Counter, 'counter');
      const cyclic: Record<string, unknown> = { kind: 'loop' };
      cyclic.self = cyclic;
      let caught: unknown;
      try { counter.tell(cyclic); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(MessageBoundaryError);
      expect((caught as MessageBoundaryError).boundary).toBe('serializer-round-trip');
      expect(() => counter.tell({ kind: 'count' })).not.toThrow();
      // The structured-clone half stayed off: a class instance is not its business.
      expect(() => counter.tell(new Deposit(1))).not.toThrow();
    } finally {
      await system.terminate();
    }
  });
});

describe('TestKit turns the structured-clone check on', () => {
  test('a class-instance message fails the test that sends it, and a caller who says otherwise is obeyed', async () => {
    const kit = TestKit.create('kit');
    try {
      expect(kit.system._messageBoundary?.structuredClone).toBe('fail');
      expect(kit.system._messageBoundary?.serializerRoundTrip).toBe('off');
      const counter = kit.system.spawn(Counter, 'counter');
      expect(() => counter.tell(new Deposit(1))).toThrow(MessageBoundaryError);
    } finally {
      await kit.shutdown();
    }
    const lenient = TestKit.create('lenient', { messageBoundary: { structuredClone: 'off' } });
    try {
      expect(lenient.system._messageBoundary).toBeNull();
    } finally {
      await lenient.shutdown();
    }
  });
});

describe('actor-ts.diagnostics.message-boundary config block', () => {
  test('every key it reads is reachable from ConfigKeys', () => {
    expect(ConfigKeys.messageBoundary).toEqual({
      structuredClone: 'actor-ts.diagnostics.message-boundary.structured-clone',
      serializerRoundTrip: 'actor-ts.diagnostics.message-boundary.serializer-round-trip',
    });
  });

  test('a builder is structurally the options it was given', () => {
    const built = MessageBoundaryOptions.create().withStructuredClone('warn').withSerializerRoundTrip('fail');
    expect({ ...built }).toEqual({ structuredClone: 'warn', serializerRoundTrip: 'fail' });
    expect(() => new MessageBoundaryOptionsValidator().validate({ ...built })).not.toThrow();
  });

  test('both leaves are read, and an unknown mode is refused', () => {
    const config = Config.parseString('actor-ts.diagnostics.message-boundary { structured-clone = warn, serializer-round-trip = fail }');
    expect(readMessageBoundaryOptionsFromConfig(config)).toEqual({ structuredClone: 'warn', serializerRoundTrip: 'fail' });
    expect(readMessageBoundaryOptionsFromConfig(Config.parseString('actor-ts.system.name = x'))).toEqual({});
    expect(() => new MessageBoundaryOptionsValidator().validate({ structuredClone: 'loud' as never })).toThrow(OptionsError);
    expect(() => ActorSystem.create('bad', systemOptions().withMessageBoundary({ serializerRoundTrip: 'maybe' as never })))
      .toThrow(OptionsError);
  });

  test('HOCON turns it on for a plain system', async () => {
    const options = systemOptions().withConfig({ 'actor-ts': { diagnostics: { 'message-boundary': { 'structured-clone': 'fail' } } } });
    const system = ActorSystem.create('hocon', options);
    try {
      expect(system._messageBoundary?.structuredClone).toBe('fail');
      expect(() => system.spawn(Counter, 'c').tell(new Deposit(1))).toThrow(MessageBoundaryError);
    } finally {
      await system.terminate();
    }
  });
});
