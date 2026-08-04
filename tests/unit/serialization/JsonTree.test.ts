import { describe, expect, test } from 'bun:test';
import {
  decodeJsonTree,
  encodeJsonTree,
  fromBase64,
  toBase64,
  type JsonTreeEncodeOptions,
} from '../../../src/serialization/JsonTree.js';
import { SerializationError } from '../../../src/serialization/Serializer.js';

function rt<T>(value: T, options?: JsonTreeEncodeOptions): unknown {
  return decodeJsonTree(encodeJsonTree(value, options));
}

describe('JsonTree — tagged round-trips', () => {
  test('primitives pass through under both policies', () => {
    for (const options of [undefined, { undefinedValues: 'omit' } as const]) {
      expect(rt(1, options)).toBe(1);
      expect(rt('hi', options)).toBe('hi');
      expect(rt(true, options)).toBe(true);
      expect(rt(null, options)).toBe(null);
    }
  });

  test('Date, Map, Set, bigint, Uint8Array round-trip as instances', () => {
    const at = new Date('2024-03-15T10:20:30.456Z');
    expect(rt(at)).toBeInstanceOf(Date);
    expect((rt(at) as Date).toISOString()).toBe(at.toISOString());

    const map = new Map<unknown, unknown>([['a', 1], [2n, new Set(['x'])]]);
    const decodedMap = rt(map) as Map<unknown, unknown>;
    expect(decodedMap).toBeInstanceOf(Map);
    expect(decodedMap.get('a')).toBe(1);
    const nested = Array.from(decodedMap.entries()).find(([k]) => k === 2n)?.[1];
    expect(nested).toBeInstanceOf(Set);
    expect(Array.from(nested as Set<string>)).toEqual(['x']);

    const set = rt(new Set([1, 'two', 3n])) as Set<unknown>;
    expect(set).toBeInstanceOf(Set);
    expect(Array.from(set)).toEqual([1, 'two', 3n]);

    expect(rt(12345678901234567890n)).toBe(12345678901234567890n);

    const bytes = rt(new Uint8Array([1, 2, 3])) as Uint8Array;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  test('rich types survive nested inside objects and arrays', () => {
    const decoded = rt({ deep: [{ when: new Date(0), who: new Set(['a']) }] }) as {
      deep: Array<{ when: Date; who: Set<string> }>;
    };
    expect(decoded.deep[0]!.when).toBeInstanceOf(Date);
    expect(decoded.deep[0]!.who).toBeInstanceOf(Set);
  });
});

describe('JsonTree — undefined policy', () => {
  test("'reject' (default) throws on undefined anywhere", () => {
    expect(() => encodeJsonTree(undefined)).toThrow(SerializationError);
    expect(() => encodeJsonTree({ a: undefined })).toThrow(SerializationError);
    expect(() => encodeJsonTree([undefined])).toThrow(SerializationError);
    expect(() => encodeJsonTree(new Set([undefined]))).toThrow(SerializationError);
  });

  test("'omit' drops undefined object properties, like JSON.stringify", () => {
    const encoded = encodeJsonTree({ a: undefined, b: 1 }, { undefinedValues: 'omit' });
    expect(encoded).toEqual({ b: 1 });
  });

  test("'omit' nulls undefined value positions (array slots, Set members, Map entries)", () => {
    expect(encodeJsonTree([1, undefined, 2], { undefinedValues: 'omit' })).toEqual([1, null, 2]);
    expect(rt(new Set([undefined]), { undefinedValues: 'omit' })).toEqual(new Set([null]));
    const map = rt(new Map([['k', undefined]]), { undefinedValues: 'omit' }) as Map<string, unknown>;
    expect(map.get('k')).toBe(null);
    // Sparse-array holes read as undefined and behave the same way.
    // eslint-disable-next-line no-sparse-arrays
    expect(encodeJsonTree([1, , 2], { undefinedValues: 'omit' })).toEqual([1, null, 2]);
  });

  test("a root-level undefined throws under 'omit' too", () => {
    expect(() => encodeJsonTree(undefined, { undefinedValues: 'omit' })).toThrow(SerializationError);
  });

  test("'omit' still rejects functions and symbols — those are bugs, not data", () => {
    expect(() => encodeJsonTree({ f: () => 0 }, { undefinedValues: 'omit' })).toThrow(SerializationError);
    expect(() => encodeJsonTree({ s: Symbol('x') }, { undefinedValues: 'omit' })).toThrow(SerializationError);
  });
});

describe('JsonTree — toJSON', () => {
  class Money {
    constructor(readonly cents: number) {}
    toJSON(): { currency: string; cents: number } {
      return { currency: 'EUR', cents: this.cents };
    }
  }

  test('honours toJSON() on class instances, top-level and nested', () => {
    expect(rt(new Money(150))).toEqual({ currency: 'EUR', cents: 150 });
    expect(rt({ price: new Money(99) })).toEqual({ price: { currency: 'EUR', cents: 99 } });
  });

  test('a toJSON() result that looks like a tag is escaped, not misdecoded', () => {
    const sneaky = { toJSON: () => ({ __set__: [1, 2] }) };
    expect(rt(sneaky)).toEqual({ __set__: [1, 2] });
  });

  test('toJSON() returning `this` terminates with an error instead of recursing forever', () => {
    const selfish: { toJSON?: unknown } = {};
    selfish.toJSON = () => selfish;
    // The result is walked without re-consulting toJSON, so the walk meets
    // the own `toJSON` function property and rejects it loudly.
    expect(() => encodeJsonTree(selfish)).toThrow(SerializationError);
  });

  test('toJSON() returning undefined behaves like an undefined value', () => {
    const vanishing = { toJSON: () => undefined };
    expect(encodeJsonTree({ a: vanishing, b: 1 }, { undefinedValues: 'omit' })).toEqual({ b: 1 });
    expect(encodeJsonTree([vanishing], { undefinedValues: 'omit' })).toEqual([null]);
    expect(() => encodeJsonTree({ a: vanishing })).toThrow(SerializationError);
  });

  test('Date is tagged before toJSON is consulted — it stays a Date', () => {
    expect(rt({ at: new Date(0) })).toEqual({ at: new Date(0) });
  });
});

describe('JsonTree — cycles and DAGs', () => {
  test('a self-referencing object reports a SerializationError with the path', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = { inner: a };
    expect(() => encodeJsonTree(a)).toThrow(/circular reference at \$\.self\.inner/);
  });

  test('cycles through arrays and Map values are caught too', () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => encodeJsonTree(arr)).toThrow(SerializationError);

    const map = new Map<string, unknown>();
    map.set('me', map);
    expect(() => encodeJsonTree(map)).toThrow(SerializationError);
  });

  test('a DAG (shared sibling reference) is allowed and duplicated', () => {
    const shared = { v: 1 };
    const encoded = encodeJsonTree({ left: shared, right: shared }) as {
      left: { v: number }; right: { v: number };
    };
    expect(encoded.left).toEqual({ v: 1 });
    expect(encoded.right).toEqual({ v: 1 });
    expect(encoded.left).not.toBe(encoded.right);
  });
});

describe('JsonTree — literal escape and decode tightening', () => {
  test('user data shaped like a tag round-trips as plain data', () => {
    expect(rt({ __set__: [1, 2] })).toEqual({ __set__: [1, 2] });
    expect(rt({ __date__: 'not a date' })).toEqual({ __date__: 'not a date' });
    expect(rt({ __serialized__: { id: 1 } })).toEqual({ __serialized__: { id: 1 } });
    expect(rt({ __literal__: 'meta' })).toEqual({ __literal__: 'meta' });
  });

  test('the escape wrapper is what actually gets written', () => {
    expect(encodeJsonTree({ __set__: [1] })).toEqual({ __literal__: { __set__: [1] } });
  });

  test('escaped values still decode their inner tree', () => {
    const decoded = rt({ __set__: new Date(0) }) as { __set__: Date };
    expect(decoded.__set__).toBeInstanceOf(Date);
  });

  test('a tag key next to other keys is plain data — no escape, no decode', () => {
    expect(encodeJsonTree({ __set__: [1], other: 2 })).toEqual({ __set__: [1], other: 2 });
    expect(decodeJsonTree({ __date__: '2024-01-01', extra: 1 }))
      .toEqual({ __date__: '2024-01-01', extra: 1 });
  });

  test('an unknown single "__x__"-style key is plain data', () => {
    expect(decodeJsonTree({ __custom__: 1 })).toEqual({ __custom__: 1 });
  });

  test('malformed tag payloads fail loudly instead of producing garbage', () => {
    expect(() => decodeJsonTree({ __map__: 'not-entries' })).toThrow(SerializationError);
    expect(() => decodeJsonTree({ __set__: 42 })).toThrow(SerializationError);
    expect(() => decodeJsonTree({ __date__: 123 })).toThrow(SerializationError);
    expect(() => decodeJsonTree({ __bytes__: [] })).toThrow(SerializationError);
    expect(() => decodeJsonTree({ __bigint__: 7 })).toThrow(SerializationError);
  });
});

describe('JsonTree — backward compatibility with plain JSON', () => {
  test('legacy plain-JSON trees decode unchanged', () => {
    const legacy = JSON.parse('{"n":1,"list":["a",null,3.5],"nested":{"flag":true}}');
    const decoded = decodeJsonTree(legacy);
    expect(decoded).toEqual({ n: 1, list: ['a', null, 3.5], nested: { flag: true } });
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  test('JSON-safe values encode to themselves (modulo copying)', () => {
    const value = { n: 1, list: ['a', null], nested: { flag: true } };
    expect(encodeJsonTree(value)).toEqual(value);
  });
});

describe('JsonTree — __proto__ hardening (#9)', () => {
  test('decode keeps a "__proto__" key as own data and the prototype untouched', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"x":1}');
    const out = decodeJsonTree(hostile) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(out['x']).toBe(1);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('encode preserves an own "__proto__" data property the same way', () => {
    const withProto = JSON.parse('{"__proto__":{"y":9},"x":1}');
    const encoded = encodeJsonTree(withProto) as Record<string, unknown>;
    expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(encoded, '__proto__')).toBe(true);
    expect(encoded['x']).toBe(1);
    expect(({} as Record<string, unknown>)['y']).toBeUndefined();
  });
});

describe('JsonTree — base64 helpers', () => {
  test('round-trip bytes of every value 0..255', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });
});
