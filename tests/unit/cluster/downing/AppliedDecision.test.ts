/**
 * #934 — the guard against deciding one view twice forgets the view once the
 * cluster has moved on from it.
 */
import { describe, expect, test } from 'bun:test';
import { AppliedDecision } from '../../../../src/cluster/downing/AppliedDecision.js';

const PARTITIONED = 'a:up|b:unreachable';
const AFTER_THE_DECISION = 'a:up|b:removed';
const RESTARTED = 'a:up|b:up';

describe('AppliedDecision (#934)', () => {
  test('a view a decision was applied on is covered while it stands', () => {
    const guard = new AppliedDecision();
    guard.observe(PARTITIONED);
    guard.record(PARTITIONED);
    guard.observe(PARTITIONED);

    expect(guard.covers(PARTITIONED)).toBe(true);
  });

  test('the same shape recurring after the view moved on is decided again', () => {
    const guard = new AppliedDecision();
    guard.observe(PARTITIONED);
    guard.record(PARTITIONED);

    // The decision tombstones the peer, it restarts at the same port, and the
    // same partition comes back: byte for byte the first fingerprint, because
    // membership is keyed without the incarnation.
    for (const view of [AFTER_THE_DECISION, RESTARTED, PARTITIONED]) guard.observe(view);

    expect(guard.covers(PARTITIONED)).toBe(false);
  });

  test('an evaluation that applied nothing records nothing, so the provider is asked again', () => {
    const guard = new AppliedDecision();
    guard.observe(PARTITIONED);

    expect(guard.covers(PARTITIONED)).toBe(false);
  });

  test('any change clears it, not only a return to full reachability', () => {
    // A member parked as unreachable the whole time keeps the view from ever
    // being fully reachable; the guard must not wait for that.
    const guard = new AppliedDecision();
    const withParked = `${PARTITIONED}|c:unreachable`;
    guard.observe(withParked);
    guard.record(withParked);
    guard.observe('a:up|b:removed|c:unreachable');
    guard.observe(withParked);

    expect(guard.covers(withParked)).toBe(false);
  });
});
