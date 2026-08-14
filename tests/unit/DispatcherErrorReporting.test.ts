import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorOptions } from '../../src/ActorOptions.js';
import { ActorPath } from '../../src/ActorPath.js';
import { ActorRef } from '../../src/ActorRef.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { MicrotaskDispatcher } from '../../src/Dispatcher.js';
import { Mailbox, type Envelope } from '../../src/internal/Mailbox.js';
import { LogLevel, NoopLogger, type Logger } from '../../src/Logger.js';
import type { LogContextData } from '../../src/LogContext.js';
import { DispatcherError } from '../../src/SystemMessages.js';
import { awaitCondition } from '../util/AwaitCondition.js';

/**
 * A failure inside a dispatched work unit used to reach `console.error` and
 * nothing else — invisible to every log sink, to the event stream, and to a
 * test (#410).  These tests drive the real path: a real system, a real
 * mailbox, and a subscriber on the real bus.
 *
 * The seam is the mailbox rather than a handler that throws, because a
 * handler that throws is exactly the case supervision already owns.  What
 * this issue is about is the machinery *around* the handler — the part no
 * supervisor strategy sees, which is why it needed a channel of its own.
 */

/** Records events without a cell, so a report cannot re-enter the dispatcher. */
class RecordingRef extends ActorRef<unknown> {
  readonly path: ActorPath;
  readonly received: unknown[] = [];
  constructor(pathName: string) {
    super();
    this.path = new ActorPath('', null, 'test-sys').child(pathName);
  }
  tell(message: unknown): void { this.received.push(message); }
}

/** The system logger, kept so the test can read what was written to it. */
class RecordingLogger implements Logger {
  readonly errors: Array<{ message: string; args: unknown[] }> = [];

  constructor(
    public level: LogLevel = LogLevel.Debug,
    private readonly root: RecordingLogger | null = null,
  ) {}

  private get sink(): RecordingLogger { return this.root ?? this; }

  debug(_message: string): void {}
  info(_message: string): void {}
  warn(_message: string): void {}
  error(message: string, ...args: unknown[]): void { this.sink.errors.push({ message, args }); }

  withSource(_source: string): Logger { return new RecordingLogger(this.level, this.sink); }
  withFields(_fields: LogContextData): Logger { return new RecordingLogger(this.level, this.sink); }
}

/**
 * Fails one dequeue on demand, then behaves.
 *
 * Armed by the test rather than failing on construction so the throw lands
 * on a turn the test triggered, not on the cell's start-up turn.  Failing
 * once and only once matters too: the cell's `finally` re-schedules while
 * the mailbox still has the message, so a permanently failing dequeue would
 * spin instead of ending the test.
 */
class ExplodingMailbox<T> extends Mailbox<T> {
  armed = false;
  override dequeueUser(): Envelope<T> | undefined {
    if (this.armed) {
      this.armed = false;
      throw new Error('mailbox dequeue exploded');
    }
    return super.dequeueUser();
  }
}

class Echo extends Actor<string> {
  readonly seen: string[] = [];
  override onReceive(message: string): void { this.seen.push(message); }
}

let consoleErrors: unknown[][];
const originalConsoleError = console.error;

beforeEach(() => {
  consoleErrors = [];
  console.error = ((...args: unknown[]) => { consoleErrors.push(args); }) as typeof console.error;
});

afterEach(() => {
  console.error = originalConsoleError;
});

describe('dispatcher failures reach the EventStream (#410)', () => {
  test('a failed actor turn is published as a DispatcherError naming the actor', async () => {
    const logger = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(logger)
      .withLogLevel(LogLevel.Debug);
    const system = ActorSystem.create('dispatcher-error-events', systemOptions);
    try {
      const probe = new RecordingRef('probe');
      system.eventStream.subscribe(probe, DispatcherError);

      const mailbox = new ExplodingMailbox<string>();
      const actorOptions = ActorOptions.create<string>().withMailbox(() => mailbox);
      const ref = system.spawn(Echo, 'echo', actorOptions);
      ref.tell('warm-up');
      await awaitCondition(() => mailbox.size === 0, {
        timeoutMs: 4_000,
        label: 'the actor drained its first message',
      });

      mailbox.armed = true;
      ref.tell('the turn that fails');
      await awaitCondition(() => probe.received.length === 1, {
        timeoutMs: 4_000,
        label: 'the failed turn was published on the event stream',
      });

      const event = probe.received[0] as DispatcherError;
      expect(event).toBeInstanceOf(DispatcherError);
      expect(event.cause.message).toBe('mailbox dequeue exploded');
      expect(event.actor?.path.toString()).toBe(ref.path.toString());
      expect(event.dispatcherId).toBe(system.dispatcher.id);

      // The same failure reached the system logger, which is what puts it in
      // front of every sink the logging subsystem has.
      const logged = logger.errors.filter((e) => e.message.includes('Unhandled dispatcher error'));
      expect(logged.length).toBe(1);
      expect(logged[0].message).toContain(ref.path.toString());
      expect((logged[0].args[0] as Error).message).toBe('mailbox dequeue exploded');

      // And it did NOT go to the console: that branch is the last resort for
      // a dispatcher with no sink, not a second copy of every report.
      expect(consoleErrors).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('a per-actor dispatcher the system never touched is covered too', async () => {
    // The instance below is constructed by the caller and handed to one
    // actor; `ActorSystem` never sees it, so anything that only wired
    // `system.dispatcher` would miss this failure entirely.
    const perActorDispatcher = new MicrotaskDispatcher();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('per-actor-dispatcher-errors', systemOptions);
    try {
      const probe = new RecordingRef('probe');
      system.eventStream.subscribe(probe, DispatcherError);

      const mailbox = new ExplodingMailbox<string>();
      const actorOptions = ActorOptions.create<string>()
        .withDispatcher(perActorDispatcher)
        .withMailbox(() => mailbox);
      const ref = system.spawn(Echo, 'crunchy', actorOptions);
      ref.tell('warm-up');
      await awaitCondition(() => mailbox.size === 0, {
        timeoutMs: 4_000,
        label: 'the actor drained its first message',
      });

      mailbox.armed = true;
      ref.tell('the turn that fails');
      await awaitCondition(() => probe.received.length === 1, {
        timeoutMs: 4_000,
        label: 'the per-actor dispatcher failure was published',
      });

      const event = probe.received[0] as DispatcherError;
      expect(event.dispatcherId).toBe('microtask-dispatcher');
      expect(event.dispatcherId).not.toBe(system.dispatcher.id);
      expect(event.actor?.path.toString()).toBe(ref.path.toString());
      expect(consoleErrors).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('work handed straight to the dispatcher is published with a null actor', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('bare-dispatcher-errors', systemOptions);
    try {
      const probe = new RecordingRef('probe');
      system.eventStream.subscribe(probe, DispatcherError);

      system.dispatcher.execute(() => { throw new Error('not an actor turn'); });
      await awaitCondition(() => probe.received.length === 1, {
        timeoutMs: 4_000,
        label: 'the bare work unit was published',
      });

      const event = probe.received[0] as DispatcherError;
      expect(event.actor).toBeNull();
      expect(event.cause.message).toBe('not an actor turn');
      expect(event.dispatcherId).toBe(system.dispatcher.id);
      expect(String(event)).toContain(system.dispatcher.id);
      expect(consoleErrors).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('a non-Error throw is normalised before it is published', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('non-error-throws', systemOptions);
    try {
      const probe = new RecordingRef('probe');
      system.eventStream.subscribe(probe, DispatcherError);

      system.dispatcher.execute(() => { throw 'a bare string'; });
      await awaitCondition(() => probe.received.length === 1, {
        timeoutMs: 4_000,
        label: 'the non-Error throw was published',
      });

      const event = probe.received[0] as DispatcherError;
      expect(event.cause).toBeInstanceOf(Error);
      expect(event.cause.message).toBe('a bare string');
    } finally {
      await system.terminate();
    }
  });
});

describe('the sink ActorSystem installs on its dispatcher (#410)', () => {
  test('a sink the caller already wired is not taken over', async () => {
    const dispatcher = new MicrotaskDispatcher();
    const mine: unknown[] = [];
    dispatcher.onError = (error) => { mine.push(error); };

    const systemOptions = ActorSystemOptions.create()
      .withDispatcher(dispatcher)
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('sink-not-taken-over', systemOptions);
    try {
      const probe = new RecordingRef('probe');
      system.eventStream.subscribe(probe, DispatcherError);

      dispatcher.execute(() => { throw new Error('mine to report'); });
      await awaitCondition(() => mine.length === 1, {
        timeoutMs: 4_000,
        label: "the caller's own sink saw the failure",
      });
      expect((mine[0] as Error).message).toBe('mine to report');
      expect(probe.received).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('termination takes the system sink back off a dispatcher it does not own', async () => {
    const dispatcher = new MicrotaskDispatcher();
    const systemOptions = ActorSystemOptions.create()
      .withDispatcher(dispatcher)
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('sink-detached-on-terminate', systemOptions);
    expect(dispatcher.onError).toBeDefined();

    await system.terminate();

    // The dispatcher outlives the system it was lent to, so it must not keep
    // reporting into a logger that has been closed.
    expect(dispatcher.onError).toBeUndefined();

    dispatcher.execute(() => { throw new Error('after the system went away'); });
    await awaitCondition(() => consoleErrors.length === 1, {
      timeoutMs: 4_000,
      label: 'the detached dispatcher fell back to the console',
    });
    expect(consoleErrors[0][0]).toBe('[actor-ts] unhandled dispatcher error:');
  });
});
