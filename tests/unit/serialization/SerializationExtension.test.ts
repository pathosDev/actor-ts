import { describe, expect, test } from 'bun:test';
import { CborSerializer } from '../../../src/serialization/CborSerializer.js';
import { JsonSerializer } from '../../../src/serialization/JsonSerializer.js';
import { SerializationExtension } from '../../../src/serialization/SerializationExtension.js';
import { SerializationError, type Serializer } from '../../../src/serialization/Serializer.js';

describe('SerializationExtension defaults', () => {
  test('JSON (id=1) and CBOR (id=2) are registered out of the box', () => {
    const ext = new SerializationExtension();
    expect(ext.registeredIds()).toContain(1);
    expect(ext.registeredIds()).toContain(2);
    expect(ext.findById(1)).toBeInstanceOf(JsonSerializer);
    expect(ext.findById(2)).toBeInstanceOf(CborSerializer);
  });

  test('default serializer is JSON', () => {
    const ext = new SerializationExtension();
    expect(ext.defaultSerializer).toBeInstanceOf(JsonSerializer);
  });

  test('requireById throws on missing id', () => {
    const ext = new SerializationExtension();
    expect(() => ext.requireById(9999)).toThrow(SerializationError);
  });

  test('findById returns undefined on missing id', () => {
    expect(new SerializationExtension().findById(9999)).toBeUndefined();
  });
});

describe('SerializationExtension — class bindings', () => {
  class Foo { constructor(public v: number) {} }
  class SubFoo extends Foo {}

  test('bind + findFor returns the bound serializer for the exact class', () => {
    const ext = new SerializationExtension();
    ext.bind(Foo, 2);
    expect(ext.findFor(new Foo(1))).toBe(ext.findById(2)!);
  });

  test('findFor walks up the prototype chain for inherited classes', () => {
    const ext = new SerializationExtension();
    ext.bind(Foo, 2);
    expect(ext.findFor(new SubFoo(1))).toBe(ext.findById(2)!);
  });

  test('findFor falls back to default when no binding matches', () => {
    const ext = new SerializationExtension();
    expect(ext.findFor({ plain: 'object' })).toBe(ext.defaultSerializer);
  });

  test('setDefault replaces the fallback', () => {
    const ext = new SerializationExtension();
    const cbor = ext.findById(2)!;
    ext.setDefault(cbor);
    expect(ext.defaultSerializer).toBe(cbor);
    expect(ext.findFor('anything')).toBe(cbor);
  });

  test('bind rejects unknown serializer ids', () => {
    const ext = new SerializationExtension();
    expect(() => ext.bind(Foo, 9999)).toThrow(SerializationError);
  });

  test('register rejects duplicate ids with a different serializer', () => {
    const ext = new SerializationExtension();
    const impostor: Serializer = {
      id: 1, name: 'impostor', includesManifest: false,
      manifest: () => '', toBinary: () => new Uint8Array(), fromBinary: () => null,
    };
    expect(() => ext.register(impostor)).toThrow(/already registered/);
  });

  test('register is idempotent for the SAME serializer instance', () => {
    const ext = new SerializationExtension();
    const json = ext.findById(1)!;
    expect(() => ext.register(json)).not.toThrow();
  });
});

describe('SerializationExtension encode/decode helpers', () => {
  test('encode + decode round-trip via the default serializer', () => {
    const ext = new SerializationExtension();
    const value = { cmd: 'inc', amount: 5 };
    const encoded = ext.encode(value);
    expect(encoded.serializerId).toBe(1); // JSON default
    expect(encoded.bytes).toBeInstanceOf(Uint8Array);
    expect(ext.decode(encoded)).toEqual(value);
  });

  test('encode uses the class-bound serializer when one is registered', () => {
    class Order { constructor(public total: number) {} }
    const ext = new SerializationExtension();
    ext.bind(Order, 2); // CBOR
    const encoded = ext.encode(new Order(99));
    expect(encoded.serializerId).toBe(2);
    // Decode round-trip yields a plain object (class identity NOT preserved
    // by the built-in CBOR serializer — that's the contract).
    expect(ext.decode(encoded)).toEqual({ total: 99 });
  });

  test('decode throws on unknown serializer id', () => {
    const ext = new SerializationExtension();
    expect(() => ext.decode({ serializerId: 999, manifest: '', bytes: new Uint8Array() }))
      .toThrow(SerializationError);
  });
});
