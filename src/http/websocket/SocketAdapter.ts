/**
 * Backend-agnostic socket surface.  Each HTTP backend maps its native
 * WebSocket (the `ws` package's socket for Fastify/Express, Hono's
 * `WSContext`) onto a {@link WebsocketSocketAdapter}, and the shared
 * connection-wiring layer drives everything through this one shape — so
 * frame decoding, size caps, codec handling and lifecycle live in ONE
 * place regardless of backend.
 */

/**
 * Listeners the framework attaches to a socket.  The backend adapter
 * must guarantee that no inbound frame is delivered before
 * {@link WebsocketSocketAdapter.setListeners} returns (attach natively
 * in the same synchronous tick, or buffer until then) — this is what
 * closes the "first frame lost" race by construction.
 */
export interface WebsocketListeners {
  /** One inbound frame, already normalised to text (`string`) or binary (`Uint8Array`). */
  onMessage(data: string | Uint8Array): void;
  onClose(code: number, reason: string): void;
  onError(err: Error): void;
}

/** W3C-style readyState values. */
export const WebsocketReadyState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export interface WebsocketSocketAdapter {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Hard-kill without a close handshake (shutdown).  Falls back to `close()` if absent. */
  terminate?(): void;
  /** Single-shot listener attach — see {@link WebsocketListeners}. */
  setListeners(l: WebsocketListeners): void;
  readonly readyState: 0 | 1 | 2 | 3;
  /** Bytes queued in the peer send buffer, when the backend can report it. */
  bufferedAmount?(): number;
  readonly remoteAddress?: string;
  /** Negotiated `Sec-WebSocket-Protocol`, when known. */
  readonly protocol?: string;
}

/**
 * The `ws` package socket surface (used by `@fastify/websocket`,
 * plain `ws.WebSocketServer`, and `@hono/node-ws`).  Only the members
 * we touch are declared — the peer dep is optional.
 */
export interface WebsocketPackageSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: 'message', cb: (data: unknown, isBinary: boolean) => void): void;
  on(event: 'close', cb: (code: number, reason: unknown) => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
  readonly bufferedAmount?: number;
  readonly readyState?: number;
  readonly protocol?: string;
}

function coerceBinary(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data; // Node Buffer is a Uint8Array
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const total = data.reduce<number>((n, b) => n + (b as { byteLength: number }).byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const part of data) {
      const u8 = new Uint8Array(part as ArrayBufferLike);
      merged.set(u8, off);
      off += u8.byteLength;
    }
    return merged;
  }
  return new Uint8Array(0);
}

function coerceText(data: unknown): string {
  if (typeof data === 'string') return data;
  const bytes = coerceBinary(data);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

type BufferedEvent =
  | { readonly t: 'message'; readonly data: string | Uint8Array }
  | { readonly t: 'close'; readonly code: number; readonly reason: string }
  | { readonly t: 'error'; readonly err: Error };

/**
 * Adapt a `ws`-package socket (already upgraded) to a
 * {@link WebsocketSocketAdapter}.  Native `socket.on(...)` listeners are
 * attached **immediately** (synchronously at upgrade) and inbound events
 * are BUFFERED until `setListeners` runs — because the per-connection
 * actor attaches its listeners a mailbox-tick later, and `ws` would drop
 * events that arrive with no `'message'` listener.  `isBinary` from `ws`
 * decides text-vs-binary delivery.
 */
export function websocketPackageAdapter(
  socket: WebsocketPackageSocket,
  options: { readonly remoteAddress?: string; readonly protocol?: string } = {},
): WebsocketSocketAdapter {
  let listeners: WebsocketListeners | null = null;
  const pending: BufferedEvent[] = [];

  socket.on('message', (data, isBinary) => {
    const norm = isBinary ? coerceBinary(data) : coerceText(data);
    if (listeners) listeners.onMessage(norm);
    else pending.push({ t: 'message', data: norm });
  });
  socket.on('close', (code, reason) => {
    const closeCode = typeof code === 'number' ? code : 1005;
    const reasonText = reason == null ? '' : String(reason);
    if (listeners) listeners.onClose(closeCode, reasonText);
    else pending.push({ t: 'close', code: closeCode, reason: reasonText });
  });
  socket.on('error', (err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    if (listeners) listeners.onError(error);
    else pending.push({ t: 'error', err: error });
  });

  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    terminate: socket.terminate ? () => socket.terminate!() : undefined,
    setListeners: (l) => {
      listeners = l;
      for (const ev of pending.splice(0)) {
        if (ev.t === 'message') l.onMessage(ev.data);
        else if (ev.t === 'close') l.onClose(ev.code, ev.reason);
        else l.onError(ev.err);
      }
    },
    get readyState() {
      return (socket.readyState ?? WebsocketReadyState.OPEN) as 0 | 1 | 2 | 3;
    },
    bufferedAmount: () => socket.bufferedAmount ?? 0,
    remoteAddress: options.remoteAddress,
    protocol: options.protocol ?? socket.protocol,
  };
}
