/**
 * Internal per-connection actor — a genuine child of the
 * {@link WebsocketServerActor} hub (spawned via the hub's context, so
 * the actor tree is `server → conn-1, conn-2, …`).  Users never see or
 * manage it.
 *
 * It owns the whole communication for one connection:
 *   - inbound: attaches the socket listeners in `preStart`, size-caps +
 *     decodes each frame, and forwards the decoded message to the hub
 *     with this connection as the sender;
 *   - outbound: its mailbox is the connection's write queue — a
 *     {@link WebsocketConnection}'s `tell` / `sendRaw` / `close` enqueue here,
 *     and it encodes + writes to the socket (with a backpressure check).
 *     `abort` does not queue: it shuts the socket on the caller's stack and
 *     stops this actor ahead of the queue (`abortConnection`);
 *   - lifecycle: on socket close it stops itself; `postStop` reports the
 *     disconnect to the hub exactly once and closes the socket.
 *
 * The hub supervises these with `stoppingStrategy` — a crashed
 * connection stops (and `postStop` still reports the disconnect) rather
 * than restarting into a dead socket.
 */
import { match } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import { WebsocketReadyState, type WebsocketSocketAdapter } from './SocketAdapter.js';
import { WebsocketDecodeError, type WebsocketCodec } from './WebsocketCodec.js';
import {
  WebsocketConnectionImplementation,
  type CloseCommand,
  type OutCommand,
  type OutRawCommand,
  type WebsocketConnection,
  type WebsocketOutboundCommand,
} from './WebsocketConnection.js';
import {
  websocketConnectedSignal,
  websocketDataSignal,
  websocketDisconnectedSignal,
  websocketInvalidSignal,
  type WebsocketServerRef,
} from './WebsocketMessages.js';
import type { ResolvedWebsocketPolicy } from './WebsocketPolicy.js';
import {
  frameByteLength,
  normalizeInbound,
  type WebsocketCloseInfo,
  type WebsocketFrame,
  type WebsocketUpgradeInfo,
} from './Types.js';

export type WebsocketConnectionDeps<TOut, TIn, TSelf> = {
  readonly socket: WebsocketSocketAdapter;
  readonly codec: WebsocketCodec<TOut, TIn>;
  readonly policy: ResolvedWebsocketPolicy;
  readonly hub: WebsocketServerRef<TOut, TIn, TSelf>;
  readonly id: string;
  readonly upgrade: WebsocketUpgradeInfo;
};

export class WebsocketConnectionActor<TOut, TIn, TSelf = never>
  extends Actor<WebsocketOutboundCommand<TOut>> {

  private readonly d: WebsocketConnectionDeps<TOut, TIn, TSelf>;
  private connection: WebsocketConnection<TOut> | null = null;
  private closed = false;
  private disconnectReported = false;
  private closeInfo: WebsocketCloseInfo | null = null;

  constructor(deps: WebsocketConnectionDeps<TOut, TIn, TSelf>) {
    super();
    this.d = deps;
  }

  override preStart(): void {
    const connection = new WebsocketConnectionImplementation<TOut>(
      this.d.id,
      this.d.upgrade,
      this.d.socket,
      this.self,
      this.system.name,
      (code, reason) => this.abortConnection(code, reason),
    );
    this.connection = connection;
    // Tell the hub 'connected' BEFORE attaching listeners, so it is
    // mailbox-ordered before any inbound data flushed by setListeners.
    this.d.hub.tell(websocketConnectedSignal<TOut>(connection), connection);
    this.d.socket.setListeners({
      onMessage: (data) => this.handleInbound(data),
      onClose: (code, reason) => this.handleClose(code, reason),
      onError: (err) => this.log.warn(`WebsocketConnectionActor ${this.d.id}: socket error: ${err.message}`),
    });
  }

  override onReceive(command: WebsocketOutboundCommand<TOut>): void {
    if (this.closed) {
      this.log.debug(`WebsocketConnectionActor ${this.d.id}: command after close — ignored`);
      return;
    }
    match(command)
      .with({ kind: 'out' }, (c) => this.onOut(c))
      .with({ kind: 'out-raw' }, (c) => this.onOutRaw(c))
      .with({ kind: 'close' }, (c) => this.onClose(c))
      .exhaustive();
  }

  /* --------------------- dispatch arm handlers -------------------- */

  /**
   * A failed encode drops the one message rather than crashing the
   * connection: the socket is still healthy, and taking it down would
   * punish every other message queued behind this one.
   */
  private onOut(command: OutCommand<TOut>): void {
    let frame: WebsocketFrame;
    try {
      frame = this.d.codec.encode(command.message);
    } catch (err) {
      this.log.error(`WebsocketConnectionActor ${this.d.id}: encode failed, dropping message: ${(err as Error).message}`);
      return;
    }
    this.write(frame);
  }

  private onOutRaw(command: OutRawCommand): void {
    this.write(command.frame);
  }

  private onClose(command: CloseCommand): void {
    this.closeSocket(command.code, command.reason);
  }

  override postStop(): void {
    // Report the disconnect to the hub exactly once — covers normal
    // close (info set by handleClose), hub-initiated close or abort, and
    // crashes (framework stops the actor → postStop runs → synthetic info).
    if (this.connection && !this.disconnectReported) {
      this.disconnectReported = true;
      const info: WebsocketCloseInfo = this.closeInfo ?? { code: 1011, reason: '', initiatedBy: 'error' };
      this.d.hub.tell(websocketDisconnectedSignal<TOut>(this.connection, info), this.connection);
    }
    if (!this.closed) {
      this.closed = true;
      try { this.d.socket.close(); } catch { /* already closed */ }
    }
  }

  /* ------------------------------ inbound ------------------------------- */

  /**
   * Nothing reaches the hub once this side has decided to close (#1431).
   *
   * The transport does not stop on its own.  `ws` keeps emitting `'message'`
   * while a socket is CLOSING — a frame the peer sent before it saw the close
   * frame is still parsed and handed over — and these listeners stay attached
   * after the actor has stopped.  Unguarded, such a frame was decoded and told
   * to the hub *after* `postStop` had reported `onClientDisconnected`, which
   * breaks the one ordering a hub is promised per connection:
   * `onClientConnected → onMessage* → onClientDisconnected`.  A frame
   * pipelined right behind the one that made this side close got through the
   * same way, only earlier.
   *
   * Keyed on `closed`, this actor's own decision, rather than on the socket's
   * `readyState`: `closed` is set before the socket is touched, and it does not
   * depend on what an adapter reports.
   */
  private handleInbound(data: string | Uint8Array): void {
    if (this.closed) {
      this.log.debug(`WebsocketConnectionActor ${this.d.id}: inbound frame after close — dropped`);
      return;
    }
    const frame = normalizeInbound(data);
    if (!frame) {
      this.log.warn(`WebsocketConnectionActor ${this.d.id}: unrecognised inbound frame type — dropped`);
      return;
    }
    if (frameByteLength(frame) > this.d.policy.maxFrameBytes) {
      if (this.d.policy.onOversizeFrame === 'close') {
        this.closeSocket(1009, 'message too big');
      } else {
        this.log.warn(`WebsocketConnectionActor ${this.d.id}: dropped oversize inbound frame (> ${this.d.policy.maxFrameBytes} bytes)`);
      }
      return;
    }
    let decoded: TIn;
    try {
      decoded = this.d.codec.decode(frame);
    } catch (err) {
      const decodeErr = err instanceof WebsocketDecodeError ? err : new WebsocketDecodeError(String(err), frame);
      if (this.d.policy.onInvalidMessage === 'close') {
        this.closeSocket(1003, 'unsupported data');
      } else if (this.d.policy.onInvalidMessage === 'hook') {
        this.d.hub.tell(websocketInvalidSignal<TOut>(this.connection!, decodeErr), this.connection!);
      } else {
        this.log.warn(`WebsocketConnectionActor ${this.d.id}: invalid inbound message — dropped: ${decodeErr.message}`);
      }
      return;
    }
    this.d.hub.tell(websocketDataSignal<TOut, TIn>(this.connection!, decoded), this.connection!);
  }

  private handleClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closeInfo = { code, reason, initiatedBy: 'client' };
    this.context.stopSelf();
  }

  /* ------------------------------ outbound ------------------------------ */

  private write(frame: WebsocketFrame): void {
    if (this.d.socket.readyState !== WebsocketReadyState.OPEN) {
      this.log.debug(`WebsocketConnectionActor ${this.d.id}: write on non-open socket — dropped`);
      return;
    }
    const buffered = this.d.socket.bufferedAmount?.();
    if (buffered !== undefined && buffered > this.d.policy.maxBufferedBytes) {
      if (this.d.policy.onBackpressure === 'close') {
        this.log.warn(`WebsocketConnectionActor ${this.d.id}: send buffer ${buffered} > ${this.d.policy.maxBufferedBytes} — closing`);
        this.closeSocket(1013, 'try again later');
      } else {
        this.log.warn(`WebsocketConnectionActor ${this.d.id}: send buffer ${buffered} > ${this.d.policy.maxBufferedBytes} — dropping frame`);
      }
      return;
    }
    try {
      this.d.socket.send(frame.data);
    } catch (err) {
      this.log.warn(`WebsocketConnectionActor ${this.d.id}: send failed: ${(err as Error).message}`);
    }
  }

  private closeSocket(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeInfo === null) this.closeInfo = { code, reason, initiatedBy: 'server' };
    try { this.d.socket.close(code, reason); } catch { /* already closed */ }
    this.context.stopSelf();
  }

  /**
   * This actor's half of `WebsocketConnection.abort()` (#1431), handed to the
   * connection in `preStart`.
   *
   * It runs on the caller's stack — usually the hub's — and not on a turn of
   * this actor, because an abort that waited for a turn would be `close()`.
   * The order is the point:
   *
   *   1. The decision.  Shutting the socket may raise its close event before
   *      the call returns, and `handleClose` would then record the shutdown as
   *      one the *client* made — `{ 1006, '', 'client' }` after a hard close.
   *      With `closed` and `closeInfo` already set, `handleClose` returns
   *      early, `handleInbound` drops what the transport still delivers, and
   *      `postStop` reports this code and reason, as the server's, once.
   *   2. The socket.  `terminate()` where the adapter has one — the `ws`-backed
   *      backends: no close frame, and nothing still buffered is sent —
   *      otherwise `close(code, reason)`, which is what Hono gets.
   *   3. The actor, through the system lane, which the mailbox serves ahead of
   *      every queued command.  The backlog never gets a turn; stopping drains
   *      it to dead letters.
   *
   * A connection already closing — this actor closed it, the client did, or
   * the actor has stopped — is left as it is.
   */
  private abortConnection(code: number, reason: string): void {
    if (this.closed || this.closeInfo !== null) return;
    this.closed = true;
    this.closeInfo = { code, reason, initiatedBy: 'server' };
    const socket = this.d.socket;
    try {
      if (socket.terminate) socket.terminate();
      else socket.close(code, reason);
    } catch { /* already closing / closed */ }
    this.context.stopSelf();
  }
}
