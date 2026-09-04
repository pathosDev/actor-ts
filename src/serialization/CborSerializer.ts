import { CborDecoder, CborEncoder } from './CborCodec.js';
import {
  defaultReadConstraintsOptions,
  ReadConstraintsOptionsValidator,
  type ReadConstraintsOptions,
  type ReadConstraintsOptionsType,
} from './ReadConstraintsOptions.js';
import { SerializationError, type Serializer } from './Serializer.js';

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
  /** Ceilings handed to every {@link CborDecoder} this serializer builds. */
  private readonly constraints: Required<ReadConstraintsOptionsType>;

  /**
   * Read constraints are optional and default to the built-ins, so every
   * `new CborSerializer()` in the tree keeps working; `SerializationExtension`
   * is what hands over what config resolved to.
   */
  constructor(readConstraints: ReadConstraintsOptions = {}) {
    this.constraints = {
      ...defaultReadConstraintsOptions,
      ...(readConstraints as Partial<ReadConstraintsOptionsType>),
    };
    new ReadConstraintsOptionsValidator().validate(this.constraints);
  }

  manifest(_obj: unknown): string { return ''; }

  toBinary(obj: unknown): Uint8Array {
    return new CborEncoder().encode(obj);
  }

  fromBinary(bytes: Uint8Array, _manifest: string): unknown {
    // Before the decoder is even built: a document ceiling that fired mid-decode
    // would already have paid for the allocations it exists to refuse.
    const ceiling = this.constraints.maxDocumentBytes;
    if (ceiling > 0 && bytes.byteLength > ceiling) {
      throw new SerializationError(
        `CborSerializer: document of ${bytes.byteLength} bytes exceeds maxDocumentBytes ${ceiling}`,
      );
    }
    return new CborDecoder(this.constraints).decode(bytes);
  }
}
