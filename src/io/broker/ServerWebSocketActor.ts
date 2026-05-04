import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { WebSocketCmd, WebSocketFrame } from './WebSocketActor.js';

/**
 * Server-side counterpart to {@link WebSocketActor} (#1).  Wraps an
 * already-upgraded WebSocket — typically handed in by a Fastify /
 * Hono / Bun.serve upgrade handler — and bridges its lifecycle into
 * the actor system.
 *
 * **Why a separate actor instead of teaching `WebSocketActor` to be
 * dual-mode?**  The two halves have fundamentally different
 * lifecycle assumptions:
 *
 *   - `WebSocketActor` (client) dials a URL, owns reconnect-backoff,
 *     buffers outbound while disconnected, retries.  The remote peer
 *     is the server; we drive the connection.
 *   - `ServerWebSocketActor` is handed a connected socket whose
 *     lifecycle is owned by the *client*.  When the client goes
 *     away, the actor's job is over — there's nothing to "reconnect"
 *     to.  Reconnect-backoff and outbound buffering across reconnects
 *     would be incorrect.
 *
 * The shared piece is the message envelope (`WebSocketFrame`) and the
 * outbound command shape (`WebSocketCmd`); we re-export those rather
 * than duplicate the types.
 *
 * **Lifecycle.**
 *
 *   - On `preStart`, registers `message` / `close` / `error`
 *     listeners.  Inbound frames are forwarded to `target` as
 *     `WebSocketFrame`s (text / binary).
 *   - On socket `close`, the actor stops itself by default
 *     (`stopOnSocketClose: true`); flip the flag to keep the actor
 *     alive — useful when you want to handle the close yourself
 *     (e.g. log + emit a domain event).
 *   - On `postStop`, the socket is closed.  Idempotent — closing an
 *     already-closed socket is a no-op.
 *
 * **Outbound** flows through the same `WebSocketCmd` shape as the
 * client actor, so handlers written against one work against the
 * other.  No buffering — sends fail loud if the socket is closed.
 *
 *   import { ServerWebSocketActor, bunWebSocketHandler } from 'actor-ts';
 *
 *   Bun.serve({
 *     port: 3000,
 *     fetch: bunWebSocketHandler(system, '/ws', {
 *       onOpen: (ws, ref, _ctx) => {
 *         // ref is the actor reference.  Subscribe it to a chat room, etc.
 *         chatRoom.tell({ kind: 'join', client: ref });
 *       },
 *     }),
 *     websocket: { /* placeholder, filled by bunWebSocketHandler */ /*},
 *   });
 */

/** Re-export so callers don't have to import from two places. */
export type { WebSocketCmd, WebSocketFrame } from './WebSocketActor.js';

export interface ServerWebSocketActorOptions {
  /** Subscriber that receives every inbound text/binary frame. */
  readonly target?: ActorRef<WebSocketFrame>;
  /**
   * Stop the actor when the socket closes.  Default `true` — the
   * usual case where the actor exists solely to bridge one
   * connection.  Flip to `false` to handle close yourself
   * (e.g. when an outer supervisor wants to react before teardown).
   */
  readonly stopOnSocketClose?: boolean;
  /**
   * Optional callback fired when the socket emits an error.  Useful
   * for backend-specific telemetry; the actor still proceeds to
   * stop unless you turn `stopOnSocketClose` off.
   */
  readonly onError?: (err: Error) => void;
}

/**
 * Minimal socket surface the actor depends on.  Bun's native
 * `ServerWebSocket`, the `ws` package's `WebSocket`, and the W3C
 * `WebSocket` all satisfy it.  Adapter helpers normalise the small
 * shape differences.
 */
export interface ServerWebSocketLike {
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: 'message', cb: (ev: { data: unknown }) => void): void;
  addEventListener(event: 'close', cb: () => void): void;
  addEventListener(event: 'error', cb: (ev: unknown) => void): void;
  removeEventListener?(event: string, cb: (...args: never[]) => void): void;
  /**
   * Optional readyState — when present we skip `send` on a closing
   * socket so we don't queue a 'send after close' error in tests.
   */
  readonly readyState?: number;
}

export class ServerWebSocketActor extends Actor<WebSocketCmd> {
  private readonly socket: ServerWebSocketLike;
  private readonly opts: ServerWebSocketActorOptions;
  private closed = false;

  // Pinned listener refs so `removeEventListener` (where supported)
  // can detach them on stop.
  private readonly onMessage = (ev: { data: unknown }): void => this.handleMessage(ev.data);
  private readonly onClose = (): void => this.handleClose();
  private readonly onErrorEvent = (ev: unknown): void => this.handleError(ev);

  constructor(socket: ServerWebSocketLike, opts: ServerWebSocketActorOptions = {}) {
    super();
    this.socket = socket;
    this.opts = opts;
  }

  override preStart(): void {
    this.log.debug('ServerWebSocketActor: attached to socket');
    this.socket.addEventListener('message', this.onMessage);
    this.socket.addEventListener('close', this.onClose);
    this.socket.addEventListener('error', this.onErrorEvent);
  }

  override postStop(): void {
    if (this.socket.removeEventListener) {
      try {
        this.socket.removeEventListener('message', this.onMessage as never);
        this.socket.removeEventListener('close', this.onClose as never);
        this.socket.removeEventListener('error', this.onErrorEvent as never);
      } catch { /* ignore — best-effort detach */ }
    }
    if (!this.closed) {
      this.closed = true;
      try { this.socket.close(); } catch { /* already closed */ }
    }
  }

  override onReceive(cmd: WebSocketCmd): void {
    if (this.closed) {
      this.log.debug('ServerWebSocketActor: send after close — ignored');
      return;
    }
    try {
      if (cmd.kind === 'send') {
        this.log.debug(
          `ServerWebSocketActor: send ${cmd.frame.kind} frame (${cmd.frame.kind === 'text' ? `${cmd.frame.data.length} chars` : `${cmd.frame.data.byteLength} bytes`})`,
        );
        this.send(cmd.frame);
      } else if (cmd.kind === 'sendText') {
        this.log.debug(`ServerWebSocketActor: send text (${cmd.data.length} chars)`);
        this.socket.send(cmd.data);
      } else {
        this.log.debug(`ServerWebSocketActor: send binary (${cmd.data.byteLength} bytes)`);
        this.socket.send(cmd.data);
      }
    } catch (err) {
      this.log.warn(`ServerWebSocketActor: send failed: ${(err as Error).message}`);
    }
  }

  /* ------------------------------ inbound ------------------------------- */

  private send(frame: WebSocketFrame): void {
    if (frame.kind === 'text') this.socket.send(frame.data);
    else this.socket.send(frame.data);
  }

  private handleMessage(data: unknown): void {
    const target = this.opts.target;
    if (!target) return;
    if (typeof data === 'string') {
      this.log.debug(`ServerWebSocketActor: recv text (${data.length} chars)`);
      target.tell({ kind: 'text', data });
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.log.debug(`ServerWebSocketActor: recv binary (${data.byteLength} bytes)`);
      target.tell({ kind: 'binary', data: new Uint8Array(data) });
      return;
    }
    if (data instanceof Uint8Array) {
      this.log.debug(`ServerWebSocketActor: recv binary (${data.byteLength} bytes)`);
      target.tell({ kind: 'binary', data });
      return;
    }
    // ws-lib delivers a Buffer (which is a Uint8Array subtype) or
    // arrays of Buffer chunks for fragmented messages — coerce.
    if (Array.isArray(data)) {
      const total = data.reduce<number>((n, b) => n + (b as { byteLength: number }).byteLength, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const part of data) {
        const u8 = new Uint8Array(part as ArrayBufferLike);
        merged.set(u8, off);
        off += u8.byteLength;
      }
      target.tell({ kind: 'binary', data: merged });
      return;
    }
    if (data && typeof (data as { byteLength?: number }).byteLength === 'number') {
      target.tell({ kind: 'binary', data: new Uint8Array(data as ArrayBufferLike) });
      return;
    }
    this.log.warn(`ServerWebSocketActor: unrecognised inbound frame type (${typeof data})`);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.log.debug('ServerWebSocketActor: socket closed');
    this.closed = true;
    if (this.opts.stopOnSocketClose ?? true) {
      this.context.stopSelf();
    }
  }

  private handleError(ev: unknown): void {
    const err = ev instanceof Error
      ? ev
      : new Error(typeof ev === 'string' ? ev : 'WebSocket error');
    this.log.warn(`ServerWebSocketActor: ${err.message}`);
    try { this.opts.onError?.(err); } catch { /* user code throwing in onError shouldn't kill us */ }
  }
}
