import { describe, expect, test } from 'bun:test';
import {
  PAUSE_BUFFER_FRAMES,
  PAUSE_POLICIES,
  PauseBuffer,
  frozenNow,
} from '../src/core/timeControl.js';
import {
  DEVTOOLS_STREAM_IDS,
  type DevToolsStreamPayload,
} from '../../src/devtools/protocol/index.js';

/** A payload distinguishable from its neighbours, which is all these need. */
function frame(sequenceNumber: number): DevToolsStreamPayload {
  return { kind: 'stats-sample', atMs: sequenceNumber } as unknown as DevToolsStreamPayload;
}

function atMsOf(payload: DevToolsStreamPayload): number {
  return (payload as unknown as { atMs: number }).atMs;
}

describe('PAUSE_POLICIES', () => {
  test('covers every stream the protocol declares', () => {
    // A total record rather than a lookup with a default: adding a stream should
    // force the decision here, not silently inherit whichever behaviour the
    // fallback happened to be. This asserts the runtime half of that — the type
    // catches a missing key, but not one added to the table and never shipped.
    const covered = Object.keys(PAUSE_POLICIES).sort();
    expect(covered).toEqual([...DEVTOOLS_STREAM_IDS].sort());
  });

  test('the append-shaped streams buffer and the state-shaped ones resync', () => {
    // The split is the whole design, so it is worth stating rather than
    // implying. `events` has no snapshot to recover from — `EventStreamTap`
    // returns nothing, because a tail has no past — so anything dropped there is
    // gone. `actors` replaces its state wholesale on a snapshot, so discarding
    // deltas costs nothing.
    expect(PAUSE_POLICIES.events).toBe('buffer');
    expect(PAUSE_POLICIES.spans).toBe('buffer');
    expect(PAUSE_POLICIES.actors).toBe('resync');
    expect(PAUSE_POLICIES.cluster).toBe('resync');
    expect(PAUSE_POLICIES.stats).toBe('resync');
    expect(PAUSE_POLICIES.mailboxes).toBe('resync');
  });
});

describe('PauseBuffer', () => {
  test('hands back what it was given, oldest first', () => {
    const buffer = new PauseBuffer(10);
    buffer.push(frame(1));
    buffer.push(frame(2));
    buffer.push(frame(3));

    expect(buffer.size).toBe(3);
    expect(buffer.drain().map(atMsOf)).toEqual([1, 2, 3]);
    expect(buffer.size).toBe(0);
  });

  test('draining twice does not repeat what it already handed over', () => {
    const buffer = new PauseBuffer(10);
    buffer.push(frame(1));
    buffer.drain();
    expect(buffer.drain()).toHaveLength(0);
  });

  test('drops the oldest at the cap and counts what it lost', () => {
    // Oldest rather than newest: a pause that outlasts the cap is one where the
    // recent past is the part still worth having. Silently keeping a short tail
    // would read as a quiet system, which is a different answer.
    const buffer = new PauseBuffer(3);
    for (let i = 1; i <= 5; i++) buffer.push(frame(i));

    expect(buffer.size).toBe(3);
    expect(buffer.dropped).toBe(2);
    expect(buffer.drain().map(atMsOf)).toEqual([3, 4, 5]);
  });

  test('the dropped tally survives a drain, so a resume can still report it', () => {
    const buffer = new PauseBuffer(1);
    buffer.push(frame(1));
    buffer.push(frame(2));
    buffer.drain();
    expect(buffer.dropped).toBe(1);
  });

  test('clear forgets the frames and the tally', () => {
    const buffer = new PauseBuffer(1);
    buffer.push(frame(1));
    buffer.push(frame(2));
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.dropped).toBe(0);
  });

  test('defaults to the shipped cap', () => {
    const buffer = new PauseBuffer();
    for (let i = 0; i < PAUSE_BUFFER_FRAMES + 1; i++) buffer.push(frame(i));
    expect(buffer.size).toBe(PAUSE_BUFFER_FRAMES);
    expect(buffer.dropped).toBe(1);
  });
});

describe('frozenNow', () => {
  test('holds at the paused instant', () => {
    expect(frozenNow(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  test('reads through to the wall clock while time runs', () => {
    const before = Date.now();
    const now = frozenNow(null);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
