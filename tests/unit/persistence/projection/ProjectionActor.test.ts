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
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { InMemoryJournal } from '../../../../src/persistence/journals/InMemoryJournal.js';
import { ProjectionActor } from '../../../../src/persistence/projection/ProjectionActor.js';
import {
  DurableStateOffsetStore,
  InMemoryOffsetStore,
} from '../../../../src/persistence/projection/OffsetStore.js';
import { InMemoryQuery } from '../../../../src/persistence/query/InMemoryQuery.js';
import { offsetStart } from '../../../../src/persistence/query/PersistenceQuery.js';
import { InMemoryDurableStateStore } from '../../../../src/persistence/durable-state-stores/InMemoryDurableStateStore.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

function newSystem(name: string): ActorSystem {
  return ActorSystem.create(name, { logger: new NoopLogger(), logLevel: LogLevel.Off });
}

async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('ProjectionActor — by persistence id', () => {
  test('round-trip: every appended event reaches the handler in order', async () => {
    const journal = new InMemoryJournal();
    await journal.append('alice', [{ n: 1 }, { n: 2 }, { n: 3 }], 0);

    const seen: number[] = [];
    const sys = newSystem('proj-rt');
    const ref = ProjectionActor.byPersistenceId<{ n: number }>(sys, {
      name: 'sum',
      query: new InMemoryQuery(journal),
      persistenceId: 'alice',
      handle: (ev) => { seen.push(ev.event.n); },
      liveOptions: { pollIntervalMs: 30 },
    });

    await waitFor(() => seen.length === 3);

    // Append more after the projection is running — pull-model must catch them.
    await journal.append('alice', [{ n: 4 }, { n: 5 }], 3);
    await waitFor(() => seen.length === 5);

    expect(seen).toEqual([1, 2, 3, 4, 5]);

    ref.stop();
    await sys.terminate();
  });

  test('restart-from-offset: a fresh projection resumes where the old one left off', async () => {
    const journal = new InMemoryJournal();
    const offsetStore = new InMemoryOffsetStore();
    const query = new InMemoryQuery(journal);
    await journal.append('counter', [{ n: 1 }, { n: 2 }, { n: 3 }], 0);

    // First instance — process events, then stop.
    const sys1 = newSystem('proj-resume-1');
    const seen1: number[] = [];
    const ref1 = ProjectionActor.byPersistenceId<{ n: number }>(sys1, {
      name: 'counter-proj',
      query,
      offsetStore,
      persistenceId: 'counter',
      handle: (ev) => { seen1.push(ev.event.n); },
      liveOptions: { pollIntervalMs: 30 },
    });
    await waitFor(() => seen1.length === 3);
    ref1.stop();
    await sleep(80);   // give postStop time to flush

    // Append fresh events while no projection is running.
    await journal.append('counter', [{ n: 4 }, { n: 5 }], 3);

    // Second instance — same projection name + same offsetStore.
    const sys2 = newSystem('proj-resume-2');
    const seen2: number[] = [];
    const ref2 = ProjectionActor.byPersistenceId<{ n: number }>(sys2, {
      name: 'counter-proj',
      query,
      offsetStore,
      persistenceId: 'counter',
      handle: (ev) => { seen2.push(ev.event.n); },
      liveOptions: { pollIntervalMs: 30 },
    });
    await waitFor(() => seen2.length === 2);

    expect(seen2).toEqual([4, 5]);   // NOT [1, 2, 3, 4, 5]

    ref2.stop();
    await sys1.terminate();
    await sys2.terminate();
  });

  test('idempotency: at-least-once delivery survives a handler that intentionally fails the first time', async () => {
    const journal = new InMemoryJournal();
    const offsetStore = new InMemoryOffsetStore();
    await journal.append('flaky', [{ n: 1 }, { n: 2 }, { n: 3 }], 0);

    let firstAttemptThrowOnce = true;
    const seen: number[] = [];
    const sys = newSystem('proj-idem');
    const ref = ProjectionActor.byPersistenceId<{ n: number }>(sys, {
      name: 'flaky-proj',
      query: new InMemoryQuery(journal),
      offsetStore,
      persistenceId: 'flaky',
      handle: (ev) => {
        if (ev.event.n === 2 && firstAttemptThrowOnce) {
          firstAttemptThrowOnce = false;
          throw new Error('simulated transient failure on n=2');
        }
        seen.push(ev.event.n);
      },
      liveOptions: { pollIntervalMs: 30 },
    });

    // n=1 lands; n=2 throws → cursor stays at 1; n=2 retried; n=3 lands.
    // Handler is called twice for n=2 — that's the at-least-once contract.
    await waitFor(() => seen.length === 3);
    expect(seen).toEqual([1, 2, 3]);

    ref.stop();
    await sys.terminate();
  });
});

describe('ProjectionActor — by tag', () => {
  test('only events tagged with the projection tag are delivered', async () => {
    const journal = new InMemoryJournal();
    // Mix of tags across two pids.
    await journal.append('a', [{ s: 'a1' }], 0, ['orders']);
    await sleep(2);
    await journal.append('b', [{ s: 'b1' }], 0, ['orders', 'vip']);
    await sleep(2);
    await journal.append('a', [{ s: 'a2' }], 1, ['internal']);
    await sleep(2);
    await journal.append('b', [{ s: 'b2' }], 1, ['orders']);

    const sys = newSystem('proj-tag');
    const seen: string[] = [];
    const ref = ProjectionActor.byTag<{ s: string }>(sys, {
      name: 'orders-proj',
      query: new InMemoryQuery(journal),
      tag: 'orders',
      handle: (ev) => { seen.push(ev.event.s); },
      liveOptions: { pollIntervalMs: 30 },
    });

    await waitFor(() => seen.length === 3);
    expect(seen).toEqual(['a1', 'b1', 'b2']);

    ref.stop();
    await sys.terminate();
  });

  test('survives restart with DurableStateOffsetStore — no event re-replay', async () => {
    const journal = new InMemoryJournal();
    const offsetStore = new DurableStateOffsetStore(new InMemoryDurableStateStore());

    await journal.append('a', [{ s: 'a1' }], 0, ['t']);
    await sleep(2);
    await journal.append('b', [{ s: 'b1' }], 0, ['t']);

    const sys1 = newSystem('proj-tag-resume-1');
    const seen1: string[] = [];
    const ref1 = ProjectionActor.byTag<{ s: string }>(sys1, {
      name: 'tag-resume',
      query: new InMemoryQuery(journal),
      offsetStore,
      tag: 't',
      handle: (ev) => { seen1.push(ev.event.s); },
      liveOptions: { pollIntervalMs: 30 },
    });
    await waitFor(() => seen1.length === 2);
    ref1.stop();
    await sleep(80);
    await sys1.terminate();

    // While the projection is down, append more.
    await sleep(2);
    await journal.append('a', [{ s: 'a2' }], 1, ['t']);

    // Restart the projection — should NOT replay a1/b1.
    const sys2 = newSystem('proj-tag-resume-2');
    const seen2: string[] = [];
    const ref2 = ProjectionActor.byTag<{ s: string }>(sys2, {
      name: 'tag-resume',
      query: new InMemoryQuery(journal),
      offsetStore,
      tag: 't',
      handle: (ev) => { seen2.push(ev.event.s); },
      liveOptions: { pollIntervalMs: 30 },
    });
    await waitFor(() => seen2.length === 1);
    expect(seen2).toEqual(['a2']);

    ref2.stop();
    await sys2.terminate();
  });

  test('explicit offsetStart cursor replays from the beginning', async () => {
    const journal = new InMemoryJournal();
    await journal.append('a', [{ s: 'a1' }, { s: 'a2' }], 0, ['t']);

    const offsetStore = new InMemoryOffsetStore();
    // Pre-seed the cursor so the projection thinks it's already past a1.
    // We store offsetStart, which means "from the beginning".
    await offsetStore.saveOffset('replay-proj', 't', offsetStart);

    const sys = newSystem('proj-replay');
    const seen: string[] = [];
    const ref = ProjectionActor.byTag<{ s: string }>(sys, {
      name: 'replay-proj',
      query: new InMemoryQuery(journal),
      offsetStore,
      tag: 't',
      handle: (ev) => { seen.push(ev.event.s); },
      liveOptions: { pollIntervalMs: 30 },
    });
    await waitFor(() => seen.length === 2);
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
    const ref = ProjectionActor.byTag<{ pid: string; n: number }>(sys, {
      name: 'concurrent-proj',
      query: new InMemoryQuery(journal),
      tag: 'shared',
      handle: (ev) => { seen.push(`${ev.persistenceId}:${ev.event.n}`); },
      liveOptions: { pollIntervalMs: 20 },
    });

    // Two concurrent writer loops.
    const target = 5;
    const writers = ['w1', 'w2'].map(async (pid) => {
      for (let i = 1; i <= target; i++) {
        await journal.append(pid, [{ pid, n: i }], i - 1, ['shared']);
        await sleep(5);
      }
    });
    await Promise.all(writers);

    await waitFor(() => seen.length === target * 2, 5_000);

    // Every event from both writers must show up — order across pids
    // is not strictly defined (timestamp + pid tiebreaker), so we
    // only assert membership.
    const set = new Set(seen);
    expect(set.size).toBe(target * 2);
    for (const pid of ['w1', 'w2']) {
      for (let i = 1; i <= target; i++) {
        expect(set.has(`${pid}:${i}`)).toBe(true);
      }
    }

    ref.stop();
    await sys.terminate();
  });
});
