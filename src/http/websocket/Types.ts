/**
 * Core WebSocket wire types + frame helpers, shared by the server-side
 * routing directive (`websocket()`), the internal per-connection session
 * actor, and the client-side `WebsocketClientActor`.
 *
 * Kept dependency-free (no actor / http imports) so every layer can pull
 * it in without a cycle.
 */

/** A single WebSocket frame — either a UTF-8 text frame or a binary frame. */
export type WebsocketFrame =
  | { readonly kind: 'text'; readonly data: string }
  | { readonly kind: 'binary'; readonly data: Uint8Array };

/**
 * Snapshot of the HTTP upgrade request, exposed on every connection so
 * handlers can read the path, params, query, headers and negotiated
 * subprotocol without holding a backend-specific request object.
 */
export type WebsocketUpgradeInfo = {
  readonly path: string;
  /** Path parameters extracted from `/room/:id`-style patterns. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | string[] | undefined>>;
  readonly headers: Readonly<Record<string, string>>;
  /** Remote peer address as the server saw it (not `x-forwarded-for`). */
  readonly remoteAddress?: string;
  /** Negotiated `Sec-WebSocket-Protocol`, if any. */
  readonly subprotocol?: string;
};

/** Why/how a connection closed — delivered to disconnect hooks. */
export type WebsocketCloseInfo = {
  readonly code: number;
  readonly reason: string;
  readonly initiatedBy: 'client' | 'server' | 'error';
};

/**
 * UTF-8 byte length of a string without allocating a `Uint8Array`.
 * `TextEncoder.encode` would allocate a buffer we'd immediately discard;
 * for the size check alone we hand-roll the byte count, which is the
 * common (small-message) case.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    if (charCode < 0x80) bytes += 1;
    else if (charCode < 0x800) bytes += 2;
    else if (charCode >= 0xd800 && charCode <= 0xdbff) {
      // High surrogate → 4-byte sequence; consume the low surrogate too.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Payload size of a frame in bytes (UTF-8 length for text). */
export function frameByteLength(frame: WebsocketFrame): number {
  return frame.kind === 'text' ? utf8ByteLength(frame.data) : frame.data.byteLength;
}

/**
 * Normalise a raw inbound payload from any backend socket into a
 * {@link WebsocketFrame}.  Handles every shape the supported backends deliver:
 *
 *   - `string`                      → text frame
 *   - `ArrayBuffer`                 → binary frame
 *   - `Uint8Array` / Node `Buffer`  → binary frame
 *   - `Array<Buffer>` (fragmented)  → merged binary frame (the `ws`
 *                                     package delivers fragments this way)
 *
 * **`Blob` is deliberately not on that list.**  A native client `WebSocket`
 * delivers one whenever `binaryType` is `'blob'`, which is the default on Node
 * and Deno — and a `Blob` yields its bytes only through `arrayBuffer()`, so a
 * branch for it would make this function async and, with it, every caller's
 * inbound path.  That is not affordable there: it would put the frame-size
 * check behind a microtask and stop guaranteeing that frames are handed on in
 * arrival order.  The invariant that keeps a `Blob` from reaching here is set
 * at the socket instead — `WebsocketClientActor.requestArrayBufferPayloads`,
 * which reasons the trade-off out in full, and the server backends' adapters,
 * whose `onMessage` is typed `string | Uint8Array`.  If a `Blob` ever does
 * arrive, it lands on the `null` path below, and the client's report of that
 * names the shape.
 *
 * Returns `null` for shapes we don't recognise (caller logs + drops).
 */
export function normalizeInbound(data: unknown): WebsocketFrame | null {
  if (typeof data === 'string') return { kind: 'text', data };
  if (data instanceof ArrayBuffer) return { kind: 'binary', data: new Uint8Array(data) };
  if (data instanceof Uint8Array) return { kind: 'binary', data };
  if (Array.isArray(data)) {
    const total = data.reduce<number>((n, b) => n + (b as { byteLength: number }).byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const part of data) {
      const u8 = new Uint8Array(part as ArrayBufferLike);
      merged.set(u8, off);
      off += u8.byteLength;
    }
    return { kind: 'binary', data: merged };
  }
  if (data && typeof (data as { byteLength?: number }).byteLength === 'number') {
    return { kind: 'binary', data: new Uint8Array(data as ArrayBufferLike) };
  }
  return null;
}
