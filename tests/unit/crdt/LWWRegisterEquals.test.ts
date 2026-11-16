/**
 * `LWWRegister.equals` (#1841 follow-up).  It compared values through
 * `JSON.stringify`, which throws on a `bigint` — so asking whether two
 * registers holding one threw instead of answering — and renders
 * `{ v: undefined }` and `{}` alike, so it called two different registers
 * equal.  It now compares through `canonicalOrderKey`, the same key the merge
 * ranks a full tie by, so "equal" and "a tie merge may keep either" agree.
 *
 * Each of the three fields is also changed on its own, so a comparison that
 * looks at only one or two of them cannot pass.
 */
import { describe, expect, test } from 'bun:test';
import { LWWRegister } from '../../../src/crdt/LWWRegister.js';

function register(value: unknown, replica = 'node-a', timestamp = 5): LWWRegister<unknown> {
  return LWWRegister.empty<unknown>().assign(replica, value, timestamp);
}

describe('LWWRegister.equals', () => {
  test('answers for a bigint value instead of throwing', () => {
    expect(register(1n).equals(register(1n))).toBe(true);
    expect(register(1n).equals(register(2n))).toBe(false);
    expect(register({ amount: 1n }).equals(register({ amount: 1n }))).toBe(true);
  });

  test('tells a field holding undefined apart from a missing one', () => {
    expect(register({ v: undefined }).equals(register({}))).toBe(false);
  });

  test('tells a bigint apart from its string spelling', () => {
    expect(register(1n).equals(register('1n'))).toBe(false);
  });

  test('holds for structurally equal values in distinct objects', () => {
    expect(register({ a: 1, b: [2, 'x'] }).equals(register({ b: [2, 'x'], a: 1 }))).toBe(true);
  });

  test('a difference in any one field is a different register', () => {
    const base = register('value', 'node-a', 5);
    expect(base.equals(register('value', 'node-a', 5))).toBe(true);
    expect(base.equals(register('other', 'node-a', 5))).toBe(false);
    expect(base.equals(register('value', 'node-b', 5))).toBe(false);
    expect(base.equals(register('value', 'node-a', 6))).toBe(false);
  });

  test('an empty register equals an empty register and nothing else', () => {
    expect(LWWRegister.empty<unknown>().equals(LWWRegister.empty<unknown>())).toBe(true);
    expect(LWWRegister.empty<unknown>().equals(register(null, '', 0))).toBe(true);
    expect(LWWRegister.empty<unknown>().equals(register(undefined, '', 0))).toBe(false);
  });
});
