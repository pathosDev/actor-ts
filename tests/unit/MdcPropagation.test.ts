/**
 * Verify that LogContext (#53) propagates through tells from one actor
 * to another within a single ActorSystem.  The chain we exercise:
 *
 *   - User calls `LogContext.run({correlationId: 'abc'}, () =>
 *     a.tell(msg))`.  The tell snapshots the ctx onto the envelope.
 *   - `a` receives the message.  Its handler is wrapped in
 *     `LogContext.run(envelope.context, ...)`, so when it calls
 *     `b.tell(...)` from inside the handler, that next envelope
 *     snapshots the same ctx.
 *   - `b` records the ctx it observed during its handler.  We assert
 *     it matches the one set at the top.
 */
import { describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../src/Actor.js';
import { ActorOptions } from '../../src/ActorOptions.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { ThroughputDispatcher } from '../../src/Dispatcher.js';
import { LogContext } from '../../src/LogContext.js';
import { ReceiveTimeout } from '../../src/SystemMessages.js';
// From the barrel, not the module: this is the shape an application has to be
// able to name, and only `src/index.ts` says whether it can (#1062).
import type { LogContextEntry } from '../../src/index.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { ManualScheduler } from '../../src/testkit/ManualScheduler.js';
import { awaitCondition } from '../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('LogContext — actor-to-actor propagation', () => {
  test('tell from within run() carries the context to the receiver', async () => {
    const observed: Array<Record<string, unknown>> = [];

    class Receiver extends Actor<string> {
      override onReceive(_m: string): void {
        observed.push({ ...LogContext.get() });
      }
    }

    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('mdc-1', sysOptions);
    try {
      const actorRef = sys.spawn(Receiver, 'r');
      LogContext.run({ correlationId: 'abc-123' }, () => {
        actorRef.tell('hello');
      });
      await awaitCondition(() => observed.length === 1, {
        timeoutMs: 4_000,
        label: 'the receiver handled the message',
      });
      expect(observed).toEqual([{ correlationId: 'abc-123' }]);
    } finally {
      await sys.terminate();
    }
  });

  test('downstream tell from inside the receiver inherits the same context', async () => {
    const observed: Array<Record<string, unknown>> = [];

    class Bottom extends Actor<string> {
      override onReceive(_m: string): void {
        observed.push({ ...LogContext.get() });
      }
    }

    class Middle extends Actor<{ message: string; bottom: ActorRef<string> }> {
      override onReceive(c: { message: string; bottom: ActorRef<string> }): void {
        observed.push({ ...LogContext.get() });
        // Tell from inside the handler — this snapshots the
        // re-installed context onto the next envelope.
        c.bottom.tell(c.message);
      }
    }

    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('mdc-chain', sysOptions);
    try {
      const bottom = sys.spawn(Bottom, 'b');
      const middle = sys.spawn(Middle, 'm');
      LogContext.run({ requestId: 'req-9', user: 'u-1' }, () => {
        middle.tell({ message: 'forward', bottom });
      });
      // Two hops, so the wait is for the far end — the near one cannot have
      // been skipped.
      await awaitCondition(() => observed.length === 2, {
        timeoutMs: 4_000,
        label: 'the context reached the bottom actor',
      });
      expect(observed).toEqual([
        { requestId: 'req-9', user: 'u-1' },   // middle saw it
        { requestId: 'req-9', user: 'u-1' },   // bottom saw the same
      ]);
    } finally {
      await sys.terminate();
    }
  });

  test('outside any run(), tells carry no context (defensive default)', async () => {
    // The weak half of the invariant, and worth knowing which half it is: with
    // no `run` open anywhere in the process there is no ambient store to
    // inherit, so this case came back `{}` against the tree that had the #718
    // defect too.  The `settled` message is what keeps it from *also* passing
    // because the delivering turn happened to be the one `spawn` armed —
    // afterwards the cell is idle, so `plain` arms its own turn.  What can
    // actually fail is a context-free tell taken while some *other* store is
    // ambient; that lives in the #718 block below.
    const observed: Array<Record<string, unknown>> = [];
    class R extends Actor<string> {
      override onReceive(): void { observed.push({ ...LogContext.get() }); }
    }
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('mdc-none', sysOptions);
    try {
      const actorRef = sys.spawn(R, 'r');
      actorRef.tell('settled');
      await awaitCondition(() => observed.length === 1, {
        timeoutMs: 4_000,
        label: 'the cell finished the turn its own spawn armed',
      });
      actorRef.tell('plain');
      await awaitCondition(() => observed.length === 2, {
        timeoutMs: 4_000,
        label: 'the receiver handled the context-free message',
      });
      expect(observed).toEqual([{}, {}]);
    } finally {
      await sys.terminate();
    }
  });

  test('an empty-but-not-EMPTY scope still attaches no context (#411)', async () => {
    // `LogContext.run({}, …)` installs a store that is empty yet is not the
    // module's frozen `EMPTY` singleton, and the envelope must keep omitting
    // `context` for it — as it always has, via an `Object.keys` length test.
    //
    // #411 put an identity check in front of that test to avoid allocating a
    // keys array on the overwhelmingly common no-MDC path.  Written as a
    // *replacement* rather than a fast path it would have started attaching
    // `{}` here, which then routes the delivery through
    // `LogContext.run(env.context, …)` — an extra AsyncLocalStorage frame per
    // message, in a change whose whole purpose was to remove per-message work.
    //
    // Frozen-ness is the observable that tells the two apart: a receiver that
    // got no context reads the frozen `EMPTY`, while one wrapped in a
    // user-supplied `{}` reads a plain, extensible object.  Both are `{}` to
    // `toEqual`, which is why the earlier case cannot catch this.
    const frozenness: boolean[] = [];
    class R extends Actor<string> {
      override onReceive(): void { frozenness.push(Object.isFrozen(LogContext.get())); }
    }
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('mdc-empty-scope', sysOptions);
    try {
      const actorRef = sys.spawn(R, 'r');
      LogContext.run({}, () => { actorRef.tell('from-empty-scope'); });
      await awaitCondition(() => frozenness.length === 1, {
        timeoutMs: 4_000,
        label: 'the receiver handled the message sent from an empty scope',
      });
      expect(frozenness).toEqual([true]);
    } finally {
      await sys.terminate();
    }
  });

  test('two parallel tells in different contexts don\'t cross-contaminate', async () => {
    const observed = new Map<string, Record<string, unknown>>();
    class R extends Actor<{ id: string }> {
      override onReceive(m: { id: string }): void {
        observed.set(m.id, { ...LogContext.get() });
      }
    }
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('mdc-parallel', sysOptions);
    try {
      const actorRef = sys.spawn(R, 'r');
      LogContext.run({ branch: 'A' }, () => actorRef.tell({ id: 'a' }));
      LogContext.run({ branch: 'B' }, () => actorRef.tell({ id: 'b' }));
      await awaitCondition(() => observed.size === 2, {
        timeoutMs: 4_000,
        label: 'both messages were handled',
      });
      expect(observed.get('a')).toEqual({ branch: 'A' });
      expect(observed.get('b')).toEqual({ branch: 'B' });
    } finally {
      await sys.terminate();
    }
  });
});

/* ---------------- Deferred work across tenant boundaries (#129) ------------- */

type BufferMessage = { kind: 'buffer'; item: string };
type DrainMessage = { kind: 'drain' };
type CollectorMessage = BufferMessage | DrainMessage;

/** Records the context each item was delivered under. */
class ContextRecordingSink extends Actor<string> {
  constructor(private readonly observed: Map<string, Record<string, unknown>>) { super(); }

  override onReceive(item: string): void {
    this.observed.set(item, { ...LogContext.get() });
  }
}

/**
 * Buffers items and drains them from a promise nobody awaits — the shape
 * the issue describes.  `AsyncLocalStorage` binds a store when the promise
 * is *created*, so the continuation keeps the draining turn's context and
 * `LocalActorRef.tell` stamps it onto every envelope it produces.
 */
class LeakingCollector extends Actor<CollectorMessage> {
  private readonly buffered: string[] = [];

  constructor(private readonly sink: ActorRef<string>) { super(); }

  override onReceive(message: CollectorMessage): void {
    match(message)
      .with({ kind: 'buffer' }, (m) => this.onBuffer(m))
      .with({ kind: 'drain' }, () => this.onDrain())
      .exhaustive();
  }

  private onBuffer(m: BufferMessage): void {
    this.buffered.push(m.item);
  }

  private onDrain(): void {
    void (async () => {
      for (const item of this.buffered.splice(0)) {
        await sleep(1);
        this.sink.tell(item);
      }
    })();
  }
}

/** The same collector, with each item's context captured at enqueue time. */
class IsolatingCollector extends Actor<CollectorMessage> {
  private readonly buffered: Array<LogContextEntry<string>> = [];

  constructor(private readonly sink: ActorRef<string>) { super(); }

  override onReceive(message: CollectorMessage): void {
    match(message)
      .with({ kind: 'buffer' }, (m) => this.onBuffer(m))
      .with({ kind: 'drain' }, () => this.onDrain())
      .exhaustive();
  }

  private onBuffer(m: BufferMessage): void {
    // The enqueueing turn is the only moment this item's own context is
    // still current.
    this.buffered.push({ context: LogContext.get(), item: m.item });
  }

  private onDrain(): void {
    // `.catch`, not `void`: nothing awaits this, so a rejection escaping it is
    // unhandled — fatal by default on Node since v15.  The same shape the
    // logging docs teach since #1063, and the reason they had to change.
    LogContext.runEach(this.buffered.splice(0), async (item) => {
      await sleep(1);
      this.sink.tell(item);
    }).catch((error) => this.log.error('drain failed', error as Error));
  }
}

/** Starts detached background work that must not inherit the turn's context. */
class DetachedWorker extends Actor<string> {
  constructor(private readonly observed: Array<Record<string, unknown>>) { super(); }

  override onReceive(_m: string): void {
    LogContext.runFresh(async () => {
      await sleep(1);
      this.observed.push({ ...LogContext.get() });
    }).catch((error) => this.log.error('detached work failed', error as Error));
  }
}

describe('LogContext — deferred work across tenant boundaries (#129)', () => {
  const quietSystem = (name: string): ActorSystem => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    return ActorSystem.create(name, sysOptions);
  };

  test('an un-awaited drain stamps the draining turn\'s context on every buffered item', async () => {
    const observed = new Map<string, Record<string, unknown>>();
    const sys = quietSystem('mdc-leak');
    try {
      const sink = sys.spawn(() => new ContextRecordingSink(observed), 'sink');
      const collector = sys.spawn(() => new LeakingCollector(sink), 'collector');

      LogContext.run({ tenant: 'acme' }, () => {
        collector.tell({ kind: 'buffer', item: 'invoice-acme' });
      });
      LogContext.run({ tenant: 'globex' }, () => {
        collector.tell({ kind: 'buffer', item: 'invoice-globex' });
      });
      LogContext.run({ tenant: 'initech' }, () => {
        collector.tell({ kind: 'drain' });
      });

      await awaitCondition(() => observed.size === 2, {
        timeoutMs: 4_000,
        label: 'both buffered items reached the sink',
      });
      // This is the defect, pinned so a fix elsewhere cannot land silently:
      // acme's and globex's items both arrive labelled initech.
      expect(observed.get('invoice-acme')).toEqual({ tenant: 'initech' });
      expect(observed.get('invoice-globex')).toEqual({ tenant: 'initech' });
    } finally {
      await sys.terminate();
    }
  });

  test('runEach delivers each buffered item under its own captured context', async () => {
    const observed = new Map<string, Record<string, unknown>>();
    const sys = quietSystem('mdc-runeach');
    try {
      const sink = sys.spawn(() => new ContextRecordingSink(observed), 'sink');
      const collector = sys.spawn(() => new IsolatingCollector(sink), 'collector');

      LogContext.run({ tenant: 'acme' }, () => {
        collector.tell({ kind: 'buffer', item: 'invoice-acme' });
      });
      LogContext.run({ tenant: 'globex' }, () => {
        collector.tell({ kind: 'buffer', item: 'invoice-globex' });
      });
      // Drained by a third tenant's request, as in the leaking case.
      LogContext.run({ tenant: 'initech' }, () => {
        collector.tell({ kind: 'drain' });
      });

      await awaitCondition(() => observed.size === 2, {
        timeoutMs: 4_000,
        label: 'both buffered items reached the sink',
      });
      expect(observed.get('invoice-acme')).toEqual({ tenant: 'acme' });
      expect(observed.get('invoice-globex')).toEqual({ tenant: 'globex' });
    } finally {
      await sys.terminate();
    }
  });

  test('runFresh keeps detached background work from inheriting the turn\'s context', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const sys = quietSystem('mdc-runfresh');
    try {
      const worker = sys.spawn(() => new DetachedWorker(observed), 'worker');
      LogContext.run({ tenant: 'acme', requestId: 'r-1' }, () => {
        worker.tell('start');
      });
      await awaitCondition(() => observed.length === 1, {
        timeoutMs: 4_000,
        label: 'the detached work ran',
      });
      expect(observed).toEqual([{}]);
    } finally {
      await sys.terminate();
    }
  });
});

/* ------- A context-less delivery runs cleared, not ambient (#718) ----------- */

/**
 * What a delivery observed, keyed by the message that caused it.  A tuple
 * rather than a map because several tests need the *order* — the whole point of
 * the batch cases is which envelope shared a turn with which.
 */
type Observation = readonly [message: string, context: Record<string, unknown>];

/** Records the context of every delivery, including framework-sent ones. */
class Recorder extends Actor<string> {
  constructor(private readonly observed: Observation[]) { super(); }

  override onReceive(message: string): void {
    this.observed.push([message, { ...LogContext.get() }]);
  }
}

/**
 * Sets a receive timeout, then reports the context each framework-delivered
 * `ReceiveTimeout` arrives under — and what a `tell` issued from that handler
 * carries downstream, which is the half that leaks forward.
 *
 * The timeout is switched off on the first one so the test asserts about a
 * bounded number of deliveries: `_resetReceiveTimer` re-arms after *every*
 * message, the timeout delivery included, so an actor left alone keeps timing
 * out forever.
 */
class IdleReporter extends Actor<unknown> {
  constructor(
    private readonly observed: Observation[],
    private readonly sink: ActorRef<string>,
  ) { super(); }

  override preStart(): void { this.context.setReceiveTimeout(25); }

  override onReceive(message: unknown): void {
    if (message !== ReceiveTimeout.instance) return;
    this.context.setReceiveTimeout(0);
    this.observed.push(['receive-timeout', { ...LogContext.get() }]);
    this.sink.tell('from-receive-timeout');
  }
}

type StartTimerMessage = { kind: 'startTimer' };
type TickMessage = { kind: 'tick' };
type TimerMessage = StartTimerMessage | TickMessage;

/** Arms a periodic timer from inside a handler, the shape the issue describes. */
class Ticker extends Actor<TimerMessage> {
  constructor(
    private readonly observed: Observation[],
    private readonly sink: ActorRef<string>,
  ) { super(); }

  override onReceive(message: TimerMessage): void {
    match(message)
      .with({ kind: 'startTimer' }, () => this.onStartTimer())
      .with({ kind: 'tick' }, () => this.onTick())
      .exhaustive();
  }

  private onStartTimer(): void {
    this.context.timers.startTimerWithFixedDelay('tick', { kind: 'tick' }, 25, 25);
  }

  private onTick(): void {
    this.context.timers.cancel('tick');
    this.observed.push(['tick', { ...LogContext.get() }]);
    this.sink.tell('from-tick');
  }
}

/** Spawns a child, so the child's lifecycle hooks can report their context. */
class Spawner extends Actor<string> {
  constructor(private readonly observed: Observation[]) { super(); }

  override onReceive(_message: string): void {
    this.context.spawn(() => new LifecycleReporter(this.observed), 'child');
  }
}

class LifecycleReporter extends Actor<string> {
  constructor(private readonly observed: Observation[]) { super(); }

  override preStart(): void {
    this.observed.push(['preStart', { ...LogContext.get() }]);
  }

  override onReceive(_message: string): void {}
}

describe('LogContext — a context-less delivery runs cleared (#718)', () => {
  const quietSystem = (name: string): ActorSystem => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    return ActorSystem.create(name, sysOptions);
  };

  /**
   * Get the cell past the turn its own `spawn` armed.
   *
   * Every one of these tests depends on it.  `enqueueSystem({ kind: 'create' })`
   * runs at spawn time, outside any MDC scope, and up to `throughput` messages
   * ride that same turn — so a test that spawns and tells immediately is
   * delivered under a store that was never poisoned and passes against the
   * broken tree for a reason that has nothing to do with the fix.
   */
  const settle = async (target: ActorRef<string>, observed: Observation[]): Promise<void> => {
    const before = observed.length;
    target.tell('settle');
    await awaitCondition(() => observed.length > before, {
      timeoutMs: 4_000,
      label: 'the cell finished the turn its own spawn armed',
    });
  };

  test('a bare tell sharing a turn with a correlated one is delivered cleared', async () => {
    // No timer and no receive timeout in this one: `schedule()` hands
    // `dispatcher.execute` a callback that captures the *enqueuer's* store, and
    // every envelope in that turn's batch is then dispatched under it.  Two
    // requests arriving close enough together to share a turn, one of which
    // opened an MDC, is all it takes.
    const observed: Observation[] = [];
    const sys = quietSystem('mdc-718-batch');
    try {
      const recorder = sys.spawn(() => new Recorder(observed), 'recorder');
      await settle(recorder, observed);

      LogContext.run({ tenant: 'A', userId: 'alice' }, () => recorder.tell('correlated'));
      // Same turn: the tell above set `processing`, so this one only enqueues.
      recorder.tell('bare');
      await awaitCondition(() => observed.length === 3, {
        timeoutMs: 4_000,
        label: 'both messages of the shared turn were handled',
      });

      expect(observed[1]).toEqual(['correlated', { tenant: 'A', userId: 'alice' }]);
      expect(observed[2]).toEqual(['bare', {}]);
    } finally {
      await sys.terminate();
    }
  });

  test('the leak does not chain across turns while an actor stays busy', async () => {
    // `run()`'s `finally` re-schedules from a continuation created inside the
    // turn, so a poisoned store armed the next tick as well: one correlated
    // message followed by enough bare ones to span three turns came back
    // poisoned in *all* of them, not just the first batch.
    const observed: Observation[] = [];
    const sys = quietSystem('mdc-718-chain');
    try {
      const recorder = sys.spawn(() => new Recorder(observed), 'recorder');
      await settle(recorder, observed);

      LogContext.run({ tenant: 'A' }, () => recorder.tell('correlated'));
      // 34 more, against the default per-actor throughput of 16, so the batch
      // boundary is crossed twice.
      for (let index = 0; index < 34; index++) recorder.tell(`bare-${index}`);
      await awaitCondition(() => observed.length === 36, {
        timeoutMs: 4_000,
        label: 'every message across the three turns was handled',
      });

      const poisoned = observed
        .slice(2)
        .filter(([, context]) => Object.keys(context).length > 0);
      expect(poisoned).toEqual([]);
      expect(observed[1]).toEqual(['correlated', { tenant: 'A' }]);
    } finally {
      await sys.terminate();
    }
  });

  test('the leak does not cross actors sharing a ThroughputDispatcher', async () => {
    // `ThroughputDispatcher.execute` arms one `setImmediate` for the *first*
    // queued unit and then drains several — units belonging to different
    // actors — under that single captured store.  So the second actor's
    // context-free delivery rode the first actor's request.
    const observed: Observation[] = [];
    const sys = quietSystem('mdc-718-cross-actor');
    try {
      const shared = new ThroughputDispatcher(8, 'mdc-718-shared');
      const actorOptions = ActorOptions.create<string>().withDispatcher(shared);
      const first = sys.spawn(() => new Recorder(observed), 'first', actorOptions);
      const second = sys.spawn(() => new Recorder(observed), 'second', actorOptions);
      await settle(first, observed);
      await settle(second, observed);

      LogContext.run({ tenant: 'A' }, () => first.tell('correlated'));
      // Queued behind `first`'s unit on the same drain, so it inherits the
      // store that armed it rather than arming one of its own.
      second.tell('bare');
      await awaitCondition(() => observed.length === 4, {
        timeoutMs: 4_000,
        label: 'both actors handled their message',
      });

      expect(observed[2]).toEqual(['correlated', { tenant: 'A' }]);
      expect(observed[3]).toEqual(['bare', {}]);
    } finally {
      await sys.terminate();
    }
  });

  test('a framework ReceiveTimeout does not carry the last request\'s context', async () => {
    // The half of the finding with no user-side escape hatch: the application
    // never arms this timer, `_resetReceiveTimer` does, after every message.
    const observed: Observation[] = [];
    const sys = quietSystem('mdc-718-receive-timeout');
    try {
      const sink = sys.spawn(() => new Recorder(observed), 'sink');
      const reporter = sys.spawn(() => new IdleReporter(observed, sink), 'reporter');
      LogContext.run({ tenant: 'A', userId: 'alice' }, () => reporter.tell('request'));

      await awaitCondition(
        () => observed.some(([message]) => message === 'from-receive-timeout'),
        { timeoutMs: 4_000, label: 'the timeout fired and its downstream tell arrived' },
      );

      const byMessage = new Map<string, Record<string, unknown>>(observed);
      expect(byMessage.get('receive-timeout')).toEqual({});
      expect(byMessage.get('from-receive-timeout')).toEqual({});
    } finally {
      await sys.terminate();
    }
  });

  test('a periodic timer tick does not carry the arming request\'s context', async () => {
    // Armed by user code through `context.timers`, but delivered by the system
    // scheduler — so the clear belongs to the scheduler, which is where a tick
    // stops belonging to the request that armed it.
    const observed: Observation[] = [];
    const sys = quietSystem('mdc-718-timer');
    try {
      const sink = sys.spawn(() => new Recorder(observed), 'sink');
      const ticker = sys.spawn(() => new Ticker(observed, sink), 'ticker');
      LogContext.run({ tenant: 'A', userId: 'alice' }, () => ticker.tell({ kind: 'startTimer' }));

      await awaitCondition(
        () => observed.some(([message]) => message === 'from-tick'),
        { timeoutMs: 4_000, label: 'the tick fired and its downstream tell arrived' },
      );

      const byMessage = new Map<string, Record<string, unknown>>(observed);
      expect(byMessage.get('tick')).toEqual({});
      expect(byMessage.get('from-tick')).toEqual({});
    } finally {
      await sys.terminate();
    }
  });

  test('a scheduled bare function does not run under the arming request\'s context', async () => {
    // `scheduleOnceFunction` / `scheduleAtFixedRateFunction` never pass through
    // an `ActorCell` at all, so a fix on the delivery side alone would leave
    // this one leaking.
    const observed: Observation[] = [];
    const sys = quietSystem('mdc-718-scheduled-function');
    try {
      LogContext.run({ tenant: 'A', userId: 'alice' }, () => {
        sys.scheduler.scheduleOnceFunction(10, () => {
          observed.push(['scheduled-function', { ...LogContext.get() }]);
        });
      });
      await awaitCondition(() => observed.length === 1, {
        timeoutMs: 4_000,
        label: 'the scheduled function ran',
      });
      expect(observed).toEqual([['scheduled-function', {}]]);
    } finally {
      await sys.terminate();
    }
  });

  test('the manual scheduler clears the context the same way the real one does', () => {
    // No system and no `await`: `ManualScheduler` overrides all four scheduling
    // methods and never reaches `Scheduler`'s internals, so the fix does not
    // reach it by inheritance.  A double that kept the old behaviour would let
    // every ManualScheduler-driven suite pass over a reintroduced leak.
    //
    // `advance` is driven from a *second* scope on purpose: the task closure is
    // a plain function, not an async resource, so it captures nothing at arm
    // time — what it would otherwise observe is the store of whoever made time
    // move, which is the same defect one layer up.
    const scheduler = new ManualScheduler();
    const observed: Observation[] = [];
    LogContext.run({ tenant: 'A' }, () => {
      scheduler.scheduleOnceFunction(10, () => {
        observed.push(['manual-scheduled-function', { ...LogContext.get() }]);
      });
    });
    LogContext.run({ tenant: 'B' }, () => scheduler.advance(10));
    expect(observed).toEqual([['manual-scheduled-function', {}]]);
  });

  test('a child spawned inside a request starts with no inherited context', async () => {
    // The deliberate consequence of clearing per *turn*: `create` is a system
    // command, so `preStart` now runs cleared rather than under whichever
    // request happened to spawn the actor.  Recorded here because it is a
    // behaviour change, not a side effect nobody chose — a child's lifecycle
    // does not belong to one request, and a `tell` from `preStart` used to
    // carry that request's identifiers to whoever it reached.
    const observed: Observation[] = [];
    const sys = quietSystem('mdc-718-lifecycle');
    try {
      const spawner = sys.spawn(() => new Spawner(observed), 'spawner');
      LogContext.run({ tenant: 'A', userId: 'alice' }, () => spawner.tell('spawn-a-child'));
      await awaitCondition(
        () => observed.some(([message]) => message === 'preStart'),
        { timeoutMs: 4_000, label: 'the child started' },
      );
      expect(observed.find(([message]) => message === 'preStart')).toEqual(['preStart', {}]);
    } finally {
      await sys.terminate();
    }
  });
});
