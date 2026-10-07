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

/**
 * The engine's own wording for a document that does not parse.  For
 * `{not json` JSC says `JSON Parse error: Expected '}'` and V8 says
 * `Expected property name or '}' in JSON at position 1`, so the expectation is
 * computed from the same input at runtime rather than pinned to one engine.
 */
function engineParseMessage(text: string): string {
  try {
    JSON.parse(text);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`fixture ${JSON.stringify(text)} parses, but it is meant not to`);
}

function errorThrownBy(action: () => unknown): Error {
  try {
    action();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the decode to throw');
}

describe('JsonSerializer — a document that is not JSON (#1449)', () => {
  const encoder = new TextEncoder();

  for (const text of ['{not json', '', '[1,2', '{"a":1}x']) {
    test(`${JSON.stringify(text)} is a SerializationError naming the parse failure`, () => {
      const parseMessage = engineParseMessage(text);
      const error = errorThrownBy(() => json.fromBinary(encoder.encode(text), ''));
      expect(error).toBeInstanceOf(SerializationError);
      expect(error).not.toBeInstanceOf(SyntaxError);
      expect(error.name).not.toBe('SyntaxError');
      expect(error.message).toBe(`JsonSerializer: document is not valid JSON: ${parseMessage}`);
      expect(error.cause).toBeInstanceOf(SyntaxError);
      expect((error.cause as Error).message).toBe(parseMessage);
    });
  }

  // Bytes that are not JSON and a bad value inside well-formed JSON are two
  // different faults, so only the first one carries the parse prefix.  A wrap
  // around the whole decode would put it on both.
  test('a malformed tag inside well-formed JSON keeps its own message', () => {
    const error = errorThrownBy(() => json.fromBinary(encoder.encode('{"__map__":5}'), ''));
    expect(error).toBeInstanceOf(SerializationError);
    expect(error.message).toBe('Malformed __map__ tag: expected an array of entry pairs');
  });

  test('the nesting ceiling keeps its own message too', () => {
    const shallow = new JsonSerializer({ maxNestingDepth: 4 });
    const error = errorThrownBy(() => shallow.fromBinary(encoder.encode('[[[[[[[[]]]]]]]]'), ''));
    expect(error).toBeInstanceOf(SerializationError);
    expect(error.message).toBe('JSON nesting deeper than 4');
  });
});
