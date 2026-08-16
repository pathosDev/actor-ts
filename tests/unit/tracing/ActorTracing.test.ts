/**
 * Verify that the actor framework's auto-instrumentation produces
 * coherent traces — `actor.receive` spans propagate parent/child
 * relationships across actor-to-actor tells (#10).
 *
 * The chain we exercise:
 *
 *   - Outer caller starts a `client` span and tells actor A from
 *     inside it.  The `actor.receive` span on A's onReceive should
 *     have the client span as its parent.
 *
 *   - A tells B from within its handler.  The `actor.receive` span on
 *     B should have A's `actor.receive` span as its parent.
 *
 *   - All three spans share the same traceId (one logical trace).
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { RecordingTracer } from '../../../src/tracing/RecordingTracer.js';
import { TracingExtensionId } from '../../../src/tracing/TracingExtension.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('Actor tracing — auto-instrumentation', () => {
  test('actor.receive span has the caller\'s span as parent', async () => {
    const tracer = new RecordingTracer();
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tr-1', sysOptions);
    sys.extension(TracingExtensionId).enable(tracer);

    class Recv extends Actor<string> {
      override onReceive(_m: string): void { /* spans capture themselves */ }
    }

    try {
      const actorRef = sys.spawn(Recv, 'r');
      const client = tracer.startSpan('client.handle-request');
      tracer.withActiveSpan(client, () => {
        actorRef.tell('hello');
      });
      await awaitCondition(() => tracer.recorded().some((s) => s.name === 'actor.receive'), {
        timeoutMs: 4_000,
        label: 'the receive span was recorded',
      });
      client.end();

      const recorded = tracer.recorded();
      const recv = recorded.find((s) => s.name === 'actor.receive');
      expect(recv).toBeDefined();
      // The receive span's parent is the client span.
      expect(recv!.parent?.spanId).toBe(client.context().spanId);
      // Same trace id throughout.
      expect(recv!.context.traceId).toBe(client.context().traceId);
      // Useful attributes present.
      expect(recv!.attributes['actor.path']).toBeDefined();
    } finally {
      await sys.terminate();
    }
  });

  test('chained actors: span tree A→B inside one trace', async () => {
    const tracer = new RecordingTracer();
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tr-chain', sysOptions);
    sys.extension(TracingExtensionId).enable(tracer);

    class B extends Actor<string> {
      override onReceive(_m: string): void { /* */ }
    }
    class A extends Actor<{ message: string; next: ActorRef<string> }> {
      override onReceive(m: { message: string; next: ActorRef<string> }): void {
        m.next.tell(m.message);
      }
    }

    try {
      const actorB = sys.spawn(B, 'b');
      const actorA = sys.spawn(A, 'a');
      const client = tracer.startSpan('client');
      tracer.withActiveSpan(client, () => actorA.tell({ message: 'forward', next: actorB }));
      // Two hops, so two receive spans — waiting for both means the second
      // actor's span exists before its parent is looked up.
      await awaitCondition(
        () => tracer.recorded().filter((s) => s.name === 'actor.receive').length === 2,
        { timeoutMs: 4_000, label: 'both receive spans were recorded' },
      );
      client.end();

      const all = tracer.recorded();
      const traceId = client.context().traceId;
      // All actor.receive spans share the trace id.
      const recvs = all.filter((s) => s.name === 'actor.receive');
      expect(recvs.length).toBe(2);
      for (const actorRef of recvs) expect(actorRef.context.traceId).toBe(traceId);
      // One has client as parent (= the 'a' receive), the other has
      // 'a's spanId as parent (= the 'b' receive).
      const aRecv = recvs.find((actorRef) => actorRef.parent?.spanId === client.context().spanId);
      expect(aRecv).toBeDefined();
      const bRecv = recvs.find((actorRef) => actorRef.parent?.spanId === aRecv!.context.spanId);
      expect(bRecv).toBeDefined();
    } finally {
      await sys.terminate();
    }
  });

  test('handler error propagates to span: setStatus(error) + recordException', async () => {
    const tracer = new RecordingTracer();
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tr-err', sysOptions);
    sys.extension(TracingExtensionId).enable(tracer);

    class Bomb extends Actor<string> {
      override onReceive(_m: string): void { throw new Error('boom!'); }
    }

    try {
      const actorB = sys.spawn(Bomb, 'b');
      const root = tracer.startSpan('client');
      tracer.withActiveSpan(root, () => actorB.tell('boom'));
      await awaitCondition(() => tracer.recorded().some((s) => s.name === 'actor.receive'), {
        timeoutMs: 4_000,
        label: 'the failing receive span was recorded',
      });
      root.end();
      const recv = tracer.recorded().find((s) => s.name === 'actor.receive');
      expect(recv?.status).toBe('error');
      expect(recv?.statusMessage).toContain('boom!');
      expect(recv?.exceptions[0]?.message).toBe('boom!');
    } finally {
      await sys.terminate();
    }
  });

  test('without enabling the tracer, no spans are recorded', async () => {
    const tracer = new RecordingTracer();
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    // NOT enabling on the system — tracer stays as the noop default.
    const sys = ActorSystem.create('tr-noop', sysOptions);

    class R extends Actor<string> {
      override onReceive(): void { /* */ }
    }

    try {
      const actorRef = sys.spawn(R, 'r');
      actorRef.tell('x');
      await sleep(30);
      expect(tracer.recorded()).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });
});

describe('Actor tracing — switched on and off under load (#411)', () => {
  /**
   * Every other case in this file installs the tracer before it tells, so
   * none of them would notice a cell that resolved its tracer once and kept
   * it.  Since #411 the receive path reads `system._tracer` per message
   * instead of walking the extension chain twice, and these two cases are what
   * pin the "per message" half — DevTools' `SpanTap` installs and removes a
   * tracer at runtime whenever a panel opens or closes, with cells draining.
   *
   * The gate makes the window deterministic rather than racing a drain that
   * would otherwise finish inside a single poll interval.
   */
  function gatedDrain(): {
    gate: Promise<void>;
    release: () => void;
    firstParked: Promise<void>;
    parked: () => void;
  } {
    let release: () => void = () => {};
    let parked: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstParked = new Promise<void>((resolve) => { parked = resolve; });
    return { gate, release, firstParked, parked };
  }

  test('a tracer installed mid-drain traces from that message on', async () => {
    const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tr-midflight', options);
    const tracer = new RecordingTracer();
    const extension = sys.extension(TracingExtensionId);
    const { gate, release, firstParked, parked } = gatedDrain();
    let handled = 0;

    class Drainer extends Actor<string> {
      override async onReceive(message: string): Promise<void> {
        handled += 1;
        if (message === 'm0') { parked(); await gate; }
      }
    }

    try {
      const actorRef = sys.spawn(Drainer, 'd');
      for (let index = 0; index < 6; index++) actorRef.tell(`m${index}`);

      await firstParked;
      expect(tracer.recorded()).toEqual([]);
      extension.enable(tracer);
      // Root spans, so every message is traced rather than only ones that
      // already belong to a trace — otherwise this drain produces nothing to
      // count either way.
      extension.recordRootSpans(true);
      release();

      await awaitCondition(() => handled === 6, {
        timeoutMs: 4_000,
        label: 'the whole backlog drained',
      });
      await awaitCondition(() => tracer.recorded().length === 5, {
        timeoutMs: 4_000,
        label: 'the five messages behind the switch were traced',
      });
      // `m0` had already passed the span decision when the tracer arrived, so
      // it is not traced; the five behind it are.  A tracer resolved once per
      // cell would have left this empty.
      const names = new Set(tracer.recorded().map((span) => span.name));
      expect(names).toEqual(new Set(['actor.receive']));
    } finally {
      await sys.terminate();
    }
  });

  test('disabling mid-drain stops tracing on the very next message', async () => {
    const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tr-middisable', options);
    const tracer = new RecordingTracer();
    const extension = sys.extension(TracingExtensionId);
    extension.enable(tracer);
    extension.recordRootSpans(true);
    const { gate, release, firstParked, parked } = gatedDrain();
    let handled = 0;

    class Drainer extends Actor<string> {
      override async onReceive(message: string): Promise<void> {
        handled += 1;
        if (message === 'm0') { parked(); await gate; }
      }
    }

    try {
      const actorRef = sys.spawn(Drainer, 'd');
      for (let index = 0; index < 6; index++) actorRef.tell(`m${index}`);

      await firstParked;
      extension.disable();
      release();

      await awaitCondition(() => handled === 6, {
        timeoutMs: 4_000,
        label: 'the whole backlog drained',
      });
      await sleep(30);
      // Only `m0`, whose span was opened before the switch — nothing behind it.
      expect(tracer.recorded().length).toBe(1);
      expect(extension.isEnabled()).toBe(false);
    } finally {
      await sys.terminate();
    }
  });
});

describe('Actor tracing — tooling actors', () => {
  test('an internal actor produces no span, even inside an active trace', async () => {
    const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('internal-spans', options);
    const tracer = new RecordingTracer();
    system.extension(TracingExtensionId).enable(tracer);

    class Quiet extends Actor<string> {
      override onReceive(): void {}
    }
    const application = system.spawn(Quiet, 'application');
    const tooling = system.spawn(Quiet, 'tooling', { internal: true });

    const span = tracer.startSpan('client');
    await tracer.withActiveSpan(span, async () => {
      application.tell('a');
      tooling.tell('b');
    });
    span.end();
    // The application span appearing is the positive half; the tooling span
    // *not* appearing is the negative one, which the settle covers.
    await awaitCondition(
      () => tracer.recorded().some((recorded) =>
        String(recorded.attributes['actor.path'] ?? '').endsWith('/application')),
      { timeoutMs: 4_000, label: 'the application actor was traced' },
    );
    await sleep(40);

    const paths = tracer.recorded()
      .map((recorded) => recorded.attributes['actor.path'])
      .filter((path): path is string => typeof path === 'string');
    expect(paths.some((path) => path.endsWith('/application'))).toBe(true);
    // Excluding tooling only from *roots* was not enough: a probe that
    // receives an event-stream publish during an application message
    // inherits its trace and reappears in the middle of the route.
    expect(paths.some((path) => path.endsWith('/tooling'))).toBe(false);

    await system.terminate();
  });

  test('children inherit the mark', async () => {
    const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('internal-children', options);

    class Leaf extends Actor<string> {
      override onReceive(): void {}
    }
    class Root extends Actor<string> {
      child!: ActorRef<string>;
      override preStart(): void {
        this.child = this.context.spawn(Leaf, 'leaf');
      }
      override onReceive(message: string): void { this.child.tell(message); }
    }
    system.spawn(Root, 'root', { internal: true });
    await awaitCondition(
      () => system._inspectTree().filter((cell) => cell.internal).length === 2,
      { timeoutMs: 4_000, label: 'the root and its child were both marked internal' },
    );

    const marked = system._inspectTree()
      .filter((cell) => cell.internal)
      .map((cell) => cell.name)
      .sort();
    expect(marked).toEqual(['leaf', 'root']);

    await system.terminate();
  });
});
