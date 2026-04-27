import { CborDecoder, CborEncoder } from './CborCodec.js';
import { type Serializer } from './Serializer.js';

/**
 * CBOR serializer — compact binary format, used by default for system
 * messages (heartbeats, gossip, handoff) and available for any user type
 * that benefits from smaller payloads than JSON.  Handles the same JS
 * primitives as JsonSerializer plus:
 *   - `Uint8Array` round-trips as a byte string (no base64 overhead).
 *   - `Date` uses CBOR tag 1.
 *   - `bigint` uses CBOR tag 2 / 3.
 *
 * Manifests are not used by the CBOR serializer itself — the caller is
 * expected to round-trip compatible shapes.  For class-preserving
 * round-trips register a dedicated serializer via SerializationExtension.
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
