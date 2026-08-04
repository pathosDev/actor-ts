import { describe, expect, test } from 'bun:test';
import { decodePayload, encodePayload } from '../../../src/persistence/storage/PayloadCodec.js';
import { JsonSerializer } from '../../../src/serialization/JsonSerializer.js';
import { SerializationError, type Serializer } from '../../../src/serialization/Serializer.js';

function rt<T>(value: T, serializer?: Serializer): unknown {
  return decodePayload(encodePayload(value, serializer), serializer);
}

describe('PayloadCodec — default tagged-JSON path', () => {
  test('rich types survive the string round-trip', () => {
    const stored = rt({
      at: new Date('2024-06-01T12:00:00.000Z'),
      roles: new Set(['admin', 'user']),
      balances: new Map([['acc-1', 1500n]]),
      raw: new Uint8Array([9, 8, 7]),
    }) as { at: Date; roles: Set<string>; balances: Map<string, bigint>; raw: Uint8Array };
    expect(stored.at).toBeInstanceOf(Date);
    expect(stored.roles).toBeInstanceOf(Set);
    expect(Array.from(stored.roles)).toEqual(['admin', 'user']);
    expect(stored.balances.get('acc-1')).toBe(1500n);
    expect(Array.from(stored.raw)).toEqual([9, 8, 7]);
  });

  test("undefined object properties are dropped, value positions preserved ('omit' policy)", () => {
    expect(encodePayload({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(decodePayload(encodePayload([1, undefined]))).toEqual([1, undefined]);
  });

  test('NaN and Infinity survive the store round-trip (#889)', () => {
    const decoded = decodePayload(encodePayload({ ratio: Infinity, floor: -Infinity, missing: NaN })) as {
      ratio: number; floor: number; missing: number;
    };
    expect(decoded.ratio).toBe(Infinity);
    expect(decoded.floor).toBe(-Infinity);
    expect(Number.isNaN(decoded.missing)).toBe(true);
  });

  test('a JSON-safe payload is stored byte-identically to bare JSON.stringify', () => {
    const value = { kind: 'deposited', amount: 5, note: null, tags: ['a'] };
    expect(encodePayload(value)).toBe(JSON.stringify(value));
  });

  test('legacy rows written with bare JSON.stringify decode unchanged', () => {
    const legacyRows = [
      JSON.stringify({ kind: 'created', n: 1 }),
      JSON.stringify(['e1', 'e2']),
      JSON.stringify('plain string event'),
      JSON.stringify(42),
      'null',
    ];
    expect(decodePayload(legacyRows[0]!)).toEqual({ kind: 'created', n: 1 });
    expect(decodePayload(legacyRows[1]!)).toEqual(['e1', 'e2']);
    expect(decodePayload(legacyRows[2]!)).toBe('plain string event');
    expect(decodePayload(legacyRows[3]!)).toBe(42);
    expect(decodePayload(legacyRows[4]!)).toBe(null);
  });

  test('tag-shaped user data round-trips as plain data', () => {
    expect(rt({ __set__: [1] })).toEqual({ __set__: [1] });
    expect(rt({ __serialized__: { id: 1, data: 'x' } }))
      .toEqual({ __serialized__: { id: 1, data: 'x' } });
  });
});

describe('PayloadCodec — custom serializer framing', () => {
  const json = new JsonSerializer();

  test('frames the payload self-describingly and round-trips it', () => {
    const encoded = encodePayload({ n: 1 }, json);
    const parsed = JSON.parse(encoded) as { __serialized__: { id: number; manifest: string; data: string } };
    expect(parsed.__serialized__.id).toBe(1);
    expect(typeof parsed.__serialized__.data).toBe('string');
    expect(decodePayload(encoded, json)).toEqual({ n: 1 });
  });

  test('mixed history: default rows stay readable after a serializer is configured', () => {
    const legacyRow = encodePayload({ kind: 'old', roles: new Set(['a']) });
    const decoded = decodePayload(legacyRow, json) as { kind: string; roles: Set<string> };
    expect(decoded.kind).toBe('old');
    expect(decoded.roles).toBeInstanceOf(Set);
  });

  test('a framed row without a configured serializer fails loudly', () => {
    const framed = encodePayload({ n: 1 }, json);
    expect(() => decodePayload(framed)).toThrow(SerializationError);
    expect(() => decodePayload(framed)).toThrow(/no serializer is configured/);
  });

  test('a framed row with a mismatching serializer id fails loudly', () => {
    const framed = encodePayload({ n: 1 }, json);
    const other: Serializer = {
      id: 999,
      name: 'other',
      includesManifest: false,
      manifest: () => '',
      toBinary: () => new Uint8Array(),
      fromBinary: () => ({}),
    };
    expect(() => decodePayload(framed, other)).toThrow(/written with serializer id 1/);
  });

  test('a legacy row merely resembling the frame decodes as plain data', () => {
    const lookalike = JSON.stringify({ __serialized__: 'not a frame' });
    expect(decodePayload(lookalike)).toEqual({ __serialized__: 'not a frame' });
    const partial = JSON.stringify({ __serialized__: { id: 'wrong-type', data: 5 } });
    expect(decodePayload(partial)).toEqual({ __serialized__: { id: 'wrong-type', data: 5 } });
  });

  test('the manifest travels with the row', () => {
    const manifested: Serializer<{ label: string }> = {
      id: 100,
      name: 'labelled',
      includesManifest: true,
      manifest: (obj) => obj.label,
      toBinary: (obj) => new TextEncoder().encode(obj.label),
      fromBinary: (bytes, manifest) => ({ label: `${manifest}:${new TextDecoder().decode(bytes)}` }),
    };
    const encoded = encodePayload({ label: 'evt' }, manifested as Serializer);
    expect(decodePayload(encoded, manifested as Serializer)).toEqual({ label: 'evt:evt' });
  });
});
