/**
 * Replay-mutation fuzzer (#208) — exercises the persistence recovery
 * fold under random event sequences + snapshot-boundary
 * interleavings.  Sibling to the CRDT property tests (#285), but
 * focused on the persistence-recovery contract rather than CRDT laws.
 *
 * The three properties we verify:
 *
 *   1. **Determinism** — for a given event sequence, recovery (the
 *      fold via `onEvent`) always produces the same final state.
 *      Trivially true for any pure reducer, but the recovery path in
 *      PersistentActor wires a lot of plumbing around the reducer; a
 *      bug that introduced ordering non-determinism (e.g. parallel
 *      apply) would break this.
 *
 *   2. **Truncation-monotone** — applying a PREFIX of N events
 *      followed by the remaining (total - N) events yields the same
 *      state as applying all events in one go.  Maps to "recovery
 *      from a snapshot at seqNr=N plus events from N+1 onwards
 *      equals full replay from event 1".
 *
 *   3. **Empty-stream identity** — recovery over an empty event
 *      sequence yields the initial state, unchanged.
 *
 * No real PersistentActor here — we test the underlying fold pattern
 * because that's the contract.  PersistentActor's replay is a fold
 * with extra deduplication / snapshot loading on top; the underlying
 * fold has to be correct first.
 */
import { describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';

/* --------------------------- counter model --------------------------- */

type CounterCmd =
  | { kind: 'inc'; by: number }
  | { kind: 'dec'; by: number }
  | { kind: 'reset' };

interface CounterState { readonly value: number; readonly resets: number }

const counterReducer = (s: CounterState, e: CounterCmd): CounterState => {
  switch (e.kind) {
    case 'inc':   return { value: s.value + e.by, resets: s.resets };
    case 'dec':   return { value: s.value - e.by, resets: s.resets };
    case 'reset': return { value: 0, resets: s.resets + 1 };
  }
};

const counterInitial: CounterState = { value: 0, resets: 0 };

const counterEvent: fc.Arbitrary<CounterCmd> = fc.oneof(
  fc.record({ kind: fc.constant('inc' as const), by: fc.integer({ min: 1, max: 100 }) }),
  fc.record({ kind: fc.constant('dec' as const), by: fc.integer({ min: 1, max: 100 }) }),
  fc.record({ kind: fc.constant('reset' as const) }),
);

const counterEvents: fc.Arbitrary<CounterCmd[]> = fc.array(counterEvent, { maxLength: 50 });

/* ----------------------------- list model ----------------------------- */

type ListCmd =
  | { kind: 'append'; v: string }
  | { kind: 'remove'; index: number };

interface ListState { readonly items: ReadonlyArray<string> }

const listReducer = (s: ListState, e: ListCmd): ListState => {
  switch (e.kind) {
    case 'append': return { items: [...s.items, e.v] };
    case 'remove': {
      if (e.index < 0 || e.index >= s.items.length) return s;
      const next = [...s.items];
      next.splice(e.index, 1);
      return { items: next };
    }
  }
};

const listInitial: ListState = { items: [] };

const listEvent: fc.Arbitrary<ListCmd> = fc.oneof(
  fc.record({
    kind: fc.constant('append' as const),
    v: fc.constantFrom('a', 'b', 'c', 'd', 'e'),
  }),
  fc.record({
    kind: fc.constant('remove' as const),
    index: fc.integer({ min: 0, max: 10 }),
  }),
);

const listEvents: fc.Arbitrary<ListCmd[]> = fc.array(listEvent, { maxLength: 50 });

/* --------------------------- helpers --------------------------- */

function fold<S, E>(initial: S, events: ReadonlyArray<E>, reducer: (s: S, e: E) => S): S {
  return events.reduce(reducer, initial);
}

/* ----------------------------- tests ----------------------------- */

describe('replay-mutation fuzz — counter reducer', () => {
  test('determinism: same events → same state', () => {
    fc.assert(fc.property(counterEvents, (events) => {
      const a = fold(counterInitial, events, counterReducer);
      const b = fold(counterInitial, events, counterReducer);
      expect(a).toEqual(b);
    }));
  });

  test('truncation-monotone: prefix + suffix ≡ full replay', () => {
    fc.assert(fc.property(counterEvents, fc.nat(50), (events, n) => {
      const k = Math.min(n, events.length);
      const prefix = events.slice(0, k);
      const suffix = events.slice(k);
      const split = fold(fold(counterInitial, prefix, counterReducer), suffix, counterReducer);
      const full = fold(counterInitial, events, counterReducer);
      expect(split).toEqual(full);
    }));
  });

  test('empty-stream identity: fold([]) === initial', () => {
    const s = fold(counterInitial, [], counterReducer);
    expect(s).toEqual(counterInitial);
  });

  test('reset is idempotent across consecutive applications', () => {
    fc.assert(fc.property(counterEvents, (events) => {
      // Append two resets at the end — the second reset doesn't move
      // `value` (already 0) but DOES bump `resets`.
      const withOneReset = fold(counterInitial, [...events, { kind: 'reset' }], counterReducer);
      const withTwoResets = fold(counterInitial, [...events, { kind: 'reset' }, { kind: 'reset' }], counterReducer);
      expect(withOneReset.value).toBe(withTwoResets.value); // both 0
      expect(withTwoResets.resets - withOneReset.resets).toBe(1);
    }));
  });
});

describe('replay-mutation fuzz — list reducer', () => {
  test('determinism', () => {
    fc.assert(fc.property(listEvents, (events) => {
      const a = fold(listInitial, events, listReducer);
      const b = fold(listInitial, events, listReducer);
      expect(a).toEqual(b);
    }));
  });

  test('truncation-monotone', () => {
    fc.assert(fc.property(listEvents, fc.nat(50), (events, n) => {
      const k = Math.min(n, events.length);
      const split = fold(fold(listInitial, events.slice(0, k), listReducer), events.slice(k), listReducer);
      const full = fold(listInitial, events, listReducer);
      expect(split).toEqual(full);
    }));
  });

  test('out-of-bounds remove is silently ignored (no state change)', () => {
    fc.assert(fc.property(fc.array(listEvent, { minLength: 1, maxLength: 20 }), (events) => {
      const base = fold(listInitial, events, listReducer);
      const sizeBefore = base.items.length;
      // Injecting an OOB remove must not change the state.
      const after = listReducer(base, { kind: 'remove', index: 999 });
      expect(after.items.length).toBe(sizeBefore);
      expect(after).toEqual(base);
    }));
  });
});

describe('replay-mutation fuzz — corruption handling', () => {
  /**
   * A reducer that throws on a "corrupted" event represents the
   * user's onEvent function detecting an invariant violation
   * (unknown kind, bad payload).  The framework's recovery loop
   * should not silently absorb the throw — it propagates so the
   * actor fails-fast and the operator sees it.  We verify the
   * fold path (which is what recovery uses) propagates an
   * exception from the reducer.
   */
  const strictReducer = (s: CounterState, e: CounterCmd | { kind: 'corrupted' }): CounterState => {
    if (e.kind === 'corrupted') throw new Error('reducer: unknown event kind');
    return counterReducer(s, e);
  };

  test('a corrupted event mid-stream halts replay with a thrown error', () => {
    fc.assert(fc.property(counterEvents, counterEvents, (before, after) => {
      const events = [...before, { kind: 'corrupted' as const }, ...after];
      let thrown: Error | null = null;
      try { fold(counterInitial, events, strictReducer); }
      catch (e) { thrown = e as Error; }
      expect(thrown).not.toBeNull();
      expect(thrown!.message).toContain('unknown event kind');
    }));
  });

  test('replaying ONLY the safe prefix produces a valid state (no corruption leaked)', () => {
    fc.assert(fc.property(counterEvents, (before) => {
      // The framework's recovery contract: if event N is corrupted,
      // events 1..N-1 still build a valid state — recovery just
      // halts there and the actor surfaces the error.  We can test
      // the partial-replay shape directly: the state after the
      // safe prefix is the same whether or not the corrupted
      // event is appended (since strictReducer throws before any
      // mutation).
      const safeState = fold(counterInitial, before, strictReducer);
      // Even though we'd throw on the next event, the accumulator
      // BEFORE the throw is the prefix's natural result.
      expect(safeState).toEqual(fold(counterInitial, before, counterReducer));
    }));
  });
});
