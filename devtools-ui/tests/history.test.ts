import { describe, expect, test } from 'bun:test';
import { StatsHistory, peakOf } from '../src/core/history.js';
import { projectPoints } from '../src/render/timeseries.js';
import type {
  StatsHistoryPoint,
  StatsSamplePayload,
} from '../../src/devtools/protocol/index.js';

/** Long enough that these cases only ever hit the count backstop. */
const HOUR_MS = 3_600_000;

/** Build a sample with only the fields the maths reads. */
function sample(atMs: number, fields: Partial<StatsSamplePayload> = {}): StatsSamplePayload {
  return {
    kind: 'stats-sample',
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
  };
}

describe('StatsHistory', () => {
  test('keeps only the most recent samples', () => {
    const history = new StatsHistory(3, HOUR_MS);
    for (let i = 1; i <= 5; i++) history.push(sample(i * 1000, { actorCount: i }));
    expect(history.size).toBe(3);
    expect(history.latest()!.actorCount).toBe(5);
    expect(history.levels('actorCount').map((p) => p.value)).toEqual([3, 4, 5]);
  });

  test('has no latest sample before the first arrives', () => {
    expect(new StatsHistory(10, HOUR_MS).latest()).toBeNull();
  });

  test('derives a per-second rate from cumulative counters', () => {
    const history = new StatsHistory(10, HOUR_MS);
    history.push(sample(0, { actorsStarted: 0 }));
    history.push(sample(1000, { actorsStarted: 10 }));
    history.push(sample(3000, { actorsStarted: 30 }));

    // 10 in 1s, then 20 in 2s.
    expect(history.rates('actorsStarted').map((p) => p.value)).toEqual([10, 10]);
    expect(history.latestRate('actorsStarted')).toBe(10);
  });

  test('a rate needs two readings', () => {
    const history = new StatsHistory(10, HOUR_MS);
    history.push(sample(0, { deadLetters: 7 }));
    expect(history.rates('deadLetters')).toHaveLength(0);
    expect(history.latestRate('deadLetters')).toBe(0);
  });

  test('a counter that went backwards reads as zero, not a negative spike', () => {
    // Means the server restarted and began counting again.
    const history = new StatsHistory(10, HOUR_MS);
    history.push(sample(0, { deadLetters: 500 }));
    history.push(sample(1000, { deadLetters: 3 }));
    expect(history.latestRate('deadLetters')).toBe(0);
  });

  test('ignores samples that did not advance the clock', () => {
    const history = new StatsHistory(10, HOUR_MS);
    history.push(sample(1000, { actorsStopped: 1 }));
    history.push(sample(1000, { actorsStopped: 9 }));
    expect(history.rates('actorsStopped')).toHaveLength(0);
  });

  test('surfaces a spike in the derived series', () => {
    const history = new StatsHistory(10, HOUR_MS);
    let total = 0;
    for (let i = 0; i <= 5; i++) {
      total += i === 3 ? 500 : 5;
      history.push(sample(i * 1000, { deadLetters: total }));
    }
    const rates = history.rates('deadLetters');
    expect(peakOf(rates)).toBe(500);
    // …and the spike sits where it happened, not smeared across.
    expect(rates.filter((p) => p.value > 100)).toHaveLength(1);
  });

  test('clear drops the window', () => {
    const history = new StatsHistory(5, HOUR_MS);
    history.push(sample(0));
    history.clear();
    expect(history.size).toBe(0);
    expect(history.latest()).toBeNull();
  });
});

describe('projectPoints', () => {
  const box = { width: 100, height: 40, padding: 0 };

  test('is empty for no samples', () => {
    expect(projectPoints([], box, 10)).toEqual([]);
  });

  test('anchors a single sample at the right edge', () => {
    const [point] = projectPoints([{ atMs: 0, value: 5 }], box, 10);
    expect(point!.x).toBe(100);
    expect(point!.y).toBe(20);
  });

  test('always scales from zero, so jitter does not look like a mountain', () => {
    const points = [
      { atMs: 0, value: 100 },
      { atMs: 1000, value: 101 },
    ];
    const projected = projectPoints(points, box, 101);
    // Both near the top, a hair apart — not one at the floor and one at
    // the ceiling, which a min-max scale would produce.
    expect(projected[0]!.y).toBeCloseTo(0.396, 2);
    expect(projected[1]!.y).toBe(0);
  });

  test('spaces the horizontal axis by time, so a gap stays a gap', () => {
    const projected = projectPoints([
      { atMs: 0, value: 1 },
      { atMs: 1000, value: 1 },
      { atMs: 9000, value: 1 },
    ], box, 1);
    expect(projected.map((p) => Math.round(p.x))).toEqual([0, 11, 100]);
  });

  test('puts a zero series on the baseline', () => {
    const projected = projectPoints([
      { atMs: 0, value: 0 },
      { atMs: 1000, value: 0 },
    ], box, 0);
    expect(projected.every((p) => p.y === 40)).toBe(true);
  });

  test('clamps a value above the shared peak instead of overflowing the box', () => {
    const projected = projectPoints([
      { atMs: 0, value: 0 },
      { atMs: 1000, value: 999 },
    ], box, 10);
    expect(projected[1]!.y).toBe(0);
  });

  test('honours vertical padding', () => {
    const padded = projectPoints([
      { atMs: 0, value: 0 },
      { atMs: 1000, value: 10 },
    ], { width: 100, height: 40, padding: 5 }, 10);
    expect(padded[0]!.y).toBe(35);
    expect(padded[1]!.y).toBe(5);
  });
});

describe('StatsHistory — seeding and the time bound', () => {
  test('a seeded series is what gets plotted, and live samples extend it', () => {
    const history = new StatsHistory(100, HOUR_MS);
    history.seed([
      { ...point(1_000), actorCount: 1 },
      { ...point(2_000), actorCount: 2 },
    ], HOUR_MS);
    expect(history.levels('actorCount').map((p) => p.value)).toEqual([1, 2]);

    history.push(sample(3_000, { actorCount: 3 }));
    expect(history.levels('actorCount').map((p) => p.value)).toEqual([1, 2, 3]);
    // `latest` is the live sample, not a seeded point — the tiles need
    // fields the summarised series does not carry.
    expect(history.latest()!.actorCount).toBe(3);
  });

  test('drops what has aged out of the span, whatever its resolution', () => {
    // Seeded points are coarse and live ones are per-second, so a count
    // bound would mean a different window depending on the mix.
    const history = new StatsHistory(1_000, 10_000);
    history.seed([point(1_000), point(5_000), point(9_000)], 10_000);
    expect(history.size).toBe(3);

    history.push(sample(12_000));
    // 1_000 is now more than ten seconds behind the newest point.
    expect(history.levels('actorCount')).toHaveLength(3);
    history.push(sample(20_000));
    expect(history.levels('actorCount').map((p) => p.atMs)).toEqual([12_000, 20_000]);
  });

  test('seeding replaces rather than appends', () => {
    const history = new StatsHistory(100, HOUR_MS);
    history.push(sample(1_000, { actorCount: 9 }));
    history.seed([point(5_000)], HOUR_MS);
    expect(history.levels('actorCount').map((p) => p.atMs)).toEqual([5_000]);
  });
});

/** A summarised point, as the server sends them. */
function point(atMs: number): StatsHistoryPoint {
  return {
    atMs,
    actorCount: 0,
    mailboxBacklog: 0,
    stashedTotal: 0,
    suspendedActors: 0,
    actorsStarted: 0,
    actorsStopped: 0,
    actorsRestarted: 0,
    deadLetters: 0,
    messagesProcessed: 0,
    mailboxDrops: 0,
  };
}
