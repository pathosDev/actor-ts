/**
 * Tuned values shared across the serialization subsystem.
 *
 * The decoder guards live here rather than beside the codec because they
 * are caps, not format: a CBOR tag number defines what a byte *means* and
 * belongs in `CborCodec.ts`, while a depth or size ceiling only says how
 * much of it this process will tolerate.
 *
 * This module imports nothing, so it can never close an import cycle —
 * the same property `XOptions.ts` has by construction.
 */

/**
 * Ceiling on container nesting for the ENCODER, and the ceiling the read side
 * may be tuned down from but never past.  The decoder recurses once per array,
 * map and tag level, so without a bound a couple of hundred KB of `0x81` bytes
 * exhausts the JS stack (#618); the encoder measures the same levels so it
 * cannot write something its own decoder would refuse (#1036).  Real payloads
 * are shallow; anything near this is malformed or hostile.
 *
 * It stays a hard constant on the write half deliberately.  What a node
 * *accepts* is a security posture and belongs in config — that half is
 * `actor-ts.serialization.read-constraints.max-nesting-depth`, whose built-in
 * default is this value (#880).  What a node *emits* is a wire contract its
 * peers decode, so making it settable would let one misconfigured member write
 * frames the rest of the cluster refuses; `ReadConstraintsOptionsValidator`
 * enforces the resulting one-way relation, `read <= write`.
 */
export const MAX_NESTING_DEPTH = 256;

/**
 * Ceiling on the byte length of a tag 2 / tag 3 bignum magnitude, i.e.
 * 8192-bit integers.  Comfortably above anything a real message carries — an
 * RSA-4096 modulus is 512 bytes — and the cost of rebuilding one is now
 * linear anyway, so this is a backstop rather than the fix.
 */
export const MAX_BIGNUM_BYTES = 1024;

/**
 * First id a user-defined serializer may claim; 1..99 belong to the
 * built-ins.  The shipped schema serializers reject anything below it at
 * construction: an id is a wire contract that outlives the process, so a
 * collision with JSON or CBOR would only surface when stored rows stop
 * decoding.
 */
export const RESERVED_SERIALIZER_IDS_BELOW = 100;
