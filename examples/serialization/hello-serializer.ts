/**
 * Minimal serializer example.
 *
 * Shows how to use the built-in JSON and CBOR serializers via
 * SerializationExtension, including class-to-serializer binding.
 *
 *   bun run examples/serialization/hello-serializer.ts
 */
import {
  CborSerializer,
  JsonSerializer,
  SerializationExtension,
} from '../../src/index.js';

class Greeting {
  constructor(public readonly who: string, public readonly at: Date) {}
}

function main(): void {
  const ext = new SerializationExtension();

  // Default fallback is JSON — everything goes through it unless bound.
  console.log('Registered serializer IDs:', ext.registeredIds());

  const message = { op: 'increment', amount: 42, payload: new Uint8Array([1, 2, 3, 4]) };

  const asJson = ext.encode(message);   // uses JsonSerializer (default)
  console.log('JSON bytes  :', asJson.bytes.byteLength, 'bytes');
  console.log('             ', new TextDecoder().decode(asJson.bytes));

  // Bind this exact class to CBOR for compact binary transport.
  ext.bind(Greeting, 2);
  const greet = new Greeting('world', new Date('2024-01-02T03:04:05Z'));
  const encoded = ext.encode(greet);
  console.log('CBOR bytes  :', encoded.bytes.byteLength, 'bytes (id=', encoded.serializerId, ')');

  const roundtrip = ext.decode(encoded);
  console.log('Decoded     :', roundtrip);

  // Direct usage — no extension at all.
  const cbor = new CborSerializer();
  const json = new JsonSerializer();
  const ints = { ids: Array.from({ length: 20 }, (_, i) => i * 1000) };
  console.log('Integer array JSON size :', json.toBinary(ints).byteLength, 'bytes');
  console.log('Integer array CBOR size :', cbor.toBinary(ints).byteLength, 'bytes');
}

main();
