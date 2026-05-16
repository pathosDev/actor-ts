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
    const a = VectorClock.empty();
    const b = VectorClock.empty();
    expect(a.compareTo(b)).toBe('equal');
  });

  test('one-sided tick ⇒ before / after', () => {
    const a = VectorClock.empty();
    const b = a.tick('node-a');
    expect(a.compareTo(b)).toBe('before');
    expect(b.compareTo(a)).toBe('after');
  });

  test('disjoint ticks ⇒ concurrent', () => {
    const a = VectorClock.empty().tick('node-a');
    const b = VectorClock.empty().tick('node-b');
    expect(a.compareTo(b)).toBe('concurrent');
    expect(b.compareTo(a)).toBe('concurrent');
    expect(a.isConcurrentWith(b)).toBe(true);
  });

  test('happens-before is transitive via merge', () => {
    const a0 = VectorClock.empty();
    const a1 = a0.tick('a');
    const merged = VectorClock.empty().tick('b').merge(a1);
    expect(a1.happensBefore(merged)).toBe(true);
  });

  test('merge takes per-component max', () => {
    const a = VectorClock.empty().tick('a').tick('a').tick('b');     // a=2, b=1
    const b = VectorClock.empty().tick('a').tick('c').tick('c');     // a=1, c=2
    const m = a.merge(b);
    expect(m.get('a')).toBe(2);
    expect(m.get('b')).toBe(1);
    expect(m.get('c')).toBe(2);
  });

  test('JSON round-trip preserves all components', () => {
    const a = VectorClock.empty().tick('x').tick('x').tick('y');
    const back = VectorClock.fromData(a.toJSON());
    expect(back.compareTo(a)).toBe('equal');
  });

  test('toString is a stable, sorted representation', () => {
    const a = VectorClock.empty().tick('z').tick('a').tick('m');
    expect(a.toString()).toBe('VC{a=1, m=1, z=1}');
  });
});
