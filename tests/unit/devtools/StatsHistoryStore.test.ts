import { describe, expect, test } from 'bun:test';
import {
  HISTORY_MAXIMUM_SPAN_MS,
  StatsHistoryStore,
} from '../../../src/devtools/internal/StatsHistoryStore.js';
import { statsSamplePayload } from '../../../src/devtools/protocol/index.js';
import type { StatsSamplePayload } from '../../../src/devtools/protocol/index.js';

function sample(atMs: number, fields: Partial<StatsSamplePayload> = {}): StatsSamplePayload {
  return statsSamplePayload({
    atMs,
    uptimeMs: atMs,
    runtime: 'bun',
    actorCount: 0,
    actorsStarted: 0,
    actorsStopped: 0,
    actorsRestarted: 0,
    deadLetters: 0,
    messagesProcessed: 0,
    mailboxDrops: 0,
    mailboxBacklog: 0,
    stashedTotal: 0,
    suspendedActors: 0,
    topMailboxes: [],
    nodes: [],
    ...fields,
  });
}

describe('StatsHistoryStore — resolution', () => {
  test('a short span is answered at one second', () => {
    const store = new StatsHistoryStore();
    for (let i = 1; i <= 5; i++) store.record(sample(i * 1_000, { actorCount: i }));

    const result = store.query(60_000, 5_000);
    expect(result.resolutionMs).toBe(1_000);
    expect(result.points.map((point) => point.actorCount)).toEqual([1, 2, 3, 4, 5]);
  });

  test('a day is answered coarsely — the fine tier does not reach that far', () => {
    const store = new StatsHistoryStore();
    for (let i = 1; i <= 5; i++) store.record(sample(i * 1_000));
    // Eighty-six thousand one-second points is neither sendable nor
    // readable, so the query drops to the tier that covers the span.
    expect(store.query(86_400_000, 5_000).resolutionMs).toBe(120_000);
  });

  test('a span beyond what is kept is clamped rather than refused', () => {
    const store = new StatsHistoryStore();
    store.record(sample(1_000));
    expect(store.query(HISTORY_MAXIMUM_SPAN_MS * 10, 1_000).points).toHaveLength(1);
  });
});

describe('StatsHistoryStore — summarising', () => {
  test('a level keeps the interval peak, so a spike survives', () => {
    const store = new StatsHistoryStore();
    // Three samples inside one 15-second bucket, with a spike in the
    // middle.  Averaging would erase exactly what the chart is for.
    store.record(sample(1_000, { mailboxBacklog: 2 }));
    store.record(sample(5_000, { mailboxBacklog: 90 }));
    store.record(sample(9_000, { mailboxBacklog: 3 }));

    const coarse = store.query(3_600_000, 9_000);
    expect(coarse.resolutionMs).toBe(15_000);
    expect(coarse.points).toHaveLength(1);
    expect(coarse.points[0]!.mailboxBacklog).toBe(90);
  });

  test('a counter keeps the interval end, so rates stay right', () => {
    const store = new StatsHistoryStore();
    store.record(sample(1_000, { messagesProcessed: 10 }));
    store.record(sample(9_000, { messagesProcessed: 40 }));
    store.record(sample(20_000, { messagesProcessed: 100 }));

    const coarse = store.query(3_600_000, 20_000);
    // Cumulative counters are differenced by the client; keeping the
    // maximum would work too, but keeping the last is what makes the
    // difference across two buckets the real count.
    expect(coarse.points.map((point) => point.messagesProcessed)).toEqual([40, 100]);
  });

  test('the interval still being filled is included', () => {
    const store = new StatsHistoryStore();
    store.record(sample(1_000, { actorCount: 7 }));
    // Nothing has closed a 15-second bucket yet, but the newest reading
    // is still the most useful thing there is.
    expect(store.query(3_600_000, 1_000).points.map((p) => p.actorCount)).toEqual([7]);
  });

  test('points older than the span are left out', () => {
    const store = new StatsHistoryStore();
    for (let i = 1; i <= 10; i++) store.record(sample(i * 1_000, { actorCount: i }));
    const result = store.query(4_000, 10_000);
    expect(result.points.map((point) => point.actorCount)).toEqual([6, 7, 8, 9, 10]);
  });
});
