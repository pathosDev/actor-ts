import { match } from 'ts-pattern';
import {
  DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_BYTES,
  DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_FRAMES,
} from '../Constants.js';
import { utf8ByteLength } from './Types.js';

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
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): void;
  on(event: 'close', listener: (code: number, reason: unknown) => void): void;
  on(event: 'error', listener: (err: unknown) => void): void;
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

type BufferedMessageEvent = { readonly kind: 'message'; readonly data: string | Uint8Array };
type BufferedCloseEvent = { readonly kind: 'close'; readonly code: number; readonly reason: string };
type BufferedErrorEvent = { readonly kind: 'error'; readonly error: Error };
type BufferedEvent = BufferedMessageEvent | BufferedCloseEvent | BufferedErrorEvent;

/**
 * A {@link WebsocketListeners} that holds events until the real listeners
 * arrive, then replays them in order.
 */
export interface BufferedWebsocketEvents extends WebsocketListeners {
  /** Attach the real listeners and flush whatever arrived before them. */
  attach(listeners: WebsocketListeners): void;
}

/**
 * How much a pre-attach buffer may hold before the connection is refused.
 *
 * Both halves are needed and neither implies the other: a frame count alone
 * bounds nothing when one frame may be a megabyte, and a byte budget alone
 * lets an attacker queue millions of empty frames for the per-entry overhead.
 *
 * A plain record rather than an options family because it is not configured
 * here — it is the transport-side projection of the route policy's
 * `maxPreAttachFrames` / `maxPreAttachBytes`, carried down through
 * `WebsocketRouteRegistration` so a backend can build its adapter before any
 * of the actor machinery exists.
 */
export type PreAttachBufferLimits = {
  readonly maxFrames: number;
  readonly maxBytes: number;
};

/**
 * The limits an adapter built without a route policy uses.
 *
 * Derived from the two constants rather than repeating their numbers, so the
 * fallback and the policy default can never drift apart.  It has to be derived
 * *here* rather than beside them: `src/http/Constants.ts` imports nothing on
 * purpose, and this shape is declared in this file.
 */
export const DEFAULT_PRE_ATTACH_BUFFER_LIMITS: PreAttachBufferLimits = {
  maxFrames: DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_FRAMES,
  maxBytes: DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_BYTES,
};

/**
 * The buffer every backend adapter needs between the native socket going
 * live and `setListeners` running — the window the
 * {@link WebsocketListeners} contract talks about.  It is one function
 * rather than a per-adapter array because an adapter that buffers only
 * *some* event kinds is worse than one that buffers none: a dropped
 * `close` never stops the connection actor, never removes it from the
 * hub, and never returns its `maxConnections` slot, so the leak is
 * permanent and silent.  That is what happened on Hono (#570), which
 * hand-rolled a message-only queue.
 *
 * **Bounded, because the drain is not guaranteed (#717).**  `attach` is the
 * only thing that empties this, and it runs from the connection actor's
 * `preStart` — an actor the wiring layer asks the hub to spawn and then stops
 * tracking.  A hub that was stopped, or one whose queue the accept never
 * survived, leaves a socket whose buffer nothing will ever drain while the
 * peer keeps feeding it.  So the buffer refuses the connection instead of
 * growing: `onOverflow` closes the socket, everything held is released, and a
 * single synthetic close is left behind so an actor that spawns later still
 * learns the connection is gone and unwinds its `maxConnections` slot.
 *
 * Only **messages** are metered.  `close` and `error` arrive at most once
 * each, are a few bytes, and dropping either is precisely the permanent leak
 * #570 was filed for — so they are always held, even past the cap.
 *
 * The **first** message is always admitted whatever its size.  One frame is
 * already bounded by the transport payload limit the backend installs
 * (`transportFrameCapOf`, derived from the routes' own `maxFrameBytes`), so
 * admitting it costs nothing the operator has not already accepted — and it
 * means raising `maxFrameBytes` past `maxPreAttachBytes` cannot turn a lone
 * oversized greeting into a refused connection.
 */
export function bufferWebsocketEvents(
  limits: PreAttachBufferLimits,
  onOverflow: () => void,
): BufferedWebsocketEvents {
  let listeners: WebsocketListeners | null = null;
  const pending: BufferedEvent[] = [];
  /** Metered apart from `pending.length`: close/error do not spend budget. */
  let bufferedFrames = 0;
  let bufferedBytes = 0;
  let overflowed = false;

  const overflow = (): void => {
    overflowed = true;
    bufferedFrames = 0;
    bufferedBytes = 0;
    // Replace, not append: the connection never became live, so replaying a
    // truncated prefix of its inbound stream to an actor that spawns after the
    // refusal is worse than telling it the connection is gone.
    pending.splice(0, pending.length, {
      kind: 'close',
      code: 1013,
      reason: 'connection setup buffer overflow',
    });
    onOverflow();
  };

  const admits = (bytes: number): boolean =>
    bufferedFrames === 0
    || (bufferedFrames + 1 <= limits.maxFrames && bufferedBytes + bytes <= limits.maxBytes);

  return {
    onMessage: (data) => {
      if (listeners) {
        listeners.onMessage(data);
        return;
      }
      if (overflowed) return;
      const bytes = typeof data === 'string' ? utf8ByteLength(data) : data.byteLength;
      if (!admits(bytes)) {
        overflow();
        return;
      }
      bufferedFrames += 1;
      bufferedBytes += bytes;
      pending.push({ kind: 'message', data });
    },
    onClose: (code, reason) => {
      if (listeners) {
        listeners.onClose(code, reason);
        return;
      }
      // The synthetic close already stands, and the peer's answer to the close
      // we sent is what arrives here — a second one would stop the actor twice.
      if (overflowed) return;
      pending.push({ kind: 'close', code, reason });
    },
    onError: (error) => {
      if (listeners) {
        listeners.onError(error);
        return;
      }
      if (overflowed) return;
      pending.push({ kind: 'error', error });
    },
    attach: (incoming) => {
      listeners = incoming;
      bufferedFrames = 0;
      bufferedBytes = 0;
      for (const event of pending.splice(0)) {
        match(event)
          .with({ kind: 'message' }, (e) => incoming.onMessage(e.data))
          .with({ kind: 'close' }, (e) => incoming.onClose(e.code, e.reason))
          .with({ kind: 'error' }, (e) => incoming.onError(e.error))
          .exhaustive();
      }
    },
  };
}

/**
 * Adapt a `ws`-package socket (already upgraded) to a
 * {@link WebsocketSocketAdapter}.  Native `socket.on(...)` listeners are
 * attached **immediately** (synchronously at upgrade) and inbound events
 * are BUFFERED until `setListeners` runs — because the per-connection
 * actor attaches its listeners a mailbox-tick later, and `ws` would drop
 * events that arrive with no `'message'` listener.  `isBinary` from `ws`
 * decides text-vs-binary delivery.
 *
 * `preAttachBuffer` is the route's resolved bound on that buffer, handed down
 * through `WebsocketRouteRegistration`.  It is optional so an adapter can
 * still be built with no route behind it, and the fallback is a real bound
 * rather than none: an unbounded buffer is the defect (#717), so forgetting
 * to pass the policy must cost accuracy, not the guarantee.
 */
export function websocketPackageAdapter(
  socket: WebsocketPackageSocket,
  options: {
    readonly remoteAddress?: string;
    readonly protocol?: string;
    readonly preAttachBuffer?: PreAttachBufferLimits;
  } = {},
): WebsocketSocketAdapter {
  const events = bufferWebsocketEvents(
    options.preAttachBuffer ?? DEFAULT_PRE_ATTACH_BUFFER_LIMITS,
    () => {
      try {
        socket.close(1013, 'connection setup buffer overflow');
      } catch {
        /* already closing / closed */
      }
    },
  );

  socket.on('message', (data, isBinary) => {
    events.onMessage(isBinary ? coerceBinary(data) : coerceText(data));
  });
  socket.on('close', (code, reason) => {
    events.onClose(typeof code === 'number' ? code : 1005, reason == null ? '' : String(reason));
  });
  socket.on('error', (err) => {
    events.onError(err instanceof Error ? err : new Error(String(err)));
  });

  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    terminate: socket.terminate ? () => socket.terminate!() : undefined,
    setListeners: (l) => events.attach(l),
    get readyState() {
      return (socket.readyState ?? WebsocketReadyState.OPEN) as 0 | 1 | 2 | 3;
    },
    bufferedAmount: () => socket.bufferedAmount ?? 0,
    remoteAddress: options.remoteAddress,
    protocol: options.protocol ?? socket.protocol,
  };
}
