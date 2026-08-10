import { describe, expect, test } from 'bun:test';
import protobuf from 'protobufjs';
import { ProtobufSerializer } from '../../../src/serialization/ProtobufSerializer.js';
import {
  ProtobufSerializerOptions,
  type ProtobufMessageType,
} from '../../../src/serialization/ProtobufSerializerOptions.js';
import { SerializationError } from '../../../src/serialization/Serializer.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { decodePayload, encodePayload } from '../../../src/persistence/storage/PayloadCodec.js';

type Order = { id: string; amount: number; note: string };

const orderSource = `
  syntax = "proto3";
  package shop;
  message Order {
    string id = 1;
    int32 amount = 2;
    string note = 3;
  }
  message Refund {
    string id = 1;
    int32 amount = 2;
  }
`;

const root = protobuf.parse(orderSource).root;

/**
 * The compile-time half of the contract: `protobufjs`'s reflection `Type`
 * has to be assignable to the structural `ProtobufMessageType` this
 * package declares, or "bring your own schema library" is fiction.
 */
const orderType: ProtobufMessageType<Order> = root.lookupType('shop.Order');
const refundType: ProtobufMessageType<Order> = root.lookupType('shop.Refund');

function serializerFor(
  overrides: { id?: number; plainObjects?: boolean } = {},
): ProtobufSerializer<Order> {
  const protobufOptions = ProtobufSerializerOptions.create<Order>()
    .withMessageType(orderType)
    .withId(overrides.id ?? 101);
  if (overrides.plainObjects !== undefined) protobufOptions.withPlainObjects(overrides.plainObjects);
  return new ProtobufSerializer(protobufOptions);
}

describe('ProtobufSerializer', () => {
  test('round-trips a message through real protobufjs bytes', () => {
    const serializer = serializerFor();
    const value: Order = { id: 'ord-1', amount: 3, note: 'gift wrap' };
    const decoded = serializer.fromBinary(serializer.toBinary(value), serializer.manifest(value));
    expect(decoded).toEqual(value);
  });

  test('defaults name to "protobuf" and the manifest to the fully-qualified name', () => {
    const serializer = serializerFor();
    expect(serializer.name).toBe('protobuf');
    expect(serializer.id).toBe(101);
    expect(serializer.manifest({ id: 'x', amount: 0, note: '' })).toBe('.shop.Order');
    expect(serializer.includesManifest).toBe(true);
  });

  /**
   * `Writer.finish()` returns a view into protobufjs's shared write pool
   * (`byteOffset` in the thousands on Node), so the bytes handed to a
   * journal row must not be a window onto other messages' data.
   */
  test('emits bytes that own their backing buffer, not a slice of the write pool', () => {
    const serializer = serializerFor();
    const bytes = serializer.toBinary({ id: 'ord-1', amount: 3, note: 'gift wrap' });
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
    // A `Buffer` would carry Node's `toJSON`, making the encoded form
    // runtime-dependent — so the output is normalised to a plain array.
    expect(bytes.constructor).toBe(Uint8Array);
  });

  test('two encodes in a row do not alias each other', () => {
    const serializer = serializerFor();
    const first = serializer.toBinary({ id: 'ord-1', amount: 1, note: 'a' });
    const firstCopy = Uint8Array.from(first);
    serializer.toBinary({ id: 'ord-2', amount: 2, note: 'bbbbbbbbbbbb' });
    expect(Array.from(first)).toEqual(Array.from(firstCopy));
  });

  test('decodes to a plain object with proto3 defaults filled in', () => {
    const serializer = serializerFor();
    const bytes = serializer.toBinary({ id: 'ord-2', amount: 0, note: '' });
    const decoded = serializer.fromBinary(bytes, '.shop.Order') as Order;
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(decoded).toEqual({ id: 'ord-2', amount: 0, note: '' });
  });

  test('withPlainObjects(false) hands back the protobufjs Message instance', () => {
    const serializer = serializerFor({ plainObjects: false });
    const bytes = serializer.toBinary({ id: 'ord-3', amount: 9, note: 'x' });
    const decoded = serializer.fromBinary(bytes, '.shop.Order');
    expect(Object.getPrototypeOf(decoded)).not.toBe(Object.prototype);
  });

  test('survives the store round-trip through PayloadCodec framing', () => {
    const serializer = serializerFor();
    const value: Order = { id: 'ord-4', amount: 12, note: 'fragile' };
    const stored = encodePayload(value, serializer);
    expect(stored).toContain('__serialized__');
    expect(decodePayload(stored, serializer)).toEqual(value);
  });

  /**
   * protobufjs's `encode` does not validate — it happily writes a
   * wrong-typed field and fails much later.  `verify` turns that into a
   * write-time error naming the offending field.
   */
  test('a value that does not match the schema fails at encode with the field named', () => {
    const serializer = serializerFor();
    expect(() => serializer.toBinary({ id: 42, amount: 1, note: '' } as unknown as Order))
      .toThrow(SerializationError);
    expect(() => serializer.toBinary({ id: 42, amount: 1, note: '' } as unknown as Order))
      .toThrow(/does not match the schema: id: string expected/);
  });

  test('garbage bytes fail at decode with the serializer named', () => {
    const serializer = serializerFor();
    expect(() => serializer.fromBinary(Uint8Array.from([0xff, 0xff, 0xff, 0xff]), '.shop.Order'))
      .toThrow(/protobuf \(id 101, manifest '\.shop\.Order'\): decode failed/);
  });

  /**
   * Protobuf's wire format carries field numbers but not the message
   * name, so another message's bytes decode into something plausible.
   * Only the manifest catches it — this test pins that the guard fires
   * where a bare decode would quietly succeed.
   */
  test('a payload written under a different manifest is rejected, not silently decoded', () => {
    const orderSerializer = serializerFor();
    const refundOptions = ProtobufSerializerOptions.create<Order>()
      .withMessageType(refundType)
      .withId(102);
    const refundSerializer = new ProtobufSerializer(refundOptions);
    const refundBytes = refundSerializer.toBinary({ id: 'ref-1', amount: 5, note: '' });

    expect(orderType.decode(refundBytes)).toBeDefined(); // a bare decode does NOT complain
    expect(() => orderSerializer.fromBinary(refundBytes, '.shop.Refund'))
      .toThrow(/cannot decode a payload written with manifest '\.shop\.Refund'/);
  });

  test('rejects an id in the range reserved for built-in serializers', () => {
    expect(() => serializerFor({ id: 1 })).toThrow(OptionsError);
    expect(() => serializerFor({ id: 1 })).toThrow(/must be >= 100/);
  });

  test('rejects missing required options', () => {
    expect(() => new ProtobufSerializer<Order>({ id: 101 })).toThrow(/messageType.*is required/);
    expect(() => new ProtobufSerializer<Order>({ messageType: orderType }))
      .toThrow(/id.*is required/);
  });

  /**
   * Generated static code (pbjs, ts-proto) exposes only `encode`/`decode`.
   * The optional halves of the structural type must therefore be genuinely
   * optional at runtime, not just in the declaration.
   */
  test('works with a message type that offers neither verify nor toObject', () => {
    const minimalType: ProtobufMessageType<Order> = {
      encode: (message: Order) => ({ finish: () => orderType.encode(message).finish() }),
      decode: (bytes: Uint8Array) => orderType.decode(bytes),
    };
    const minimalOptions = ProtobufSerializerOptions.create<Order>()
      .withMessageType(minimalType)
      .withId(103)
      .withManifest('shop.Order');
    const serializer = new ProtobufSerializer(minimalOptions);
    const value: Order = { id: 'ord-5', amount: 2, note: 'plain' };
    const decoded = serializer.fromBinary(serializer.toBinary(value), 'shop.Order') as Order;
    expect(decoded.id).toBe('ord-5');
    expect(decoded.amount).toBe(2);
  });
});
