/**
 * GELF's chunked-UDP encoding.
 *
 * A datagram larger than the path MTU is fragmented by IP, and a single
 * lost fragment costs the whole message with no way for the receiver to
 * say so.  GELF sidesteps that by chunking above the sender, so each
 * datagram stands on its own and the server reassembles by message id.
 *
 * Kept in its own module because the header is a fixed byte layout and
 * that is exactly the kind of thing worth asserting byte for byte in a
 * test, without a socket anywhere near it.
 */

/** `0x1e 0x0f` — how a receiver tells a chunk from a bare GELF message. */
export const GELF_CHUNK_MAGIC = Uint8Array.from([0x1e, 0x0f]);

/** magic (2) + message id (8) + sequence number (1) + sequence count (1). */
export const GELF_CHUNK_HEADER_BYTES = 12;

/**
 * The spec's hard ceiling.  A message needing more than this cannot be
 * sent at all — the sequence number is one byte, and a server is entitled
 * to discard anything beyond it.
 */
export const GELF_MAX_CHUNKS = 128;

/**
 * Default datagram size.
 *
 * 1420 bytes keeps the whole packet — including IP and UDP headers —
 * inside the 1500-byte Ethernet MTU with room to spare for a VPN or
 * tunnel header, which is where the remaining margin usually goes.  A
 * larger value works on a LAN and starts silently fragmenting the moment
 * the traffic crosses anything encapsulated.
 */
export const DEFAULT_GELF_MAX_CHUNK_BYTES = 1420;

/** Raised when a message cannot be sent within {@link GELF_MAX_CHUNKS}. */
export class GelfMessageTooLargeError extends Error {
  constructor(readonly requiredChunks: number) {
    super(
      `GELF message needs ${requiredChunks} chunks, more than the ${GELF_MAX_CHUNKS} the protocol allows; `
      + 'send it over TCP, or reduce what the record carries',
    );
    this.name = 'GelfMessageTooLargeError';
  }
}

/**
 * Split a payload into datagrams.
 *
 * Returns the payload unchanged, as a single datagram, when it fits — an
 * unchunked message is what a receiver prefers, and most records fit.
 */
export function chunkGelfDatagram(
  payload: Uint8Array,
  messageId: Uint8Array,
  maxChunkBytes: number,
): Uint8Array[] {
  if (payload.length <= maxChunkBytes) return [payload];

  const bodyBytes = maxChunkBytes - GELF_CHUNK_HEADER_BYTES;
  const count = Math.ceil(payload.length / bodyBytes);
  if (count > GELF_MAX_CHUNKS) throw new GelfMessageTooLargeError(count);

  const chunks: Uint8Array[] = [];
  for (let sequence = 0; sequence < count; sequence += 1) {
    const start = sequence * bodyBytes;
    const body = payload.subarray(start, start + bodyBytes);
    const chunk = new Uint8Array(GELF_CHUNK_HEADER_BYTES + body.length);
    chunk.set(GELF_CHUNK_MAGIC, 0);
    chunk.set(messageId.subarray(0, 8), 2);
    chunk[10] = sequence;
    chunk[11] = count;
    chunk.set(body, GELF_CHUNK_HEADER_BYTES);
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * Eight random bytes identifying one message across its chunks.
 *
 * Crypto-grade rather than `Math.random`: a collision inside a server's
 * five-second reassembly window splices two unrelated messages together,
 * and the identifier is attacker-visible on the wire.  This is the
 * project's standing rule for wire identifiers.
 */
export function newGelfMessageId(): Uint8Array {
  const id = new Uint8Array(8);
  globalThis.crypto.getRandomValues(id);
  return id;
}
