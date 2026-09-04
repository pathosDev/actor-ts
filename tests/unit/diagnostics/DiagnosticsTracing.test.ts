/**
 * The three `actor-ts.diagnostics.debug.*` traces (#867).
 *
 * Every case is a pair: the record appears with the switch on, and the
 * *identical* fixture produces nothing with it off.  The negative half is not
 * decoration — a trace that never ran would satisfy a silence assertion
 * always, so each off-case waits for the transition to have genuinely
 * happened before asserting that nothing was written about it.
 *
 * A trace is an absence when the switch is off, and an absence cannot be
 * polled for.  So the off-cases wait on the transition itself, through
 * lifecycle hooks the switch does not gate — {@link witness}.
 *
 * All three emit at `debug`, so an operator needs two switches: the key here,
 * and `actor-ts.logger.level = debug`.  `RecordingLogger` defaults to
 * `LogLevel.Debug`, which is the second switch in this fixture.
 */
import { match } from 'ts-pattern';
import { beforeEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { DiagnosticsOptions } from '../../../src/diagnostics/DiagnosticsOptions.js';
import { ActorStarted } from '../../../src/SystemMessages.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

type KnownCommand = { readonly kind: 'known' };
type StrangeCommand = { readonly kind: 'strange' };
type Command = KnownCommand | StrangeCommand;

/** What the fixtures below record about themselves.  Reset per test. */
const witness = { stopped: false, restarted: false, declined: false };
beforeEach(() => {
  witness.stopped = false;
  witness.restarted = false;
  witness.declined = false;
});

/** Declines anything it does not know, which is what produces the record. */
class Decliner extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'known' }, (m) => this.onKnown(m))
      .otherwise((m) => this.onUnhandled(m));
  }

  private onKnown(_message: KnownCommand): void { /* handled */ }

  private onUnhandled(message: Command): void {
    this.unhandled(message);
    witness.declined = true;
  }
}

/** Something to name as the sender of the declined message. */
class Bystander extends Actor<string> {
  override onReceive(_message: string): void { /* never told anything */ }
}

/** Fails on every message.  `postRestart` runs on the incoming instance. */
class Crasher extends Actor<string> {
  override onReceive(): void { throw new Error('boom'); }
  override postRestart(_cause: Error): void { witness.restarted = true; }
}

class Quiet extends Actor<string> {
  override onReceive(_message: string): void { /* nothing */ }
  override postStop(): void { witness.stopped = true; }
}

type Fixture = { readonly system: ActorSystem; readonly log: RecordingLogger };

/**
 * A system with a capturing logger and the named switches set through HOCON.
 *
 * HOCON rather than `withDiagnostics` for most cases, because the path worth
 * covering by default is the one an operator actually uses, and it is the
 * longer one: leaf, reader, merge, resolved field, read site.  Two cases
 * below take the builder instead, so the explicit layer is covered too.
 */
const systemWith = (name: string, debugKeys: Record<string, boolean>): Fixture => {
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(log)
    .withConfig({ 'actor-ts': { diagnostics: { debug: debugKeys } } });
  return { system: ActorSystem.create(name, systemOptions), log };
};

const messagesContaining = (log: RecordingLogger, needle: string): string[] =>
  log.records.filter((record) => record.message.includes(needle)).map((r) => r.message);

const stoppedRecords = (log: RecordingLogger): string[] =>
  log.records.filter((r) => r.message === 'stopped' && r.level === 'debug').map((r) => r.message);

describe('diagnostics.debug.lifecycle', () => {
  test('on: start, stop and restart each leave one debug record', async () => {
    const { system, log } = systemWith('trace-lifecycle-on', { lifecycle: true });

    const quiet = system.spawn(Quiet, 'q');
    quiet.stop();
    await awaitCondition(() => stoppedRecords(log).length > 0, {
      timeoutMs: 4_000,
      label: 'the stop record was written',
    });

    expect(messagesContaining(log, 'started — Quiet')).toHaveLength(1);
    expect(stoppedRecords(log)).toHaveLength(1);

    const crasher = system.spawn(Crasher, 'c');
    crasher.tell('go');
    await awaitCondition(() => messagesContaining(log, 'restarted after Error: boom').length > 0, {
      timeoutMs: 4_000,
      label: 'the restart record was written',
    });

    // The path is not in the message: it is the record's `source`, which the
    // cell's logger binds once.  What the message carries is the class, and
    // for the restart the cause — the two facts the path does not give.
    expect(messagesContaining(log, 'restarted after Error: boom')).toHaveLength(1);
    await system.terminate();
  });

  test('off: the identical fixture is silent', async () => {
    const { system, log } = systemWith('trace-lifecycle-off', { lifecycle: false });

    const quiet = system.spawn(Quiet, 'q');
    quiet.stop();
    const crasher = system.spawn(Crasher, 'c');
    crasher.tell('go');
    await awaitCondition(() => witness.stopped && witness.restarted, {
      timeoutMs: 4_000,
      label: 'the actor really stopped and the crasher really restarted',
    });

    expect(messagesContaining(log, 'started — Quiet')).toHaveLength(0);
    expect(messagesContaining(log, 'restarted after')).toHaveLength(0);
    expect(stoppedRecords(log)).toHaveLength(0);
    await system.terminate();
  });

  test('a default system traces nothing, so the switch is what turns it on', async () => {
    const log = new RecordingLogger();
    const system = ActorSystem.create('trace-default', ActorSystemOptions.create().withLogger(log));

    const quiet = system.spawn(Quiet, 'q');
    quiet.stop();
    await awaitCondition(() => witness.stopped, {
      timeoutMs: 4_000,
      label: 'the actor really stopped',
    });

    expect(messagesContaining(log, 'started — Quiet')).toHaveLength(0);
    expect(stoppedRecords(log)).toHaveLength(0);
    await system.terminate();
  });
});

describe('diagnostics.debug.unhandled', () => {
  test('on: the record names the recipient, the message class and the sender', async () => {
    const { system, log } = systemWith('trace-unhandled-on', { unhandled: true });
    const decliner = system.spawn(Decliner, 'd');
    const bystander = system.spawn(Bystander, 'b');

    decliner.tell({ kind: 'strange' }, bystander);
    await awaitCondition(() => messagesContaining(log, 'unhandled message at').length > 0, {
      timeoutMs: 4_000,
      label: 'the unhandled record was written',
    });

    const [record] = messagesContaining(log, 'unhandled message at');
    expect(record).toContain('actor-ts://trace-unhandled-on/user/d');
    expect(record).toContain('from actor-ts://trace-unhandled-on/user/b');
    // The class of the MESSAGE, not of the actor — the actor is already named
    // by the path, and what the reader does not otherwise have is what was
    // sent.  The payload itself is never in the record.
    expect(record).toContain(': Object');
    expect(record).not.toContain('strange');
    await system.terminate();
  });

  test('off: the identical fixture is silent, while the message is still declined', async () => {
    const { system, log } = systemWith('trace-unhandled-off', { unhandled: false });
    const decliner = system.spawn(Decliner, 'd');

    decliner.tell({ kind: 'strange' });
    await awaitCondition(() => witness.declined, {
      timeoutMs: 4_000,
      label: 'the message really was declined',
    });

    expect(messagesContaining(log, 'unhandled message at')).toHaveLength(0);
    await system.terminate();
  });

  test('withDiagnostics reaches the declined-message path, so the explicit layer is covered', async () => {
    const log = new RecordingLogger();
    const diagnosticsOptions = DiagnosticsOptions.create().withDebugUnhandled();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withDiagnostics(diagnosticsOptions);
    const system = ActorSystem.create('trace-unhandled-code', systemOptions);

    system.spawn(Decliner, 'd').tell({ kind: 'strange' });
    await awaitCondition(() => messagesContaining(log, 'unhandled message at').length > 0, {
      timeoutMs: 4_000,
      label: 'the unhandled record was written',
    });

    await system.terminate();
  });
});

describe('diagnostics.debug.event-stream', () => {
  test('on: subscribe, a rejected duplicate and a scoped unsubscribe each leave a record', async () => {
    const { system, log } = systemWith('trace-bus-on', { 'event-stream': true });
    const listener = system.spawn(Quiet, 'l');

    expect(system.eventStream.subscribe(listener, ActorStarted)).toBe(true);
    expect(system.eventStream.subscribe(listener, ActorStarted)).toBe(false);
    expect(system.eventStream.unsubscribe(listener, ActorStarted)).toBe(true);

    expect(messagesContaining(log, 'EventStream: subscribed')).toHaveLength(1);
    expect(messagesContaining(log, 'subscribe rejected as a duplicate')).toHaveLength(1);
    expect(messagesContaining(log, 'EventStream: unsubscribed')).toHaveLength(1);
    expect(messagesContaining(log, 'EventStream: unsubscribed')[0])
      .toContain('1 subscription(s) removed');
    await system.terminate();
  });

  test('a whole-actor unsubscribe that removed nothing is not traced', async () => {
    // Every actor stop makes one, for every actor, subscribed or not.  Tracing
    // those would bury the subscription records under a copy of the lifecycle
    // trace — which is a separate switch precisely so it can be asked for
    // separately.
    const { system, log } = systemWith('trace-bus-noop', { 'event-stream': true });
    const listener = system.spawn(Quiet, 'l');

    expect(system.eventStream.unsubscribe(listener)).toBe(false);

    expect(messagesContaining(log, 'EventStream: unsubscribed')).toHaveLength(0);
    await system.terminate();
  });

  test('off: the identical fixture is silent', async () => {
    const { system, log } = systemWith('trace-bus-off', { 'event-stream': false });
    const listener = system.spawn(Quiet, 'l');

    expect(system.eventStream.subscribe(listener, ActorStarted)).toBe(true);
    expect(system.eventStream.unsubscribe(listener, ActorStarted)).toBe(true);

    expect(messagesContaining(log, 'EventStream:')).toHaveLength(0);
    await system.terminate();
  });

  test('withDiagnostics reaches the bus too, so the explicit layer is covered', async () => {
    const log = new RecordingLogger();
    const diagnosticsOptions = DiagnosticsOptions.create().withDebugEventStream();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withDiagnostics(diagnosticsOptions);
    const system = ActorSystem.create('trace-bus-code', systemOptions);
    const listener = system.spawn(Quiet, 'l');

    system.eventStream.subscribe(listener, ActorStarted);

    expect(messagesContaining(log, 'EventStream: subscribed')).toHaveLength(1);
    await system.terminate();
  });
});
