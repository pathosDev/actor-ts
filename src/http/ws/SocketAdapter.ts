/**
 * Backend-agnostic socket surface.  Each HTTP backend maps its native
 * WebSocket (the `ws` package's socket for Fastify/Express, Hono's
 * `WSContext`) onto a {@link WebSocketSocketAdapter}, and the shared
 * connection-wiring layer drives everything through this one shape — so
 * frame decoding, size caps, codec handling and lifecycle live in ONE
 * place regardless of backend.
 */

/**
 * Listeners the framework attaches to a socket.  The backend adapter
 * must guarantee that no inbound frame is delivered before
 * {@link WebSocketSocketAdapter.setListeners} returns (attach natively
 * in the same synchronous tick, or buffer until then) — this is what
 * closes the "first frame lost" race by construction.
 */
export interface WebSocketListeners {
  /** One inbound frame, already normalised to text (`string`) or binary (`Uint8Array`). */
  onMessage(data: string | Uint8Array): void;
  onClose(code: number, reason: string): void;
  onError(err: Error): void;
}

/** W3C-style readyState values. */
export const WsReadyState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export interface WebSocketSocketAdapter {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Hard-kill without a close handshake (shutdown).  Falls back to `close()` if absent. */
  terminate?(): void;
  /** Single-shot listener attach — see {@link WebSocketListeners}. */
  setListeners(l: WebSocketListeners): void;
  readonly readyState: 0 | 1 | 2 | 3;
  /** Bytes queued in the peer send buffer, when the backend can report it. */
  bufferedAmount?(): number;
  readonly remoteAddress?: string;
  /** Negotiated `Sec-WebSocket-Protocol`, when known. */
  readonly protocol?: string;
}
