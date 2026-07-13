/**
 * VectorClock tests — the relation `compareTo` returns is the
 * foundation everything in Replicated ES decides on (apply, dedupe,
 * merge), so the four cases (before / after / equal / concurrent)
 * each get a hand-written scenario.
 */
import { describe, expect, test } from 'bun:test';
import { VectorClock } from '../../../../../src/persistence/replicated/VectorClock.js';

describe('VectorClock — compareTo', () => {
  test('empty clocks are equal', () => {
    const clockA = VectorClock.empty();
    const clockB = VectorClock.empty();
    expect(clockA.compareTo(clockB)).toBe('equal');
  });

  test('one-sided tick ⇒ before / after', () => {
    const clockA = VectorClock.empty();
    const clockB = clockA.tick('node-a');
    expect(clockA.compareTo(clockB)).toBe('before');
    expect(clockB.compareTo(clockA)).toBe('after');
  });

  test('disjoint ticks ⇒ concurrent', () => {
    const clockA = VectorClock.empty().tick('node-a');
    const clockB = VectorClock.empty().tick('node-b');
    expect(clockA.compareTo(clockB)).toBe('concurrent');
    expect(clockB.compareTo(clockA)).toBe('concurrent');
    expect(clockA.isConcurrentWith(clockB)).toBe(true);
  });

  test('happens-before is transitive via merge', () => {
    const a0 = VectorClock.empty();
    const a1 = a0.tick('a');
    const merged = VectorClock.empty().tick('b').merge(a1);
    expect(a1.happensBefore(merged)).toBe(true);
  });

  test('merge takes per-component max', () => {
    const clockA = VectorClock.empty().tick('a').tick('a').tick('b');     // a=2, b=1
    const clockB = VectorClock.empty().tick('a').tick('c').tick('c');     // a=1, c=2
    const merged = clockA.merge(clockB);
    expect(merged.get('a')).toBe(2);
    expect(merged.get('b')).toBe(1);
    expect(merged.get('c')).toBe(2);
  });

  test('JSON round-trip preserves all components', () => {
    const clockA = VectorClock.empty().tick('x').tick('x').tick('y');
    const back = VectorClock.fromData(clockA.toJSON());
    expect(back.compareTo(clockA)).toBe('equal');
  });

  test('toString is a stable, sorted representation', () => {
    const clockA = VectorClock.empty().tick('z').tick('a').tick('m');
    expect(clockA.toString()).toBe('VC{a=1, m=1, z=1}');
  });
});
