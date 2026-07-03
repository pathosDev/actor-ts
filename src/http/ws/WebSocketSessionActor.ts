/**
 * Internal per-connection actor.  The framework spawns exactly one of
 * these per accepted WebSocket connection (the user never sees it).  It:
 *
 *   - owns the socket adapter,
 *   - serialises outbound writes through its mailbox (encode via the
 *     route codec + backpressure check),
 *   - closes the socket on stop.
 *
 * Inbound frames do NOT flow through here — the wiring layer delivers
 * them straight to the user-facing hub ({@link WebSocketServerActor})
 * with this connection as the sender.  A session actor is therefore the
 * connection's *output half* plus its lifecycle owner.
 */
import { Actor } from '../../Actor.js';
import type { WsCodec } from './WsCodec.js';
import { WsReadyState, type WebSocketSocketAdapter } from './SocketAdapter.js';
import type { WsFrame } from './types.js';
import type { ResolvedWsPolicy } from './WsPolicy.js';

/** Outbound command a {@link WsConnection} enqueues to its session actor. */
export type SessionCommand<TOut> =
  | { readonly _cmd: 'out'; readonly msg: TOut }
  | { readonly _cmd: 'out-raw'; readonly frame: WsFrame }
  | { readonly _cmd: 'close'; readonly code: number; readonly reason: string };

export class WebSocketSessionActor<TOut, TIn> extends Actor<SessionCommand<TOut>> {
  private closed = false;

  constructor(
    private readonly socket: WebSocketSocketAdapter,
    private readonly codec: WsCodec<TOut, TIn>,
    private readonly policy: ResolvedWsPolicy,
  ) {
    super();
  }

  override onReceive(cmd: SessionCommand<TOut>): void {
    if (this.closed) {
      this.log.debug('WebSocketSessionActor: command after close — ignored');
      return;
    }
    switch (cmd._cmd) {
      case 'out': {
        let frame: WsFrame;
        try {
          frame = this.codec.encode(cmd.msg);
        } catch (err) {
          // Fire-and-forget send: can't surface to the caller — log + drop.
          this.log.error(`WebSocketSessionActor: encode failed, dropping message: ${(err as Error).message}`);
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

  private write(frame: WsFrame): void {
    if (this.socket.readyState !== WsReadyState.OPEN) {
      this.log.debug('WebSocketSessionActor: write on non-open socket — dropped');
      return;
    }
    const buffered = this.socket.bufferedAmount?.();
    if (buffered !== undefined && buffered > this.policy.maxBufferedBytes) {
      if (this.policy.onBackpressure === 'close') {
        this.log.warn(
          `WebSocketSessionActor: send buffer ${buffered} > maxBufferedBytes ${this.policy.maxBufferedBytes} — closing`,
        );
        this.closeSocket(1013, 'try again later');
      } else {
        this.log.warn(
          `WebSocketSessionActor: send buffer ${buffered} > maxBufferedBytes ${this.policy.maxBufferedBytes} — dropping frame`,
        );
      }
      return;
    }
    try {
      this.socket.send(frame.data);
    } catch (err) {
      this.log.warn(`WebSocketSessionActor: send failed: ${(err as Error).message}`);
    }
  }

  private closeSocket(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  override postStop(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
    }
  }
}
