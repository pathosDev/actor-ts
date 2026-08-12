/**
 * Byte-view hygiene for serializers that hand out bytes they did not
 * allocate themselves — the external binary libraries (Avro, Protobuf, …)
 * and the base64 framing in `JsonTree`.  Both helpers exist because of a
 * concrete behaviour measured on Bun, Node and Deno — not defensiveness.
 *
 * **Pooled output.**  `protobufjs`'s `Writer.finish()` returns a view into
 * a shared write pool, not a standalone buffer: in one sample run the
 * 7-byte result had `byteOffset` 5976 of a 65536-byte pool on Node and
 * `byteOffset` 152 of an 8192-byte pool on Deno (Bun happened to hand back
 * an exact buffer).  Anything that reads `.buffer` without honouring
 * `byteOffset`/`byteLength` therefore sees *other messages' bytes*, and
 * holding the view alive pins the whole pool.  A serializer's output is
 * handed to a journal row and outlives the pool, so it must own its bytes.
 *
 * **Pooled input.**  `Buffer.from(str, 'base64')` does the same thing on
 * the way in, and unlike protobufjs it is not a library quirk but the
 * documented `Buffer` allocator: on Node and Deno *every* decode from 1
 * byte to 8 KB came back as a view into the pool.  That is the read half
 * of the same hazard (#619) and the reason `fromBase64` copies.
 *
 * **`Buffer`-only decoders.**  `avsc` reaches for `Buffer`-private methods
 * inside `fromBuffer`, so a plain `Uint8Array` — exactly what the base64
 * framing in `PayloadCodec` produces on the read path — fails with
 * `this.buf.utf8Slice is not a function` on all three runtimes.  Encoding
 * works, decoding does not, which makes it a trap that only shows up on
 * replay.
 */

/**
 * Return a plain `Uint8Array` that owns its whole backing buffer.  A view
 * that already qualifies is passed through, so this costs nothing when the
 * library hands back standalone bytes.
 *
 * The copy is `new Uint8Array(n).set(view)`, deliberately not `slice()`:
 * `Buffer#slice` is Node's deprecated alias for `subarray` and returns
 * *another view of the same memory*, so the obvious one-liner silently
 * does nothing for exactly the inputs that need it.  That is not
 * theoretical — with `slice()` this function left protobufjs output at
 * `byteOffset` 28312 of a 65536-byte pool on Node while looking correct
 * on Bun, where the same call happened to land on an exact buffer.
 *
 * A `Buffer` is also normalised away rather than returned as-is: it is a
 * `Uint8Array` subclass with its own `toJSON`, so letting one escape makes
 * the encoded output depend on which runtime produced it.
 */
export function ownedBytes(view: Uint8Array): Uint8Array {
  const ownsExactBuffer = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength;
  if (ownsExactBuffer && view.constructor === Uint8Array) return view;
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}

/**
 * Present `bytes` as a Node `Buffer` for libraries that need one, without
 * copying: `Buffer.from(arrayBuffer, offset, length)` wraps the existing
 * memory.  On a runtime with no `Buffer` global the input is passed
 * through unchanged — the caller's library either ships its own shim or
 * fails with its own message, which beats a synthetic one from here.
 */
export function asNodeBuffer(bytes: Uint8Array): Uint8Array {
  if (typeof Buffer === 'undefined' || Buffer.isBuffer(bytes)) return bytes;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
