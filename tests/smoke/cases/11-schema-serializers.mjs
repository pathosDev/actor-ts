/**
 * Smoke case: the Avro + Protobuf serializers on every runtime (#73).
 *
 * Runtime-sensitive on purpose, in two independent ways that a Bun-only
 * unit test cannot cover:
 *
 *   1. `avsc` decodes through `Buffer`-private methods, so `fromBuffer`
 *      rejects a plain `Uint8Array` — which is exactly what the base64
 *      framing hands it on the read path.  `AvroSerializer` bridges that
 *      with `Buffer.from(view)`, and whether a `Buffer` exists at all is
 *      a property of the runtime, not of the library.
 *   2. `protobufjs`'s `Writer.finish()` returns a window into a shared
 *      write pool whose size and offset differ per runtime (an exact
 *      buffer on Bun, offset ~6 KiB into a 64 KiB pool on Node, ~150 B
 *      into 8 KiB on Deno).  `ProtobufSerializer` detaches the bytes, and
 *      only running all three proves no runtime slips through.
 *
 * Both schema libraries are dev-only: actor-ts never imports them, it
 * takes the compiled type structurally.  This case is where the shipped
 * structural contract is checked against the real packages.
 */
export const name = 'schema serializers';
export const description = 'Avro + Protobuf round-trip and byte hygiene on this runtime';

export async function run({ actorTs, loadEntry }) {
  const { AvroSerializer, AvroSerializerOptions, ProtobufSerializer, ProtobufSerializerOptions } = await loadEntry('serialization');

  const avscModule = await import('avsc');
  const avsc = avscModule.default ?? avscModule;
  const protobufModule = await import('protobufjs');
  const protobuf = protobufModule.default ?? protobufModule;

  /* ------------------------------- Avro -------------------------------- */

  const avroType = avsc.Type.forSchema({
    name: 'Deposited',
    type: 'record',
    fields: [
      { name: 'amount', type: 'int' },
      { name: 'currency', type: 'string' },
    ],
  });
  const avroOptions = AvroSerializerOptions.create()
    .withAvroType(avroType)
    .withId(100);
  const avroSerializer = new AvroSerializer(avroOptions);

  const deposit = { amount: 150, currency: 'EUR' };
  const avroBytes = avroSerializer.toBinary(deposit);
  if (avroSerializer.manifest(deposit) !== 'Deposited') {
    throw new Error(`avro manifest not derived from the schema: ${avroSerializer.manifest(deposit)}`);
  }

  // Rebuild what the read path hands back: base64 in the stored row decodes
  // to a PLAIN Uint8Array (never a Buffer), and on a Buffer-backed runtime
  // it is a *view* at a non-zero offset.  Raw avsc refuses both.
  const base64 = btoa(String.fromCharCode(...avroBytes));
  const exact = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const padded = new Uint8Array(exact.length + 8);
  padded.set(exact, 5);
  const offsetView = padded.subarray(5, 5 + exact.length);

  for (const revived of [exact, offsetView]) {
    if (revived.constructor !== Uint8Array) {
      throw new Error(`expected a plain Uint8Array off the wire, got ${revived.constructor.name}`);
    }
    let rawAvscRefused = false;
    try {
      avroType.fromBuffer(revived);
    } catch {
      rawAvscRefused = true;
    }
    if (!rawAvscRefused && typeof Buffer !== 'undefined') {
      throw new Error('raw avsc accepted a plain Uint8Array — the Buffer bridge may be obsolete');
    }
    const avroBack = avroSerializer.fromBinary(revived, 'Deposited');
    if (avroBack.amount !== 150 || avroBack.currency !== 'EUR') {
      throw new Error(`avro round-trip lost data: ${JSON.stringify(avroBack)}`);
    }
  }

  let rejectedManifest = false;
  try {
    avroSerializer.fromBinary(avroBytes, 'Withdrawn');
  } catch {
    rejectedManifest = true;
  }
  if (!rejectedManifest) throw new Error('a foreign manifest was accepted by the Avro serializer');

  /* ----------------------------- Protobuf ------------------------------ */

  const root = protobuf.parse(`
    syntax = "proto3";
    package shop;
    message Order { string id = 1; int32 amount = 2; string note = 3; }
  `).root;
  const protobufOptions = ProtobufSerializerOptions.create()
    .withMessageType(root.lookupType('shop.Order'))
    .withId(101);
  const protobufSerializer = new ProtobufSerializer(protobufOptions);

  const order = { id: 'ord-1', amount: 3, note: 'gift wrap' };
  const protobufBytes = protobufSerializer.toBinary(order);
  if (protobufBytes.byteOffset !== 0 || protobufBytes.buffer.byteLength !== protobufBytes.byteLength) {
    throw new Error(
      'protobuf bytes still point into the shared write pool: '
      + `byteOffset=${protobufBytes.byteOffset} of ${protobufBytes.buffer.byteLength}`,
    );
  }
  if (protobufBytes.constructor !== Uint8Array) {
    throw new Error(`expected a plain Uint8Array, got ${protobufBytes.constructor.name}`);
  }
  // Encoding again must not disturb bytes already handed out.
  const snapshot = Uint8Array.from(protobufBytes);
  protobufSerializer.toBinary({ id: 'ord-2', amount: 9, note: 'a much longer note than the first' });
  for (let i = 0; i < snapshot.length; i++) {
    if (snapshot[i] !== protobufBytes[i]) throw new Error('a later encode overwrote earlier bytes');
  }

  const protobufBack = protobufSerializer.fromBinary(protobufBytes, '.shop.Order');
  if (protobufBack.id !== 'ord-1' || protobufBack.amount !== 3 || protobufBack.note !== 'gift wrap') {
    throw new Error(`protobuf round-trip lost data: ${JSON.stringify(protobufBack)}`);
  }
  if (Object.getPrototypeOf(protobufBack) !== Object.prototype) {
    throw new Error('protobuf decode returned a Message instance, not a plain object');
  }

  let rejectedInvalid = false;
  try {
    protobufSerializer.toBinary({ id: 42, amount: 1, note: '' });
  } catch {
    rejectedInvalid = true;
  }
  if (!rejectedInvalid) throw new Error('protobuf encode accepted a schema-invalid value');
}
