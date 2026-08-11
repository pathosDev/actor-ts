import { CborDecoder, CborEncoder } from './CborCodec.js';
import { type Serializer } from './Serializer.js';

/**
 * CBOR serializer — compact binary format, used by default for system
 * messages (heartbeats, gossip, handoff) and available for any user type
 * that benefits from smaller payloads than JSON.
 *
 * It carries the SAME rich types as `JsonSerializer` — `Date`, `Map`, `Set`,
 * `BidirectionalMap`, `bigint`, `Uint8Array`, `RegExp`, `URL`, `Error`,
 * every typed array, `NaN`/`Infinity`/`-0` — as real instances, just in
 * compact binary rather than tagged JSON text.  The two are asserted equal
 * by `tests/unit/serialization/RichTypeParity.test.ts`; they used to
 * disagree, silently and lossily, until #1036.
 *
 * One deliberate difference: `undefined` is carried natively (CBOR simple
 * value 23), including as an object property, where `JsonSerializer` rejects
 * it outright.  That makes this the more permissive of the two.
 *
 * Manifests are not used by the CBOR serializer itself — the caller is
 * expected to round-trip compatible shapes.  A user CLASS still decodes to a
 * plain object unless the framework tags it; register a dedicated serializer
 * via `SerializationExtension` for that.
 */
export class CborSerializer implements Serializer<unknown> {
  readonly id = 2;
  readonly name = 'cbor';
  readonly includesManifest = false;

  manifest(_obj: unknown): string { return ''; }

  toBinary(obj: unknown): Uint8Array {
    return new CborEncoder().encode(obj);
  }

  fromBinary(bytes: Uint8Array, _manifest: string): unknown {
    return new CborDecoder().decode(bytes);
  }
}
