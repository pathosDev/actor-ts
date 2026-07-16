import { describe, expect, test } from 'bun:test';
import { CborSerializer } from '../../../src/serialization/CborSerializer.js';
import { JsonSerializer } from '../../../src/serialization/JsonSerializer.js';

const cbor = new CborSerializer();
const json = new JsonSerializer();

function rt<T>(v: T): T {
  return cbor.fromBinary(cbor.toBinary(v), '') as T;
}

describe('CborSerializer', () => {
  test('has id=2, name="cbor"', () => {
    expect(cbor.id).toBe(2);
    expect(cbor.name).toBe('cbor');
    expect(cbor.includesManifest).toBe(false);
  });

  test('round-trips typical actor messages', () => {
    const message = {
      id: 'alice',
      op: 'deposit' as const,
      amount: 100.5,
      metadata: { traceId: 'abc-123' },
      retries: [1, 2, 3],
    };
    expect(rt(message)).toEqual(message);
  });

  test('round-trips nested Uint8Array without base64 overhead', () => {
    const payload = { header: 'binary', body: new Uint8Array([1, 2, 3, 4, 5]) };
    const out = rt(payload);
    expect(out.header).toBe('binary');
    expect(out.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(out.body)).toEqual([1, 2, 3, 4, 5]);
  });

  test('CBOR is smaller than JSON for integer-heavy messages', () => {
    const message = { ids: Array.from({ length: 32 }, (_, i) => i * 1000) };
    expect(cbor.toBinary(message).byteLength).toBeLessThan(json.toBinary(message).byteLength);
  });

  test('CBOR is smaller than JSON for byte payloads (no base64 overhead)', () => {
    const bytes = new Uint8Array(256).map((_, i) => i & 0xff);
    expect(cbor.toBinary({ blob: bytes }).byteLength)
      .toBeLessThan(json.toBinary({ blob: bytes }).byteLength);
  });

  test('manifest returns empty string', () => {
    expect(cbor.manifest({})).toBe('');
  });
});
