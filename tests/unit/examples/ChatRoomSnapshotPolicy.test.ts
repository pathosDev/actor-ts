import { describe, expect, test } from 'bun:test';
import {
  ChatRoomActor,
  HISTORY_LIMIT,
  SNAPSHOT_EVERY_N_EVENTS,
} from '../../../examples/chat/backend/actors/ChatRoomActor.js';

/**
 * Regression test for #102 — `ChatRoomActor` registers a snapshot
 * policy with the right cadence so recovery is bounded regardless
 * of total journal age.  Exercises the policy function directly;
 * the cluster / pubsub plumbing the full actor reaches for in
 * `onCommand` isn't needed here.
 *
 * Why a test for this at all: the snapshot policy is a one-line
 * override on the actor.  Without a regression check, a future
 * refactor (or a PersistentActor base-class change that renames
 * the hook) could silently revert to event-replay-only and the
 * sample would quietly become slow at scale again — hard to spot
 * unless someone restarts a ten-thousand-message room and notices
 * the cold-start spike.
 */
describe('ChatRoomActor snapshot policy (#102)', () => {
  test('cadence constant matches the policy', () => {
    expect(SNAPSHOT_EVERY_N_EVENTS).toBe(100);
    // The history cap should always be ≥ the snapshot cadence —
    // otherwise the snapshot would be smaller than the in-memory
    // window and recovery would still leak older events into the
    // tail-replay.  Loose check, not a tight equality.
    expect(HISTORY_LIMIT).toBeGreaterThanOrEqual(SNAPSHOT_EVERY_N_EVENTS);
  });

  test('snapshotPolicy fires every Nth event', () => {
    const actor = new ChatRoomActor();
    const policy = actor.snapshotPolicy();
    const fakeState = { history: [] };
    const fakeEvent = { kind: 'MessagePosted' as const, from: 'a', text: 'x', ts: 0 };

    // Sample seq numbers 1..250 — boundaries (100, 200) should fire.
    const fires: number[] = [];
    for (let seq = 1; seq <= 250; seq++) {
      if (policy(seq, fakeState, fakeEvent)) fires.push(seq);
    }
    expect(fires).toEqual([100, 200]);
  });

  test('overriding actor instance produces a fresh policy each call (no shared mutable state)', () => {
    const roomA = new ChatRoomActor();
    const roomB = new ChatRoomActor();
    const policyA = roomA.snapshotPolicy();
    const policyB = roomB.snapshotPolicy();
    // Different actor → different policy instance.  This is mostly a
    // sanity check against accidentally hoisting `everyNEvents(100)`
    // into a singleton — the helper itself returns a fresh closure
    // per call, but if that ever changed the cadence behaviour would
    // become coupled across instances.
    expect(policyA).not.toBe(policyB);
    const fakeState = { history: [] };
    const fakeEvent = { kind: 'MessagePosted' as const, from: 'a', text: 'x', ts: 0 };
    expect(policyA(100, fakeState, fakeEvent)).toBe(true);
    expect(policyB(100, fakeState, fakeEvent)).toBe(true);
  });
});
