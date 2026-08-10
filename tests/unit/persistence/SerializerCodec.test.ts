import { describe, expect, test } from 'bun:test';
import avsc from 'avsc';
import protobuf from 'protobufjs';
import { serializerCodec } from '../../../src/persistence/migration/Codec.js';
import { InMemorySchemaRegistry } from '../../../src/persistence/migration/SchemaRegistry.js';
import { decodePayload, encodePayload } from '../../../src/persistence/storage/PayloadCodec.js';
import { AvroSerializer } from '../../../src/serialization/AvroSerializer.js';
import { AvroSerializerOptions, type AvroType } from '../../../src/serialization/AvroSerializerOptions.js';
import { ProtobufSerializer } from '../../../src/serialization/ProtobufSerializer.js';
import {
  ProtobufSerializerOptions,
  type ProtobufMessageType,
} from '../../../src/serialization/ProtobufSerializerOptions.js';
import { SerializationError } from '../../../src/serialization/Serializer.js';

const MANIFEST = 'BankAccount.Deposited';

type DepositedV1 = { amount: number };
type DepositedV2 = { amount: number; currency: string };

/* v1 is Avro. */
const depositedV1Type: AvroType<DepositedV1> = avsc.Type.forSchema({
  name: 'DepositedV1',
  type: 'record',
  fields: [{ name: 'amount', type: 'int' }],
});
const avroOptions = AvroSerializerOptions.create<DepositedV1>()
  .withAvroType(depositedV1Type)
  .withId(100);
const avroSerializer = new AvroSerializer(avroOptions);

/* v2 is Protobuf — a different wire format for the same manifest. */
const protobufRoot = protobuf.parse(`
  syntax = "proto3";
  package bank;
  message DepositedV2 { int32 amount = 1; string currency = 2; }
`).root;
const depositedV2Type: ProtobufMessageType<DepositedV2> = protobufRoot.lookupType('bank.DepositedV2');
const protobufOptions = ProtobufSerializerOptions.create<DepositedV2>()
  .withMessageType(depositedV2Type)
  .withId(101);
const protobufSerializer = new ProtobufSerializer(protobufOptions);

function registryWithBothFormats(): InMemorySchemaRegistry {
  const registry = new InMemorySchemaRegistry();
  registry.register<DepositedV1>(MANIFEST, 1, {
    codec: serializerCodec(avroSerializer),
  });
  registry.register<DepositedV2, DepositedV2>(MANIFEST, 2, {
    codec: serializerCodec(protobufSerializer),
    upcastFromPrev: (previous: unknown): DepositedV2 => ({
      ...(previous as DepositedV1),
      currency: 'USD',
    }),
    compatibility: 'backward',
  });
  return registry;
}

describe('serializerCodec', () => {
  test('round-trips through a serializer without touching base64 itself', () => {
    const codec = serializerCodec(avroSerializer);
    const wire = codec.encode({ amount: 25 }) as { serializerId: number; manifest: string; bytes: Uint8Array };
    expect(wire.serializerId).toBe(100);
    expect(wire.manifest).toBe('DepositedV1');
    expect(wire.bytes).toBeInstanceOf(Uint8Array);
    expect(codec.decode(wire)).toEqual({ amount: 25 });
  });

  test('names itself after the serializer it wraps', () => {
    expect(serializerCodec(avroSerializer).name).toBe('serializer:avro');
    expect(serializerCodec(protobufSerializer, 'deposits-v2').name).toBe('deposits-v2');
  });

  /**
   * The point of returning a bare `Uint8Array`: `PayloadCodec`'s tagged
   * JSON already carries bytes as `__bytes__`, so the codec must not add
   * a second base64 layer of its own.
   */
  test('the bytes reach storage through the journal’s own __bytes__ framing', () => {
    const codec = serializerCodec(avroSerializer);
    const stored = encodePayload(codec.encode({ amount: 25 }));
    expect(stored).toContain('__bytes__');
    expect(stored).not.toContain('__serialized__');
    expect(codec.decode(decodePayload(stored))).toEqual({ amount: 25 });
  });

  test('a payload written by a different serializer fails with both ids named', () => {
    const avroCodec = serializerCodec(avroSerializer);
    const protobufCodec = serializerCodec(protobufSerializer);
    const wire = protobufCodec.encode({ amount: 3, currency: 'EUR' });
    expect(() => avroCodec.decode(wire)).toThrow(SerializationError);
    expect(() => avroCodec.decode(wire))
      .toThrow(/written by serializer id 101 .*but this codec holds 'avro' \(id 100\)/);
  });

  test('a plain-JSON row from before the switch fails with a readable message', () => {
    const codec = serializerCodec(avroSerializer);
    expect(() => codec.decode({ amount: 25 }))
      .toThrow(/payload is not a serialized frame/);
    expect(() => codec.decode('not-an-object')).toThrow(/expected a serialized payload object/);
  });
});

describe('serializerCodec + SchemaRegistry — one manifest, two wire formats', () => {
  test('writes the latest version in Protobuf and reads an Avro v1 row forward', () => {
    const registry = registryWithBothFormats();
    const adapter = registry.eventAdapter<DepositedV2>(MANIFEST);

    // A row written before v2 existed: Avro bytes, version 1.
    const legacyRegistry = new InMemorySchemaRegistry();
    legacyRegistry.register<DepositedV1>(MANIFEST, 1, { codec: serializerCodec(avroSerializer) });
    const legacyFrame = legacyRegistry.eventAdapter<DepositedV1>(MANIFEST).toJournal({ amount: 25 });
    expect(legacyFrame.version).toBe(1);

    // Through the journal's string form, exactly as a store would hold it.
    const storedPayload = decodePayload(encodePayload(legacyFrame.payload));
    const brought = adapter.fromJournal({
      manifest: MANIFEST, version: 1, payload: storedPayload,
    });
    expect(brought).toEqual({ amount: 25, currency: 'USD' });

    // New writes go out as Protobuf at v2.
    const fresh = adapter.toJournal({ amount: 40, currency: 'EUR' });
    expect(fresh.version).toBe(2);
    expect((fresh.payload as { serializerId: number }).serializerId).toBe(101);
    expect(adapter.fromJournal({ manifest: MANIFEST, version: 2, payload: fresh.payload }))
      .toEqual({ amount: 40, currency: 'EUR' });
  });

  test('the sample compatibility check runs the Avro→Protobuf hop at register time', () => {
    const registry = new InMemorySchemaRegistry();
    registry.register<DepositedV1>(MANIFEST, 1, { codec: serializerCodec(avroSerializer) });
    expect(() => registry.register<DepositedV2, DepositedV2>(MANIFEST, 2, {
      codec: serializerCodec(protobufSerializer),
      upcastFromPrev: (previous: unknown): DepositedV2 => ({
        ...(previous as DepositedV1),
        currency: 'USD',
      }),
      compatibility: 'sample',
      sample: { amount: 25 },
    })).not.toThrow();
  });

  test('an upcaster that produces a schema-invalid value is caught at register time', () => {
    const registry = new InMemorySchemaRegistry();
    registry.register<DepositedV1>(MANIFEST, 1, { codec: serializerCodec(avroSerializer) });
    expect(() => registry.register<DepositedV2, DepositedV2>(MANIFEST, 2, {
      codec: serializerCodec(protobufSerializer),
      // `currency` must be a string — protobufjs's verify catches it.
      upcastFromPrev: (previous: unknown): DepositedV2 => ({
        ...(previous as DepositedV1),
        currency: 99 as unknown as string,
      }),
      compatibility: 'sample',
      sample: { amount: 25 },
    })).toThrow(/currency: string expected/);
  });
});
