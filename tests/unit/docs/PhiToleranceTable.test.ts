/**
 * #1452 — the φ tolerance table on `cluster/failure-detector.mdx`, read off
 * both pages and recomputed on the real class.
 *
 * The table quotes, per heartbeat cadence, how long a peer may be silent
 * before the shipped φ settings say `unreachable` and `down` — steady and at
 * first contact.  Those are the numbers an operator sizes a deployment by, and
 * a detector-level test pinning the same values in code would stay green
 * while a page drifted on its own (a cell retyped, a row dropped, the German
 * copy left behind), so this one reads the text.  The crossings are computed
 * with an explicit `now`, at whatever the defaults are today: a changed
 * default turns this red until both pages say what the class does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { PhiAccrualFailureDetector } from '../../../src/cluster/PhiAccrualFailureDetector.js';
import { PhiAccrualOptions } from '../../../src/cluster/PhiAccrualOptions.js';
import { parseDuration } from '../../../src/config/Duration.js';

const DOCUMENTATION_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

const PAGES = [
  {
    language: 'en',
    page: join(DOCUMENTATION_ROOT, 'cluster', 'failure-detector.mdx'),
    heading: '### What the shipped settings tolerate',
  },
  {
    language: 'de',
    page: join(DOCUMENTATION_ROOT, 'de', 'cluster', 'failure-detector.mdx'),
    heading: '### Was die ausgelieferten Einstellungen tolerieren',
  },
] as const;

/** The cadences the table carries, in its order. */
const CADENCES_MS = [500, 1_000, 2_000] as const;

type Row = {
  readonly cadenceMs: number;
  /** Seconds, as printed: [unreachable, down]. */
  readonly steady: readonly [number, number];
  readonly firstContact: readonly [number, number];
};

/** `4.06 s / 4.20 s` (or `4,06 s / 4,20 s`) as a pair of numbers. */
function secondsPair(cell: string): readonly [number, number] {
  const match = /^\s*([\d.,]+)\s*s\s*\/\s*([\d.,]+)\s*s\s*$/.exec(cell);
  expect(match, `"${cell}" is not a pair of durations in seconds`).not.toBeNull();
  return [Number(match![1]!.replace(',', '.')), Number(match![2]!.replace(',', '.'))];
}

/** The data rows of the first table after `heading` — header and separator skipped, stopping at the first non-row. */
function tableAfter(page: string, heading: string): Row[] {
  const lines = readFileSync(page, 'utf8').split(/\r?\n/);
  const start = lines.indexOf(heading);
  expect(start, `${heading} is missing from ${page}`).toBeGreaterThan(-1);
  const first = lines.findIndex((line, index) => index > start && line.startsWith('|'));
  const rows: Row[] = [];
  for (let index = first + 2; index < lines.length && lines[index]!.startsWith('|'); index++) {
    const cells = lines[index]!.split('|').slice(1, -1);
    const cadence = /`([^`]+)`/.exec(cells[0]!);
    expect(cadence, `no cadence in "${lines[index]}"`).not.toBeNull();
    rows.push({
      cadenceMs: parseDuration(cadence![1]!),
      steady: secondsPair(cells[1]!),
      firstContact: secondsPair(cells[2]!),
    });
  }
  return rows;
}

/** Silence from `origin` until `decide` first satisfies `holds` — φ only rises in silence, so a binary search. */
function crossing(
  detector: PhiAccrualFailureDetector, peer: NodeAddress, origin: number, holds: (verdict: string) => boolean,
): number {
  let low = origin;
  let high = origin + 120_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (holds(detector.decide(peer, middle))) high = middle; else low = middle + 1;
  }
  return low - origin;
}

/** The two crossings in seconds, rounded the way the page prints them. */
function printed(detector: PhiAccrualFailureDetector, peer: NodeAddress, origin: number): readonly [number, number] {
  const seconds = (ms: number): number => Math.round(ms / 10) / 100;
  return [
    seconds(crossing(detector, peer, origin, (verdict) => verdict !== 'healthy')),
    seconds(crossing(detector, peer, origin, (verdict) => verdict === 'down')),
  ];
}

function computedRow(cadenceMs: number): Row {
  const cadenceOptions = PhiAccrualOptions.create().withHeartbeatIntervalMs(cadenceMs);
  const steady = new PhiAccrualFailureDetector(cadenceOptions);
  const firstContact = new PhiAccrualFailureDetector(cadenceOptions);
  const peer = new NodeAddress('docs', 'h', 1);
  // "Steady" is a window of real intervals only: 250 beats push the two seeds out of 200 slots.
  const beats = 250;
  for (let beat = 0; beat <= beats; beat++) steady.heartbeat(peer, beat * cadenceMs);
  firstContact.heartbeat(peer, 0);
  return {
    cadenceMs,
    steady: printed(steady, peer, beats * cadenceMs),
    firstContact: printed(firstContact, peer, 0),
  };
}

describe('the φ tolerance table on failure-detector.mdx matches the class (#1452)', () => {
  test.each([...PAGES])('$language', ({ page, heading }) => {
    expect(tableAfter(page, heading)).toEqual(CADENCES_MS.map(computedRow));
  });
});
