/**
 * A live WebSocket connection, presented to the hub actor as an
 * `ActorRef<TOut>` (so `this.sender` / `this.reply` / `broadcast` all
 * work through the normal actor machinery).  `tell(msg)` encodes `msg`
 * via the route codec and writes it to the socket — routed through the
 * connection's internal session actor so writes stay ordered.
 *
 * Precedent for a synthetic ref: `AskResponseRef` / `NobodyRef` in
 * ActorRef.ts.  Deathwatch is NOT supported — use the hub's
 * `onClientDisconnected` hook instead.
 */
import { ActorPath } from '../../ActorPath.js';
import { ActorRef } from '../../ActorRef.js';
import { WsReadyState, type WebSocketSocketAdapter } from './SocketAdapter.js';
import type { SessionCommand } from './WebSocketSessionActor.js';
import type { WsFrame, WsUpgradeInfo } from './types.js';

export interface WsConnection<TOut> extends ActorRef<TOut> {
  /** Stable id, unique within the process (e.g. `ws-7`). */
  readonly id: string;
  /** Remote peer address, if the backend reported one. */
  readonly remoteAddress?: string;
  /** Snapshot of the HTTP upgrade request (path, params, query, headers). */
  readonly upgrade: WsUpgradeInfo;
  /** Send a raw frame, bypassing the codec. */
  sendRaw(frame: WsFrame): void;
  /** Close this connection (1000 by default). */
  close(code?: number, reason?: string): void;
  /** `true` while the underlying socket is open. */
  readonly isOpen: boolean;
}

export class WsConnectionImpl<TOut> extends ActorRef<TOut> implements WsConnection<TOut> {
  readonly path: ActorPath;

  constructor(
    readonly id: string,
    readonly upgrade: WsUpgradeInfo,
    private readonly socket: WebSocketSocketAdapter,
    private readonly sessionRef: ActorRef<SessionCommand<TOut>>,
    systemName: string,
  ) {
    super();
    this.path = new ActorPath(`ws-conn-${id}`, null, systemName);
  }

  get remoteAddress(): string | undefined {
    return this.upgrade.remoteAddress;
  }

  get isOpen(): boolean {
    return this.socket.readyState === WsReadyState.OPEN;
  }

  override tell(msg: TOut): void {
    this.sessionRef.tell({ _cmd: 'out', msg });
  }

  sendRaw(frame: WsFrame): void {
    this.sessionRef.tell({ _cmd: 'out-raw', frame });
  }

  close(code = 1000, reason = ''): void {
    this.sessionRef.tell({ _cmd: 'close', code, reason });
  }
}
