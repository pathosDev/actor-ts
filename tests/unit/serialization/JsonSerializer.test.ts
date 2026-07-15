import { describe, expect, test } from 'bun:test';
import { JsonSerializer } from '../../../src/serialization/JsonSerializer.js';
import { SerializationError } from '../../../src/serialization/Serializer.js';

const json = new JsonSerializer();

function rt<T>(value: T): T {
  return json.fromBinary(json.toBinary(value), '') as T;
}

describe('JsonSerializer', () => {
  test('has stable id = 1, name = "json", no manifest', () => {
    expect(json.id).toBe(1);
    expect(json.name).toBe('json');
    expect(json.includesManifest).toBe(false);
    expect(json.manifest({ any: 'thing' })).toBe('');
  });

  test('round-trips primitives', () => {
    expect(rt(1)).toBe(1);
    expect(rt('hi')).toBe('hi');
    expect(rt(true)).toBe(true);
    expect(rt(false)).toBe(false);
    expect(rt(null)).toBe(null);
    expect(rt(3.14)).toBeCloseTo(3.14);
  });

  test('round-trips arrays and nested objects', () => {
    expect(rt([1, 2, 3])).toEqual([1, 2, 3]);
    expect(rt({ a: { b: [1, { c: 2 }] } })).toEqual({ a: { b: [1, { c: 2 }] } });
  });

  test('round-trips Date to Date', () => {
    const now = new Date('2024-03-15T10:20:30.456Z');
    const restored = rt(now);
    expect(restored).toBeInstanceOf(Date);
    expect((restored as Date).toISOString()).toBe(now.toISOString());
  });

  test('round-trips Uint8Array', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const restored = rt(bytes);
    expect(restored).toBeInstanceOf(Uint8Array);
    expect(Array.from(restored as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
  });

  test('round-trips Map', () => {
    const map = new Map<string, number>([['a', 1], ['b', 2]]);
    const out = rt(map);
    expect(out).toBeInstanceOf(Map);
    expect(Array.from((out as Map<string, number>).entries())).toEqual([['a', 1], ['b', 2]]);
  });

  test('round-trips Set', () => {
    const set = new Set(['x', 'y', 'z']);
    const out = rt(set);
    expect(out).toBeInstanceOf(Set);
    expect(Array.from((out as Set<string>).values()).sort()).toEqual(['x', 'y', 'z']);
  });

  test('round-trips BigInt', () => {
    const big = 12345678901234567890n;
    const restored = rt(big);
    expect(typeof restored).toBe('bigint');
    expect(restored).toBe(big);
  });

  test('throws on non-JSON-serializable values', () => {
    expect(() => json.toBinary(() => 0 as unknown)).toThrow(SerializationError);
    expect(() => json.toBinary(undefined)).toThrow(SerializationError);
  });

  test('byte representation is valid UTF-8 JSON', () => {
    const bytes = json.toBinary({ a: 1 });
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe('{"a":1}');
  });
});
