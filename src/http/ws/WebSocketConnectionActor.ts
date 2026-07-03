/**
 * Internal per-connection actor — a genuine child of the
 * {@link WebSocketServerActor} hub (spawned via the hub's context, so
 * the actor tree is `server → conn-1, conn-2, …`).  Users never see or
 * manage it.
 *
 * It owns the whole communication for one connection:
 *   - inbound: attaches the socket listeners in `preStart`, size-caps +
 *     decodes each frame, and forwards the decoded message to the hub
 *     with this connection as the sender;
 *   - outbound: its mailbox is the connection's write queue — a
 *     {@link WsConnection}'s `tell` / `sendRaw` / `close` enqueue here,
 *     and it encodes + writes to the socket (with a backpressure check);
 *   - lifecycle: on socket close it stops itself; `postStop` reports the
 *     disconnect to the hub exactly once and closes the socket.
 *
 * The hub supervises these with `stoppingStrategy` — a crashed
 * connection stops (and `postStop` still reports the disconnect) rather
 * than restarting into a dead socket.
 */
import { Actor } from '../../Actor.js';
import { WsReadyState, type WebSocketSocketAdapter } from './SocketAdapter.js';
import { WsDecodeError, type WsCodec } from './WsCodec.js';
import { WsConnectionImpl, type WsConnection, type WsOutboundCommand } from './WsConnection.js';
import {
  WsConnectedSignal,
  WsDataSignal,
  WsDisconnectedSignal,
  WsInvalidSignal,
  type WsServerRef,
} from './WsMessages.js';
import type { ResolvedWsPolicy } from './WsPolicy.js';
import {
  frameByteLength,
  normalizeInbound,
  type WsCloseInfo,
  type WsFrame,
  type WsUpgradeInfo,
} from './types.js';

export interface WebSocketConnectionDeps<TOut, TIn, TSelf> {
  readonly socket: WebSocketSocketAdapter;
  readonly codec: WsCodec<TOut, TIn>;
  readonly policy: ResolvedWsPolicy;
  readonly hub: WsServerRef<TOut, TIn, TSelf>;
  readonly id: string;
  readonly upgrade: WsUpgradeInfo;
}

export class WebSocketConnectionActor<TOut, TIn, TSelf = never>
  extends Actor<WsOutboundCommand<TOut>> {

  private readonly d: WebSocketConnectionDeps<TOut, TIn, TSelf>;
  private connection: WsConnection<TOut> | null = null;
  private closed = false;
  private disconnectReported = false;
  private closeInfo: WsCloseInfo | null = null;

  constructor(deps: WebSocketConnectionDeps<TOut, TIn, TSelf>) {
    super();
    this.d = deps;
  }

  override preStart(): void {
    const conn = new WsConnectionImpl<TOut>(this.d.id, this.d.upgrade, this.d.socket, this.self, this.system.name);
    this.connection = conn;
    // Tell the hub 'connected' BEFORE attaching listeners, so it is
    // mailbox-ordered before any inbound data flushed by setListeners.
    this.d.hub.tell(new WsConnectedSignal<TOut>(conn), conn);
    this.d.socket.setListeners({
      onMessage: (data) => this.handleInbound(data),
      onClose: (code, reason) => this.handleClose(code, reason),
      onError: (err) => this.log.warn(`WebSocketConnectionActor ${this.d.id}: socket error: ${err.message}`),
    });
  }

  override onReceive(cmd: WsOutboundCommand<TOut>): void {
    if (this.closed) {
      this.log.debug(`WebSocketConnectionActor ${this.d.id}: command after close — ignored`);
      return;
    }
    switch (cmd._cmd) {
      case 'out': {
        let frame: WsFrame;
        try {
          frame = this.d.codec.encode(cmd.msg);
        } catch (err) {
          this.log.error(`WebSocketConnectionActor ${this.d.id}: encode failed, dropping message: ${(err as Error).message}`);
          return;
        }
        this.write(frame);
        break;
      }
      case 'out-raw':
        this.write(cmd.frame);
        break;
      case 'close':
        this.closeSocket(cmd.code, cmd.reason);
        break;
    }
  }

  override postStop(): void {
    // Report the disconnect to the hub exactly once — covers normal
    // close (info set by handleClose), hub-initiated close, and crashes
    // (framework stops the actor → postStop runs → synthetic info).
    if (this.connection && !this.disconnectReported) {
      this.disconnectReported = true;
      const info: WsCloseInfo = this.closeInfo ?? { code: 1011, reason: '', initiatedBy: 'error' };
      this.d.hub.tell(new WsDisconnectedSignal<TOut>(this.connection, info), this.connection);
    }
    if (!this.closed) {
      this.closed = true;
      try { this.d.socket.close(); } catch { /* already closed */ }
    }
  }

  /* ------------------------------ inbound ------------------------------- */

  private handleInbound(data: string | Uint8Array): void {
    const frame = normalizeInbound(data);
    if (!frame) {
      this.log.warn(`WebSocketConnectionActor ${this.d.id}: unrecognised inbound frame type — dropped`);
      return;
    }
    if (frameByteLength(frame) > this.d.policy.maxFrameBytes) {
      if (this.d.policy.onOversizeFrame === 'close') {
        this.closeSocket(1009, 'message too big');
      } else {
        this.log.warn(`WebSocketConnectionActor ${this.d.id}: dropped oversize inbound frame (> ${this.d.policy.maxFrameBytes} bytes)`);
      }
      return;
    }
    let decoded: TIn;
    try {
      decoded = this.d.codec.decode(frame);
    } catch (err) {
      const decodeErr = err instanceof WsDecodeError ? err : new WsDecodeError(String(err), frame);
      if (this.d.policy.onInvalidMessage === 'close') {
        this.closeSocket(1003, 'unsupported data');
      } else if (this.d.policy.onInvalidMessage === 'hook') {
        this.d.hub.tell(new WsInvalidSignal<TOut>(this.connection!, decodeErr), this.connection!);
      } else {
        this.log.warn(`WebSocketConnectionActor ${this.d.id}: invalid inbound message — dropped: ${decodeErr.message}`);
      }
      return;
    }
    this.d.hub.tell(new WsDataSignal<TOut, TIn>(this.connection!, decoded), this.connection!);
  }

  private handleClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closeInfo = { code, reason, initiatedBy: 'client' };
    this.context.stopSelf();
  }

  /* ------------------------------ outbound ------------------------------ */

  private write(frame: WsFrame): void {
    if (this.d.socket.readyState !== WsReadyState.OPEN) {
      this.log.debug(`WebSocketConnectionActor ${this.d.id}: write on non-open socket — dropped`);
      return;
    }
    const buffered = this.d.socket.bufferedAmount?.();
    if (buffered !== undefined && buffered > this.d.policy.maxBufferedBytes) {
      if (this.d.policy.onBackpressure === 'close') {
        this.log.warn(`WebSocketConnectionActor ${this.d.id}: send buffer ${buffered} > ${this.d.policy.maxBufferedBytes} — closing`);
        this.closeSocket(1013, 'try again later');
      } else {
        this.log.warn(`WebSocketConnectionActor ${this.d.id}: send buffer ${buffered} > ${this.d.policy.maxBufferedBytes} — dropping frame`);
      }
      return;
    }
    try {
      this.d.socket.send(frame.data);
    } catch (err) {
      this.log.warn(`WebSocketConnectionActor ${this.d.id}: send failed: ${(err as Error).message}`);
    }
  }

  private closeSocket(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeInfo === null) this.closeInfo = { code, reason, initiatedBy: 'server' };
    try { this.d.socket.close(code, reason); } catch { /* already closed */ }
    this.context.stopSelf();
  }
}
