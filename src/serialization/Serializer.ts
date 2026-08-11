/**
 * Serializers encode values into bytes for transport between nodes and for
 * persistence.  The contract is intentionally small so that custom formats
 * (Protobuf, Avro, msgpack, …) slot in as plug-ins without touching core.
 */
export interface Serializer<T = unknown> {
  /**
   * Stable identifier that is embedded in every frame.  Numbers 1..99 are
   * reserved for the actor-ts built-ins (JSON=1, CBOR=2).  User-defined
   * serializers SHOULD use IDs ≥ {@link RESERVED_SERIALIZER_IDS_BELOW}.
   */
  readonly id: number;

  /** Human-readable name, surfaced in diagnostics. */
  readonly name: string;

  /** True when this serializer is willing to encode the given value. */
  includesManifest: boolean;

  /**
   * Return a tag describing the concrete type of `obj` so the decoder knows
   * how to reconstruct it.  Typical values: class name, event ID, "map",
   * "null", etc.  May return an empty string for serializers that don't
   * need a manifest.
   */
  manifest(obj: T): string;

  /** Encode to binary. */
  toBinary(obj: T): Uint8Array;

  /**
   * Decode from binary.  `manifest` is whatever was produced on the other
   * side (or '' when the serializer does not use one).
   */
  fromBinary(bytes: Uint8Array, manifest: string): T;
}

/**
 * First id a user-defined serializer may claim; 1..99 belong to the
 * built-ins.  The shipped schema serializers reject anything below it at
 * construction: an id is a wire contract that outlives the process, so a
 * collision with JSON or CBOR would only surface when stored rows stop
 * decoding.
 */
export const RESERVED_SERIALIZER_IDS_BELOW = 100;

/**
 * Marker payload emitted whenever a serializer round-trips a value through
 * the wire — exposed for debugging tools and wire-level tests.
 */
export type SerializedValue = {
  readonly serializerId: number;
  readonly manifest: string;
  readonly bytes: Uint8Array;
};

export class SerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerializationError';
  }
}
