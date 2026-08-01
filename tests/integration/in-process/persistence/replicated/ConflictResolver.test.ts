/**
 * ConflictResolver tests — the resolver is what guarantees that every
 * replica picks the SAME event on concurrent writes.  Two contracts
 * matter: deterministic (same inputs → same output) and commutative
 * (`resolve(a, b) === resolve(b, a)`).  Drift here would cause replicas
 * to diverge silently after a network partition, so each property gets
 * a hand-written case and a tiny property-style cross-check.
 */
import { describe, expect, test } from 'bun:test';
import {
  CustomMergeResolver,
  LastWriterWinsResolver,
  type ConflictCandidate,
} from '../../../../../src/persistence/replicated/ConflictResolver.js';
import { VectorClock } from '../../../../../src/persistence/replicated/VectorClock.js';

/** Build a candidate with sensible defaults — saves repetition in each test. */
function candidate<E>(
  event: E,
  options: { timestamp?: number; replica?: string; vc?: VectorClock } = {},
): ConflictCandidate<E> {
  return {
    event,
    timestamp: options.timestamp ?? 0,
    replica: options.replica ?? 'node-a',
    vc: options.vc ?? VectorClock.empty(),
  };
}

describe('LastWriterWinsResolver', () => {
  test('higher timestamp wins regardless of replica id', () => {
    const resolver = new LastWriterWinsResolver<string>();
    const candidateA = candidate('newer', { timestamp: 200, replica: 'node-a' });
    const candidateB = candidate('older', { timestamp: 100, replica: 'node-z' });
    expect(resolver.resolve(candidateA, candidateB)).toBe('newer');
    expect(resolver.resolve(candidateB, candidateA)).toBe('newer'); // commutative
  });

  test('lower timestamp loses regardless of replica id', () => {
    const resolver = new LastWriterWinsResolver<string>();
    const candidateA = candidate('older', { timestamp: 50, replica: 'node-z' });
    const candidateB = candidate('newer', { timestamp: 100, replica: 'node-a' });
    expect(resolver.resolve(candidateA, candidateB)).toBe('newer');
    expect(resolver.resolve(candidateB, candidateA)).toBe('newer');
  });

  test('tie on timestamp ⇒ higher replica id wins (lexicographic)', () => {
    const resolver = new LastWriterWinsResolver<string>();
    const candidateA = candidate('A', { timestamp: 100, replica: 'node-a' });
    const candidateB = candidate('B', { timestamp: 100, replica: 'node-b' });
    // 'node-b' > 'node-a' lexicographically.
    expect(resolver.resolve(candidateA, candidateB)).toBe('B');
    expect(resolver.resolve(candidateB, candidateA)).toBe('B');
  });

  test('tie on timestamp AND replica ⇒ either branch returns its own event', () => {
    // Same `(timestamp, replica)` is a real degenerate case — two
    // events written by the SAME node at the SAME tick.  The current
    // implementation returns the second argument (`b.event`) since
    // `'node-x' > 'node-x'` is false.  We pin that as observed
    // behaviour — both branches return the SAME event value (since
    // the replica/timestamp identify a single write) which is what
    // determinism actually requires.
    const resolver = new LastWriterWinsResolver<string>();
    const ev = 'same-write';
    const candidateA = candidate(ev, { timestamp: 100, replica: 'node-x' });
    const candidateB = candidate(ev, { timestamp: 100, replica: 'node-x' });
    expect(resolver.resolve(candidateA, candidateB)).toBe(ev);
    expect(resolver.resolve(candidateB, candidateA)).toBe(ev);
  });

  test('commutativity across a small input grid', () => {
    // Property-style cross-check — every (a,b) pair must agree with
    // (b,a).  Cheap & sufficient since the resolver has only two
    // axes: timestamp + replica id.
    const resolver = new LastWriterWinsResolver<number>();
    const candidates: Array<ConflictCandidate<number>> = [];
    for (const ts of [10, 20, 30]) {
      for (const rep of ['a', 'b', 'c']) {
        candidates.push(candidate(ts * 100 + rep.charCodeAt(0), { timestamp: ts, replica: rep }));
      }
    }
    for (const leftCandidate of candidates) {
      for (const rightCandidate of candidates) {
        expect(resolver.resolve(leftCandidate, rightCandidate)).toBe(resolver.resolve(rightCandidate, leftCandidate));
      }
    }
  });
});

describe('CustomMergeResolver', () => {
  test('user merge function receives candidates in replica-sorted order', () => {
    // Even when called with (b, a), the inner merge sees (a, b) because
    // 'node-a' <= 'node-b'.  This is the explicit guard for users who
    // accidentally wrote a non-commutative merge.
    const calls: Array<[number, number]> = [];
    const resolver = new CustomMergeResolver<number>((leftCandidate, rightCandidate) => {
      calls.push([leftCandidate, rightCandidate]);
      return leftCandidate + rightCandidate;
    });
    const candidateA = candidate(1, { replica: 'node-a' });
    const candidateB = candidate(10, { replica: 'node-b' });
    expect(resolver.resolve(candidateB, candidateA)).toBe(11); // sum commutes anyway
    expect(resolver.resolve(candidateA, candidateB)).toBe(11);
    // Both calls saw (1, 10) — the first-arg-is-node-a invariant.
    expect(calls).toEqual([[1, 10], [1, 10]]);
  });

  test('merge runs deterministically across argument order even for non-commutative merge', () => {
    // A merge that picks left-arg is normally NOT commutative.  The
    // resolver's replica-sort makes it commutative anyway.
    const resolver = new CustomMergeResolver<string>((leftCandidate, _y) => leftCandidate);
    const candidateA = candidate('A', { replica: 'replica-1' });
    const candidateB = candidate('B', { replica: 'replica-2' });
    // Inner merge always sees ('A', 'B') because replica-1 <= replica-2.
    expect(resolver.resolve(candidateA, candidateB)).toBe('A');
    expect(resolver.resolve(candidateB, candidateA)).toBe('A');
  });

  test('equal replica ids fall back to the (a, b) argument order', () => {
    // `a.replica <= b.replica` is true when they're equal, so the
    // merge sees (a, b) — same as the input call.  This pins the
    // tie-break path.
    const resolver = new CustomMergeResolver<string>((leftCandidate, rightCandidate) => `${leftCandidate}|${rightCandidate}`);
    const candidateA = candidate('first', { replica: 'same' });
    const candidateB = candidate('second', { replica: 'same' });
    expect(resolver.resolve(candidateA, candidateB)).toBe('first|second');
    expect(resolver.resolve(candidateB, candidateA)).toBe('second|first');
    // The two outputs differ here — that's expected, since the user
    // explicitly opted into a `(left, right)`-asymmetric merge and
    // both candidates share a replica id (so the sort can't break
    // the tie).  The commutativity guarantee is for DIFFERENT
    // replicas, which is the only case that actually occurs in a
    // distributed setting.
  });

  test('commutativity across a small input grid for a commutative inner merge', () => {
    // Sum is naturally commutative, so resolve(a,b) === resolve(b,a)
    // even before the replica-sort.  This pins that the wrapper
    // doesn't accidentally introduce divergence.
    const resolver = new CustomMergeResolver<number>((leftCandidate, rightCandidate) => leftCandidate + rightCandidate);
    const grid: Array<ConflictCandidate<number>> = [];
    for (const value of [1, 5, 10]) {
      for (const rep of ['a', 'b', 'c']) grid.push(candidate(value, { replica: rep }));
    }
    for (const leftCandidate of grid) {
      for (const rightCandidate of grid) {
        expect(resolver.resolve(leftCandidate, rightCandidate)).toBe(resolver.resolve(rightCandidate, leftCandidate));
      }
    }
  });
});
