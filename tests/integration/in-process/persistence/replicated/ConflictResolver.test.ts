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
  opts: { timestamp?: number; replica?: string; vc?: VectorClock } = {},
): ConflictCandidate<E> {
  return {
    event,
    timestamp: opts.timestamp ?? 0,
    replica: opts.replica ?? 'node-a',
    vc: opts.vc ?? VectorClock.empty(),
  };
}

describe('LastWriterWinsResolver', () => {
  test('higher timestamp wins regardless of replica id', () => {
    const r = new LastWriterWinsResolver<string>();
    const a = candidate('newer', { timestamp: 200, replica: 'node-a' });
    const b = candidate('older', { timestamp: 100, replica: 'node-z' });
    expect(r.resolve(a, b)).toBe('newer');
    expect(r.resolve(b, a)).toBe('newer'); // commutative
  });

  test('lower timestamp loses regardless of replica id', () => {
    const r = new LastWriterWinsResolver<string>();
    const a = candidate('older', { timestamp: 50, replica: 'node-z' });
    const b = candidate('newer', { timestamp: 100, replica: 'node-a' });
    expect(r.resolve(a, b)).toBe('newer');
    expect(r.resolve(b, a)).toBe('newer');
  });

  test('tie on timestamp ⇒ higher replica id wins (lexicographic)', () => {
    const r = new LastWriterWinsResolver<string>();
    const a = candidate('A', { timestamp: 100, replica: 'node-a' });
    const b = candidate('B', { timestamp: 100, replica: 'node-b' });
    // 'node-b' > 'node-a' lexicographically.
    expect(r.resolve(a, b)).toBe('B');
    expect(r.resolve(b, a)).toBe('B');
  });

  test('tie on timestamp AND replica ⇒ either branch returns its own event', () => {
    // Same `(timestamp, replica)` is a real degenerate case — two
    // events written by the SAME node at the SAME tick.  The current
    // implementation returns the second argument (`b.event`) since
    // `'node-x' > 'node-x'` is false.  We pin that as observed
    // behaviour — both branches return the SAME event value (since
    // the replica/timestamp identify a single write) which is what
    // determinism actually requires.
    const r = new LastWriterWinsResolver<string>();
    const ev = 'same-write';
    const a = candidate(ev, { timestamp: 100, replica: 'node-x' });
    const b = candidate(ev, { timestamp: 100, replica: 'node-x' });
    expect(r.resolve(a, b)).toBe(ev);
    expect(r.resolve(b, a)).toBe(ev);
  });

  test('commutativity across a small input grid', () => {
    // Property-style cross-check — every (a,b) pair must agree with
    // (b,a).  Cheap & sufficient since the resolver has only two
    // axes: timestamp + replica id.
    const r = new LastWriterWinsResolver<number>();
    const candidates: Array<ConflictCandidate<number>> = [];
    for (const ts of [10, 20, 30]) {
      for (const rep of ['a', 'b', 'c']) {
        candidates.push(candidate(ts * 100 + rep.charCodeAt(0), { timestamp: ts, replica: rep }));
      }
    }
    for (const x of candidates) {
      for (const y of candidates) {
        expect(r.resolve(x, y)).toBe(r.resolve(y, x));
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
    const r = new CustomMergeResolver<number>((x, y) => {
      calls.push([x, y]);
      return x + y;
    });
    const a = candidate(1, { replica: 'node-a' });
    const b = candidate(10, { replica: 'node-b' });
    expect(r.resolve(b, a)).toBe(11); // sum commutes anyway
    expect(r.resolve(a, b)).toBe(11);
    // Both calls saw (1, 10) — the first-arg-is-node-a invariant.
    expect(calls).toEqual([[1, 10], [1, 10]]);
  });

  test('merge runs deterministically across argument order even for non-commutative merge', () => {
    // A merge that picks left-arg is normally NOT commutative.  The
    // resolver's replica-sort makes it commutative anyway.
    const r = new CustomMergeResolver<string>((x, _y) => x);
    const a = candidate('A', { replica: 'replica-1' });
    const b = candidate('B', { replica: 'replica-2' });
    // Inner merge always sees ('A', 'B') because replica-1 <= replica-2.
    expect(r.resolve(a, b)).toBe('A');
    expect(r.resolve(b, a)).toBe('A');
  });

  test('equal replica ids fall back to the (a, b) argument order', () => {
    // `a.replica <= b.replica` is true when they're equal, so the
    // merge sees (a, b) — same as the input call.  This pins the
    // tie-break path.
    const r = new CustomMergeResolver<string>((x, y) => `${x}|${y}`);
    const a = candidate('first', { replica: 'same' });
    const b = candidate('second', { replica: 'same' });
    expect(r.resolve(a, b)).toBe('first|second');
    expect(r.resolve(b, a)).toBe('second|first');
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
    const r = new CustomMergeResolver<number>((x, y) => x + y);
    const grid: Array<ConflictCandidate<number>> = [];
    for (const v of [1, 5, 10]) {
      for (const rep of ['a', 'b', 'c']) grid.push(candidate(v, { replica: rep }));
    }
    for (const x of grid) {
      for (const y of grid) {
        expect(r.resolve(x, y)).toBe(r.resolve(y, x));
      }
    }
  });
});
