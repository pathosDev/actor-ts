import { describe, expect, test } from 'bun:test';
import avsc from 'avsc';
import { AvroSerializer } from '../../../src/serialization/AvroSerializer.js';
import {
  AvroSerializerOptions,
  type AvroType,
} from '../../../src/serialization/AvroSerializerOptions.js';
import { SerializationError } from '../../../src/serialization/Serializer.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { decodePayload, encodePayload } from '../../../src/persistence/storage/PayloadCodec.js';

type Deposited = { amount: number; currency: string };

const depositedSchema = {
  name: 'Deposited',
  type: 'record' as const,
  fields: [
    { name: 'amount', type: 'int' },
    { name: 'currency', type: 'string' },
  ],
};

/**
 * The compile-time half of the contract: `avsc`'s own `Type` has to be
 * assignable to the structural `AvroType` this package declares, or the
 * whole "bring your own schema library" premise is fiction.
 */
const depositedType: AvroType<Deposited> = avsc.Type.forSchema(depositedSchema);

function serializerFor(overrides: { id?: number; manifest?: string } = {}): AvroSerializer<Deposited> {
  const avroOptions = AvroSerializerOptions.create<Deposited>()
    .withAvroType(depositedType)
    .withId(overrides.id ?? 100);
  if (overrides.manifest !== undefined) avroOptions.withManifest(overrides.manifest);
  return new AvroSerializer(avroOptions);
}

describe('AvroSerializer', () => {
  test('round-trips a record through real avsc bytes', () => {
    const serializer = serializerFor();
    const value: Deposited = { amount: 150, currency: 'EUR' };
    const bytes = serializer.toBinary(value);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(serializer.fromBinary(bytes, serializer.manifest(value))).toEqual(value);
  });

  test('Avro is materially more compact than the JSON of the same record', () => {
    const serializer = serializerFor();
    const value: Deposited = { amount: 150, currency: 'EUR' };
    const jsonLength = new TextEncoder().encode(JSON.stringify(value)).length;
    expect(serializer.toBinary(value).length).toBeLessThan(jsonLength);
  });

  test('defaults name to "avro" and the manifest to the schema record name', () => {
    const serializer = serializerFor();
    expect(serializer.name).toBe('avro');
    expect(serializer.id).toBe(100);
    expect(serializer.manifest({ amount: 1, currency: 'EUR' })).toBe('Deposited');
    expect(serializer.includesManifest).toBe(true);
  });

  test('an explicitly empty manifest turns the manifest off', () => {
    const serializer = serializerFor({ manifest: '' });
    expect(serializer.includesManifest).toBe(false);
    expect(serializer.manifest({ amount: 1, currency: 'EUR' })).toBe('');
  });

  /**
   * The regression this class exists for: `PayloadCodec` decodes base64
   * into a plain `Uint8Array`, and `avsc.fromBuffer` reaches for
   * `Buffer`-private methods, so the naive wiring throws
   * `this.buf.utf8Slice is not a function` on Bun, Node AND Deno — on the
   * read path only, i.e. after the data is already written.
   */
  test('decodes a plain Uint8Array, which raw avsc refuses', () => {
    const serializer = serializerFor();
    const value: Deposited = { amount: 7, currency: 'USD' };
    const detached = Uint8Array.from(serializer.toBinary(value));
    expect(detached.constructor).toBe(Uint8Array);
    expect(() => depositedType.fromBuffer(detached)).toThrow();
    expect(serializer.fromBinary(detached, 'Deposited')).toEqual(value);
  });

  test('survives the store round-trip through PayloadCodec framing', () => {
    const serializer = serializerFor();
    const value: Deposited = { amount: 42, currency: 'CHF' };
    const stored = encodePayload(value, serializer);
    expect(stored).toContain('__serialized__');
    expect(decodePayload(stored, serializer)).toEqual(value);
  });

  test('a value that does not match the schema fails at encode', () => {
    const serializer = serializerFor();
    expect(() => serializer.toBinary({ amount: 'lots' } as unknown as Deposited))
      .toThrow(SerializationError);
  });

  test('truncated bytes fail at decode with the serializer named', () => {
    const serializer = serializerFor();
    const bytes = serializer.toBinary({ amount: 300, currency: 'EUR' });
    expect(() => serializer.fromBinary(bytes.slice(0, 1), 'Deposited'))
      .toThrow(/avro \(id 100, manifest 'Deposited'\): decode failed/);
  });

  /**
   * Avro carries no field tags, so bytes from another schema usually
   * decode into a plausible-but-wrong value rather than failing.  The
   * manifest is the only guard.
   */
  test('a payload written under a different manifest is rejected, not silently decoded', () => {
    const serializer = serializerFor();
    const bytes = serializer.toBinary({ amount: 1, currency: 'EUR' });
    expect(() => serializer.fromBinary(bytes, 'Withdrawn'))
      .toThrow(/cannot decode a payload written with manifest 'Withdrawn'/);
    // A manifest-less writer is still let through.
    expect(serializer.fromBinary(bytes, '')).toEqual({ amount: 1, currency: 'EUR' });
  });

  test('rejects an id in the range reserved for built-in serializers', () => {
    expect(() => serializerFor({ id: 2 })).toThrow(OptionsError);
    expect(() => serializerFor({ id: 2 })).toThrow(/must be >= 100/);
  });

  test('rejects missing required options', () => {
    expect(() => new AvroSerializer<Deposited>({ id: 100 })).toThrow(/avroType.*is required/);
    expect(() => new AvroSerializer<Deposited>({ avroType: depositedType }))
      .toThrow(/id.*is required/);
  });

  test('accepts a plain options object interchangeably with the builder', () => {
    const serializer = new AvroSerializer<Deposited>({
      avroType: depositedType,
      id: 100,
      name: 'deposits-avro',
    });
    expect(serializer.name).toBe('deposits-avro');
    expect(serializer.fromBinary(serializer.toBinary({ amount: 5, currency: 'GBP' }), 'Deposited'))
      .toEqual({ amount: 5, currency: 'GBP' });
  });
});
