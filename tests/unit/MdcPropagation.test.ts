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
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { LogContext } from '../../src/LogContext.js';
// From the barrel, not the module: this is the shape an application has to be
// able to name, and only `src/index.ts` says whether it can (#1062).
import type { LogContextEntry } from '../../src/index.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
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
      actorRef.tell('plain');
      await awaitCondition(() => observed.length === 1, {
        timeoutMs: 4_000,
        label: 'the receiver handled the context-free message',
      });
      expect(observed).toEqual([{}]);
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
