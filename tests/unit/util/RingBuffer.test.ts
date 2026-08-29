import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { RingBuffer } from '../../../src/util/RingBuffer.js';

/**
 * The ring replaces `Array.prototype.shift()` in the mailbox (#408), so its
 * observable behaviour has to be indistinguishable from an array queue.  The
 * property test at the bottom is the real guard — the examples above it pin
 * the wrap-around and growth edges that a random walk reaches only by luck.
 */
describe('RingBuffer — basics', () => {
  test('starts empty and stays empty on shift', () => {
    const ring = new RingBuffer<number>();
    expect(ring.length).toBe(0);
    expect(ring.shift()).toBeUndefined();
    expect(ring.length).toBe(0);
  });

  test('push then shift is FIFO', () => {
    const ring = new RingBuffer<number>();
    for (const n of [1, 2, 3]) ring.push(n);
    expect(ring.length).toBe(3);
    expect(ring.shift()).toBe(1);
    expect(ring.shift()).toBe(2);
    expect(ring.shift()).toBe(3);
    expect(ring.shift()).toBeUndefined();
  });

  test('survives many growth doublings', () => {
    const ring = new RingBuffer<number>();
    const count = 10_000;
    for (let i = 0; i < count; i++) ring.push(i);
    expect(ring.length).toBe(count);
    for (let i = 0; i < count; i++) expect(ring.shift()).toBe(i);
    expect(ring.length).toBe(0);
  });

  test('interleaved push/shift wraps the indices without losing order', () => {
    // The head chases the tail around the array many times over — the case a
    // straight fill-then-drain never reaches.
    const ring = new RingBuffer<number>();
    const seen: number[] = [];
    let next = 0;
    for (let round = 0; round < 500; round++) {
      ring.push(next++);
      ring.push(next++);
      seen.push(ring.shift()!);
    }
    while (ring.length > 0) seen.push(ring.shift()!);
    expect(seen).toEqual(Array.from({ length: next }, (_unused, i) => i));
  });

  test('growth while wrapped keeps queue order', () => {
    // Fill past the initial capacity, drain most of it so head sits deep in
    // the array, then push enough to force a doubling with the live elements
    // straddling the end of the backing store.
    const ring = new RingBuffer<number>();
    for (let i = 0; i < 8; i++) ring.push(i);
    for (let i = 0; i < 6; i++) ring.shift();
    for (let i = 8; i < 40; i++) ring.push(i);
    const drained: number[] = [];
    while (ring.length > 0) drained.push(ring.shift()!);
    expect(drained).toEqual(Array.from({ length: 34 }, (_unused, i) => i + 6));
  });
});

describe('RingBuffer — unshiftAll', () => {
  test('places the batch in front, in its own order', () => {
    const ring = new RingBuffer<string>();
    for (const s of ['c', 'd']) ring.push(s);
    ring.unshiftAll(['a', 'b']);
    const drained: string[] = [];
    while (ring.length > 0) drained.push(ring.shift()!);
    expect(drained).toEqual(['a', 'b', 'c', 'd']);
  });

  test('an empty batch is a no-op', () => {
    const ring = new RingBuffer<number>();
    ring.push(1);
    ring.unshiftAll([]);
    expect(ring.length).toBe(1);
    expect(ring.shift()).toBe(1);
  });

  test('grows for a batch larger than the whole ring', () => {
    // The stash replays up to DEFAULT_STASH_CAPACITY messages in one call, so
    // the batch routinely dwarfs the backing store it lands in.
    const ring = new RingBuffer<number>();
    ring.push(9_999);
    const batch = Array.from({ length: 1_024 }, (_unused, i) => i);
    ring.unshiftAll(batch);
    expect(ring.length).toBe(1_025);
    for (let i = 0; i < 1_024; i++) expect(ring.shift()).toBe(i);
    expect(ring.shift()).toBe(9_999);
  });

  test('walks head backwards across the start of the backing array', () => {
    const ring = new RingBuffer<number>();
    for (let i = 0; i < 5; i++) ring.push(i);
    ring.shift();                    // head = 1
    ring.unshiftAll([100, 101]);     // head wraps to the end of the array
    const drained: number[] = [];
    while (ring.length > 0) drained.push(ring.shift()!);
    expect(drained).toEqual([100, 101, 1, 2, 3, 4]);
  });
});

describe('RingBuffer — drain', () => {
  test('returns everything in order and empties the ring', () => {
    const ring = new RingBuffer<number>();
    for (let i = 0; i < 100; i++) ring.push(i);
    for (let i = 0; i < 30; i++) ring.shift();
    const drained = ring.drain();
    expect(drained).toEqual(Array.from({ length: 70 }, (_unused, i) => i + 30));
    expect(ring.length).toBe(0);
    expect(ring.shift()).toBeUndefined();
  });

  test('the ring is reusable after a drain', () => {
    const ring = new RingBuffer<string>();
    ring.push('a');
    expect(ring.drain()).toEqual(['a']);
    ring.push('b');
    expect(ring.length).toBe(1);
    expect(ring.shift()).toBe('b');
  });

  test('draining an empty ring yields an empty array', () => {
    expect(new RingBuffer<number>().drain()).toEqual([]);
  });

  test('a shifted slot stops retaining its element', () => {
    // A mailbox that drained a burst of large payloads must not keep them
    // reachable through the slots they used to occupy.
    const ring = new RingBuffer<object>();
    const payload = { big: 'x' };
    ring.push(payload);
    ring.shift();
    const slots = (ring as unknown as { slots: ReadonlyArray<unknown> }).slots;
    expect(slots.every((slot) => slot === undefined)).toBe(true);
  });
});

describe('RingBuffer — matches an array queue for any operation sequence', () => {
  test('property: push / shift / unshiftAll / drain agree with a reference model', () => {
    type RingOperation =
      | { readonly kind: 'push'; readonly value: number }
      | { readonly kind: 'shift' }
      | { readonly kind: 'unshiftAll'; readonly values: ReadonlyArray<number> }
      | { readonly kind: 'drain' };

    const operation = fc.oneof(
      fc.integer({ min: 0, max: 1_000 }).map((value): RingOperation => ({ kind: 'push', value })),
      fc.constant<RingOperation>({ kind: 'shift' }),
      fc.array(fc.integer({ min: 0, max: 1_000 }), { maxLength: 20 })
        .map((values): RingOperation => ({ kind: 'unshiftAll', values })),
      fc.constant<RingOperation>({ kind: 'drain' }),
    );

    fc.assert(
      fc.property(fc.array(operation, { maxLength: 400 }), (operations) => {
        const ring = new RingBuffer<number>();
        const model: number[] = [];
        for (const step of operations) {
          if (step.kind === 'push') {
            ring.push(step.value);
            model.push(step.value);
          } else if (step.kind === 'shift') {
            expect(ring.shift()).toEqual(model.shift());
          } else if (step.kind === 'unshiftAll') {
            ring.unshiftAll(step.values);
            model.unshift(...step.values);
          } else {
            expect(ring.drain()).toEqual(model.splice(0, model.length));
          }
          expect(ring.length).toBe(model.length);
        }
      }),
      { numRuns: 300 },
    );
  });
});
