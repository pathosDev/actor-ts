/**
 * ProjectionActor — at-least-once event delivery + offset persistence.
 *
 * Required by the verification block in issue #36:
 *   - round-trip: every appended event reaches the handler.
 *   - tag filter: by-tag projection only sees its tag's events.
 *   - restart-from-offset: a fresh projection picks up exactly where
 *     the previous instance left off.
 *   - idempotency: handler is allowed to be called twice for the
 *     same event (at-least-once contract).  The DurableState-backed
 *     offset store survives a restart so we can verify resumption.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { ProjectionActor } from '../../../../../src/persistence/projection/ProjectionActor.js';
import {
  ByPersistenceIdProjectionOptions,
  ByTagProjectionOptions,
} from '../../../../../src/persistence/projection/ProjectionOptions.js';
import {
  DurableStateOffsetStore,
  InMemoryOffsetStore,
} from '../../../../../src/persistence/projection/OffsetStore.js';
import { InMemoryQuery } from '../../../../../src/persistence/query/InMemoryQuery.js';
import { tagFilterCursorKey } from '../../../../../src/persistence/query/PersistenceQuery.js';
import { offsetGreater, offsetStart } from '../../../../../src/persistence/query/PersistenceQuery.js';
import { InMemoryDurableStateStore } from '../../../../../src/persistence/durable-state-stores/InMemoryDurableStateStore.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

/**
 * Push the wall clock past the current millisecond, so the next append lands on
 * a strictly greater offset timestamp.
 *
 * The elapsed time *is* the fixture in every by-tag test below: a projection
 * cursor is an `Offset`, which orders by millisecond timestamp, so two appends
 * inside one millisecond tie on the first key and the delivery order the test
 * asserts is no longer defined.  Nothing to poll for — the clock is the only
 * thing being waited on (#418).
 */
const separateOffsetTimestamps = (): Promise<void> => sleep(2);

function newSystem(name: string): ActorSystem {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
}

describe('ProjectionActor — by persistence id', () => {
  test('round-trip: every appended event reaches the handler in order', async () => {
    const journal = new InMemoryJournal();
    await journal.append('alice', [{ event: { n: 1 } }, { event: { n: 2 } }, { event: { n: 3 } }], 0);

    const seen: number[] = [];
    const sys = newSystem('proj-rt');
    const projectionOptions = ByPersistenceIdProjectionOptions.create<{ n: number }>()
      .withName('sum')
      .withQuery(new InMemoryQuery(journal))
      .withPersistenceId('alice')
      .withHandle((ev) => { seen.push(ev.event.n); })
      .withLiveOptions({ pollIntervalMs: 30 });
    const ref = ProjectionActor.byPersistenceId<{ n: number }>(sys, projectionOptions);

    await awaitCondition(() => seen.length >= 3, {
      timeoutMs: 4_000,
      label: 'the three pre-existing events reached the handler',
    });

    // Append more after the projection is running — pull-model must catch them.
    // Waiting on the drain above is what makes this the live path rather than
    // one batch of five.
    await journal.append('alice', [{ event: { n: 4 } }, { event: { n: 5 } }], 3);
    await awaitCondition(() => seen.length >= 5, {
      timeoutMs: 4_000,
      label: 'the two live appends reached the handler',
    });

    expect(seen).toEqual([1, 2, 3, 4, 5]);

    ref.stop();
    await sys.terminate();
  });

  test('restart-from-offset: a fresh projection resumes where the old one left off', async () => {
    const journal = new InMemoryJournal();
    const offsetStore = new InMemoryOffsetStore();
    const query = new InMemoryQuery(journal);
    await journal.append('counter', [{ event: { n: 1 } }, { event: { n: 2 } }, { event: { n: 3 } }], 0);

    // First instance — process events, then stop.
    const sys1 = newSystem('proj-resume-1');
    const seen1: number[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<{ n: number }>()
      .withName('counter-proj')
      .withQuery(query)
      .withOffsetStore(offsetStore)
      .withPersistenceId('counter')
      .withHandle((ev) => { seen1.push(ev.event.n); })
      .withLiveOptions({ pollIntervalMs: 30 });
    const ref1 = ProjectionActor.byPersistenceId<{ n: number }>(sys1, projectionOptions);
    await awaitCondition(() => seen1.length >= 3, {
      timeoutMs: 4_000,
      label: 'the first instance projected all three events',
    });
    ref1.stop();
    // The resumption below is only meaningful once the cursor is durable —
    // that, not a wall-clock margin, is what the 80 ms stood for (#418).
    await awaitCondition(
      async () => (await offsetStore.loadSequence('counter-proj', 'counter')) === 3,
      { timeoutMs: 4_000, label: 'the by-pid cursor was persisted at sequence 3' },
    );

    // Append fresh events while no projection is running.
    await journal.append('counter', [{ event: { n: 4 } }, { event: { n: 5 } }], 3);

    // Second instance — same projection name + same offsetStore.
    const sys2 = newSystem('proj-resume-2');
    const seen2: number[] = [];
    const projection2Options = ByPersistenceIdProjectionOptions.create<{ n: number }>()
      .withName('counter-proj')
      .withQuery(query)
      .withOffsetStore(offsetStore)
      .withPersistenceId('counter')
      .withHandle((ev) => { seen2.push(ev.event.n); })
      .withLiveOptions({ pollIntervalMs: 30 });
    const ref2 = ProjectionActor.byPersistenceId<{ n: number }>(sys2, projection2Options);
    await awaitCondition(() => seen2.length >= 2, {
      timeoutMs: 4_000,
      label: 'the second instance projected the two events appended while it was down',
    });

    expect(seen2).toEqual([4, 5]);   // NOT [1, 2, 3, 4, 5]

    ref2.stop();
    await sys1.terminate();
    await sys2.terminate();
  });

  test('default recovery strategy: a transient handler failure is retried and the projection carries on', async () => {
    const journal = new InMemoryJournal();
    const offsetStore = new InMemoryOffsetStore();
    await journal.append('flaky', [{ event: { n: 1 } }, { event: { n: 2 } }, { event: { n: 3 } }], 0);

    let firstAttemptThrowOnce = true;
    const seen: number[] = [];
    const sys = newSystem('proj-idem');
    const projectionOptions = ByPersistenceIdProjectionOptions.create<{ n: number }>()
      .withName('flaky-proj')
      .withQuery(new InMemoryQuery(journal))
      .withOffsetStore(offsetStore)
      .withPersistenceId('flaky')
      .withRetryBackoffMs(30)
      .withHandle((ev) => {
        if (ev.event.n === 2 && firstAttemptThrowOnce) {
          firstAttemptThrowOnce = false;
          throw new Error('simulated transient failure on n=2');
        }
        seen.push(ev.event.n);
      })
      .withLiveOptions({ pollIntervalMs: 30 });
    const ref = ProjectionActor.byPersistenceId<{ n: number }>(sys, projectionOptions);

    // No `withRecoveryStrategy`, so this is the built-in `retry-and-fail`
    // with three retries — NOT the retry-forever loop this test used to
    // assert (#650).  n=1 lands; n=2 throws → the cursor stays at 1 and the
    // next tick is deferred by `retryBackoffMs` rather than by the poll
    // interval; n=2 is retried and succeeds; n=3 lands.  The handler is
    // called twice for n=2 — still the at-least-once contract, and still why
    // handlers have to be idempotent.
    //
    // What changed is the tail: a handler that kept throwing would now be
    // retried three times and the projection stopped, instead of blocking
    // n=3 for the life of the process.  Every strategy's behaviour is
    // covered in tests/unit/persistence/ProjectionFailureStrategy.test.ts.
    await awaitCondition(() => seen.length >= 3, {
      timeoutMs: 4_000,
      label: 'n=2 was retried and n=3 followed it',
    });
    expect(seen).toEqual([1, 2, 3]);

    ref.stop();
    await sys.terminate();
  });
});

describe('ProjectionActor — by tag', () => {
  test('only events tagged with the projection tag are delivered', async () => {
    const journal = new InMemoryJournal();
    // Mix of tags across two pids.
    await journal.append('a', [{ event: { s: 'a1' }, tags: ['orders'] }], 0);
    await separateOffsetTimestamps();
    await journal.append('b', [{ event: { s: 'b1' }, tags: ['orders', 'vip'] }], 0);
    await separateOffsetTimestamps();
    await journal.append('a', [{ event: { s: 'a2' }, tags: ['internal'] }], 1);
    await separateOffsetTimestamps();
    await journal.append('b', [{ event: { s: 'b2' }, tags: ['orders'] }], 1);

    const sys = newSystem('proj-tag');
    const seen: string[] = [];
    const projectionOptions = ByTagProjectionOptions.create<{ s: string }>()
      .withName('orders-proj')
      .withQuery(new InMemoryQuery(journal))
      .withTag('orders')
      .withHandle((ev) => { seen.push(ev.event.s); })
      .withLiveOptions({ pollIntervalMs: 30 });
    const ref = ProjectionActor.byTag<{ s: string }>(sys, projectionOptions);

    await awaitCondition(() => seen.length >= 3, {
      timeoutMs: 4_000,
      label: "the three 'orders' events reached the handler",
    });
    expect(seen).toEqual(['a1', 'b1', 'b2']);

    ref.stop();
    await sys.terminate();
  });

  test('survives restart with DurableStateOffsetStore — no event re-replay', async () => {
    const journal = new InMemoryJournal();
    const offsetStore = new DurableStateOffsetStore(new InMemoryDurableStateStore());

    await journal.append('a', [{ event: { s: 'a1' }, tags: ['t'] }], 0);
    await separateOffsetTimestamps();
    await journal.append('b', [{ event: { s: 'b1' }, tags: ['t'] }], 0);

    const sys1 = newSystem('proj-tag-resume-1');
    const seen1: string[] = [];
    const projectionOptions = ByTagProjectionOptions.create<{ s: string }>()
      .withName('tag-resume')
      .withQuery(new InMemoryQuery(journal))
      .withOffsetStore(offsetStore)
      .withTag('t')
      .withHandle((ev) => { seen1.push(ev.event.s); })
      .withLiveOptions({ pollIntervalMs: 30 });
    const ref1 = ProjectionActor.byTag<{ s: string }>(sys1, projectionOptions);
    await awaitCondition(() => seen1.length >= 2, {
      timeoutMs: 4_000,
      label: 'the first instance projected both tagged events',
    });
    ref1.stop();
    await awaitCondition(
      async () => offsetGreater(await offsetStore.loadOffset('tag-resume', 't'), offsetStart),
      { timeoutMs: 4_000, label: 'the by-tag cursor advanced past the start sentinel' },
    );
    await sys1.terminate();

    // While the projection is down, append more.
    await separateOffsetTimestamps();
    await journal.append('a', [{ event: { s: 'a2' }, tags: ['t'] }], 1);

    // Restart the projection — should NOT replay a1/b1.
    const sys2 = newSystem('proj-tag-resume-2');
    const seen2: string[] = [];
    const projection2Options = ByTagProjectionOptions.create<{ s: string }>()
      .withName('tag-resume')
      .withQuery(new InMemoryQuery(journal))
      .withOffsetStore(offsetStore)
      .withTag('t')
      .withHandle((ev) => { seen2.push(ev.event.s); })
      .withLiveOptions({ pollIntervalMs: 30 });
    const ref2 = ProjectionActor.byTag<{ s: string }>(sys2, projection2Options);
    await awaitCondition(() => seen2.length >= 1, {
      timeoutMs: 4_000,
      label: 'the restarted projection delivered something',
    });
    expect(seen2).toEqual(['a2']);

    ref2.stop();
    await sys2.terminate();
  });

  test('explicit offsetStart cursor replays from the beginning', async () => {
    const journal = new InMemoryJournal();
    await journal.append('a', [{ event: { s: 'a1' }, tags: ['t'] }, { event: { s: 'a2' }, tags: ['t'] }], 0);

    const offsetStore = new InMemoryOffsetStore();
    // Pre-seed the cursor so the projection thinks it's already past a1.
    // We store offsetStart, which means "from the beginning".
    await offsetStore.saveOffset('replay-proj', 't', offsetStart);

    const sys = newSystem('proj-replay');
    const seen: string[] = [];
    const projectionOptions = ByTagProjectionOptions.create<{ s: string }>()
      .withName('replay-proj')
      .withQuery(new InMemoryQuery(journal))
      .withOffsetStore(offsetStore)
      .withTag('t')
      .withHandle((ev) => { seen.push(ev.event.s); })
      .withLiveOptions({ pollIntervalMs: 30 });
    const ref = ProjectionActor.byTag<{ s: string }>(sys, projectionOptions);
    await awaitCondition(() => seen.length >= 2, {
      timeoutMs: 4_000,
      label: 'the offsetStart cursor replayed both events',
    });
    expect(seen).toEqual(['a1', 'a2']);

    ref.stop();
    await sys.terminate();
  });
});

describe('ProjectionActor — concurrent writers', () => {
  test('two pids being written concurrently both reach the projection without deadlock', async () => {
    const journal = new InMemoryJournal();
    const seen: string[] = [];
    const sys = newSystem('proj-concurrent');

    // We project by tag so a single projection sees both pids.
    const projectionOptions = ByTagProjectionOptions.create<{ persistenceId: string; n: number }>()
      .withName('concurrent-proj')
      .withQuery(new InMemoryQuery(journal))
      .withTag('shared')
      .withHandle((ev) => { seen.push(`${ev.persistenceId}:${ev.event.n}`); })
      .withLiveOptions({ pollIntervalMs: 20 });
    const ref = ProjectionActor.byTag<{ persistenceId: string; n: number }>(sys, projectionOptions);

    // Two concurrent writer loops.
    const target = 5;
    const writers = ['w1', 'w2'].map(async (persistenceId) => {
      for (let i = 1; i <= target; i++) {
        await journal.append(persistenceId, [{ event: { persistenceId, n: i }, tags: ['shared'] }], i - 1);
        // Both the interleaving and the offset separation this test needs: the
        // two writer loops hand off to each other here, and each append lands
        // on its own millisecond so the projection sees a defined order.
        await sleep(5);
      }
    });
    await Promise.all(writers);

    await awaitCondition(() => seen.length >= target * 2, {
      timeoutMs: 4_000,
      label: 'every event from both concurrent writers reached the projection',
    });

    // Every event from both writers must show up — order across pids
    // is not strictly defined (timestamp + pid tiebreaker), so we
    // only assert membership.
    const set = new Set(seen);
    expect(set.size).toBe(target * 2);
    for (const persistenceId of ['w1', 'w2']) {
      for (let i = 1; i <= target; i++) {
        expect(set.has(`${persistenceId}:${i}`)).toBe(true);
      }
    }

    ref.stop();
    await sys.terminate();
  });
});

describe('byTag projection — TagFilter support (#393)', () => {
  test('a filter object selects events, not just a single tag', () => {
    // The query layer has supported all/any/not since it was written; a
    // projection was the one consumer still limited to one tag string, so
    // "every order that is not cancelled" needed a hand-rolled projection.
    expect(tagFilterCursorKey({ all: ['orders'], not: ['cancelled'] })).toBe('all(orders)+not(cancelled)');
  });

  test('a bare string keeps its exact cursor key', async () => {
    // The load-bearing property.  The by-tag projection uses this as its
    // OffsetStore key, so any other mapping for a plain string would orphan
    // every cursor already persisted and silently replay each deployed
    // projection from the beginning.
    expect(tagFilterCursorKey('orders')).toBe('orders');
    expect(tagFilterCursorKey('')).toBe('');
  });

  test('equivalent filters share one cursor key regardless of how they are written', () => {
    expect(tagFilterCursorKey({ all: ['b', 'a'] })).toBe(tagFilterCursorKey({ all: ['a', 'b'] }));
    expect(tagFilterCursorKey({ any: ['x'], all: ['y'] })).toBe(tagFilterCursorKey({ all: ['y'], any: ['x'] }));
  });

  test('distinct filters get distinct cursor keys', () => {
    const keys = new Set([
      tagFilterCursorKey('orders'),
      tagFilterCursorKey({ all: ['orders'] }),
      tagFilterCursorKey({ any: ['orders'] }),
      tagFilterCursorKey({ all: ['orders'], not: ['cancelled'] }),
      tagFilterCursorKey({}),
    ]);
    expect(keys.size).toBe(5);
  });

  test('the match-everything filter gets a name rather than an empty key', () => {
    // An empty key would collide with a projection whose tag is the empty string.
    expect(tagFilterCursorKey({})).toBe('all-events');
    expect(tagFilterCursorKey({})).not.toBe(tagFilterCursorKey(''));
  });

  test('a not-filter projection skips the excluded events end to end', async () => {
    const journal = new InMemoryJournal();
    await journal.append('a', [{ event: { s: 'kept' }, tags: ['orders'] }], 0);
    await separateOffsetTimestamps();
    await journal.append('b', [{ event: { s: 'dropped' }, tags: ['orders', 'cancelled'] }], 0);
    await separateOffsetTimestamps();
    await journal.append('c', [{ event: { s: 'kept-2' }, tags: ['orders'] }], 0);

    const sys = newSystem('proj-tag-filter');
    const seen: string[] = [];
    const projectionOptions = ByTagProjectionOptions.create<{ s: string }>()
      .withName('tag-filter')
      .withQuery(new InMemoryQuery(journal))
      .withTag({ all: ['orders'], not: ['cancelled'] })
      .withHandle((ev) => { seen.push(ev.event.s); })
      .withLiveOptions({ pollIntervalMs: 30 });
    const ref = ProjectionActor.byTag<{ s: string }>(sys, projectionOptions);

    await awaitCondition(() => seen.length >= 2, {
      timeoutMs: 4_000,
      label: 'both kept events reached the handler',
    });
    expect(seen).toEqual(['kept', 'kept-2']);

    ref.stop();
    await sys.terminate();
  });
});
