/**
 * Binary WebSocket frame envelope for voice audio.
 *
 *   client → server : raw Opus chunk, no header.  The server already
 *                     knows the sender from the authenticated session.
 *
 *   server → client : `[u8 nameLen][utf-8 username][opus bytes...]`
 *                     — identifies the speaker so the receiver can
 *                     route the chunk to the right per-sender
 *                     `MediaSource` / `SourceBuffer`.  Essential in
 *                     room mode where multiple speakers can stream
 *                     concurrently and a single binary WS frame
 *                     would otherwise be ambiguous.
 *
 * 1-byte length prefix is enough: this sample's usernames are all
 * <= 16 chars; even doubling that fits in a byte.  Throw on >255 so
 * we'd notice if anyone fed it wider data.
 *
 * Returns `null` from `decodeIncoming` for any malformed buffer
 * (too short, length-prefix exceeds payload).  Callers should drop
 * the frame and continue.
 */

export function encodeIncoming(senderUsername: string, opus: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(senderUsername);
  if (nameBytes.length > 255) {
    throw new Error(
      `frame envelope: username '${senderUsername}' is ${nameBytes.length} bytes, max 255`,
    );
  }
  const out = new Uint8Array(1 + nameBytes.length + opus.byteLength);
  out[0] = nameBytes.length;
  out.set(nameBytes, 1);
  out.set(opus, 1 + nameBytes.length);
  return out;
}

export interface DecodedFrame {
  readonly sender: string;
  readonly opus: Uint8Array;
}

export function decodeIncoming(buffer: Uint8Array): DecodedFrame | null {
  if (buffer.byteLength < 1) return null;
  const nameLen = buffer[0]!;
  if (buffer.byteLength < 1 + nameLen) return null;
  const sender = new TextDecoder().decode(buffer.subarray(1, 1 + nameLen));
  const opus = buffer.subarray(1 + nameLen);
  return { sender, opus };
}
