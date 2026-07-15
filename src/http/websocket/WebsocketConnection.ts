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
import { WebsocketReadyState, type WebsocketSocketAdapter } from './SocketAdapter.js';
import type { WebsocketFrame, WebsocketUpgradeInfo } from './types.js';

/**
 * Outbound command a {@link WebsocketConnection} enqueues to its per-connection
 * actor.  Defined here (the producer) so the connection actor imports it
 * from the connection module, not the other way round.
 */
export type WebsocketOutboundCommand<TOut> =
  | { readonly _cmd: 'out'; readonly msg: TOut }
  | { readonly _cmd: 'out-raw'; readonly frame: WebsocketFrame }
  | { readonly _cmd: 'close'; readonly code: number; readonly reason: string };

export interface WebsocketConnection<TOut> extends ActorRef<TOut> {
  /** Stable id, unique within the process (e.g. `ws-7`). */
  readonly id: string;
  /** Remote peer address, if the backend reported one. */
  readonly remoteAddress?: string;
  /** Snapshot of the HTTP upgrade request (path, params, query, headers). */
  readonly upgrade: WebsocketUpgradeInfo;
  /** Send a raw frame, bypassing the codec. */
  sendRaw(frame: WebsocketFrame): void;
  /** Close this connection (1000 by default). */
  close(code?: number, reason?: string): void;
  /** `true` while the underlying socket is open. */
  readonly isOpen: boolean;
}

export class WebsocketConnectionImplementation<TOut> extends ActorRef<TOut> implements WebsocketConnection<TOut> {
  readonly path: ActorPath;

  constructor(
    readonly id: string,
    readonly upgrade: WebsocketUpgradeInfo,
    private readonly socket: WebsocketSocketAdapter,
    private readonly connRef: ActorRef<WebsocketOutboundCommand<TOut>>,
    systemName: string,
  ) {
    super();
    this.path = new ActorPath(`ws-conn-${id}`, null, systemName);
  }

  get remoteAddress(): string | undefined {
    return this.upgrade.remoteAddress;
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebsocketReadyState.OPEN;
  }

  override tell(msg: TOut): void {
    this.connRef.tell({ _cmd: 'out', msg });
  }

  sendRaw(frame: WebsocketFrame): void {
    this.connRef.tell({ _cmd: 'out-raw', frame });
  }

  close(code = 1000, reason = ''): void {
    this.connRef.tell({ _cmd: 'close', code, reason });
  }
}
