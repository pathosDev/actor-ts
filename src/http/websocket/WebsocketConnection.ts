/**
 * A live WebSocket connection, presented to the hub actor as an
 * `ActorRef<TOut>` (so `this.sender` / `this.reply` / `broadcast` all
 * work through the normal actor machinery).  `tell(message)` encodes `message`
 * via the route codec and writes it to the socket — routed through the
 * connection's internal session actor so writes stay ordered.
 *
 * Precedent for a synthetic ref: `AskResponseRef` / `NobodyRef` in
 * ActorRef.ts.  Deathwatch is NOT supported — use the hub's
 * `onClientDisconnected` hook instead.
 */
import { ActorPath } from '../../ActorPath.js';
import { ActorRef } from '../../ActorRef.js';
import { LocalActorRef } from '../../internal/LocalActorRef.js';
import { WebsocketReadyState, type WebsocketSocketAdapter } from './SocketAdapter.js';
import type { WebsocketFrame, WebsocketUpgradeInfo } from './Types.js';

/** Send a typed message — encoded by the route codec before it hits the wire. */
export type OutCommand<TOut> = { readonly kind: 'out'; readonly message: TOut };
/** Send a frame verbatim, bypassing the codec. */
export type OutRawCommand = { readonly kind: 'out-raw'; readonly frame: WebsocketFrame };
/** Close the connection with a status code and reason. */
export type CloseCommand = { readonly kind: 'close'; readonly code: number; readonly reason: string };

/**
 * Outbound command a {@link WebsocketConnection} enqueues to its per-connection
 * actor.  Defined here (the producer) so the connection actor imports it
 * from the connection module, not the other way round.
 */
export type WebsocketOutboundCommand<TOut> = OutCommand<TOut> | OutRawCommand | CloseCommand;

export interface WebsocketConnection<TOut> extends ActorRef<TOut> {
  /** Stable id, unique within the process (e.g. `ws-7`). */
  readonly id: string;
  /** Remote peer address, if the backend reported one. */
  readonly remoteAddress?: string;
  /** Snapshot of the HTTP upgrade request (path, params, query, headers). */
  readonly upgrade: WebsocketUpgradeInfo;
  /** Send a raw frame, bypassing the codec. */
  sendRaw(frame: WebsocketFrame): void;
  /** Close this connection (1000 by default).  No mailbox bound can shed it. */
  close(code?: number, reason?: string): void;
  /**
   * `true` while the underlying socket is open **and** no close has been
   * requested through {@link close}.
   */
  readonly isOpen: boolean;
}

export class WebsocketConnectionImplementation<TOut> extends ActorRef<TOut> implements WebsocketConnection<TOut> {
  readonly path: ActorPath;

  /**
   * A close has been asked for; the socket may not have shut yet.
   *
   * The request and the shutdown are separated by a mailbox hop, and for that
   * whole gap the raw `readyState` still reads OPEN.
   */
  private closeRequested = false;

  constructor(
    readonly id: string,
    readonly upgrade: WebsocketUpgradeInfo,
    private readonly socket: WebsocketSocketAdapter,
    private readonly connectionRef: ActorRef<WebsocketOutboundCommand<TOut>>,
    systemName: string,
  ) {
    super();
    this.path = new ActorPath(`ws-conn-${id}`, null, systemName);
  }

  get remoteAddress(): string | undefined {
    return this.upgrade.remoteAddress;
  }

  /**
   * Reads the socket, and also the close this connection has already been
   * told to perform (#985).
   *
   * The latch is what makes `closeAll()` observable at the moment it returns.
   * `close()` queues a command the connection actor runs on a later turn, so
   * on `readyState` alone the connection reads OPEN for as long as the
   * backlog ahead of that command takes to drain — long enough for
   * `broadcast` to keep selecting a peer the hub has already decided to
   * disconnect, and for a request/response hub to keep answering one.
   * Neither is what the caller asked for.
   *
   * A close the *client* initiated needs no latch: the socket moves out of
   * OPEN before the actor hears about it.
   */
  get isOpen(): boolean {
    return !this.closeRequested && this.socket.readyState === WebsocketReadyState.OPEN;
  }

  override tell(message: TOut): void {
    this.connectionRef.tell({ kind: 'out', message });
  }

  sendRaw(frame: WebsocketFrame): void {
    this.connectionRef.tell({ kind: 'out-raw', frame });
  }

  /**
   * Ask the connection actor to shut the socket down, through a lane no
   * overflow policy may shed (#985).
   *
   * The same seam `websocket-accept` takes (#717): `postSignalEnvelope`
   * stamps `Envelope.undroppable` and routes to `Mailbox.enqueueSignal`,
   * which `BoundedMailbox` admits past its capacity check and which
   * `removeOldest` / `removeNewest` step over.  A plain `tell` put the close
   * in the same queue as every outbound frame, where `drop-head` evicted it
   * as the oldest entry, `drop-new` discarded it on arrival, and `reject`
   * threw `MailboxFullError` out of `close()` on the caller's stack — which
   * for `WebsocketServerActor.closeAll()` aborted the loop on the first
   * backlogged client and failed the hub with the rest still connected.
   * What is lost is not a message but a decision about a socket: there is no
   * retry, no sender to back off, and nothing else in the process holds that
   * socket — so a `closeAll(1008, 'rate limited')` that returns normally
   * while the peer stays connected is a control that silently did nothing.
   *
   * Not reachable under the shipped default — #1148 made the unbounded
   * mailbox the default again, and this actor is spawned with no
   * `ActorOptions` at all (`WebsocketServerActor.onWebsocketAccept`), so no
   * API a caller has today can bound it.  A global default capacity would
   * re-arm it for every connection at once, which is the door this closes in
   * advance (#862).
   *
   * The command still arrives at the **tail** of the user lane: frames
   * already queued ahead of it are written first, which is the ordering
   * `tell` / `sendRaw` depend on and the reason the reply-then-close shape
   * keeps working.  Only its deletability changed — routing control traffic
   * *ahead* of bulk traffic is a separate decision (#717, #986).
   *
   * **No `isTerminated()` guard here, deliberately** — unlike
   * `postAcceptCommand`, which needs one because an accept nobody takes
   * strands an upgraded socket and its `maxConnections` slot.  A terminated
   * connection actor has already closed this socket from its `postStop`, so
   * `postSignalEnvelope` dead-lettering the command is the honest outcome and
   * costs nothing.
   *
   * A ref that is not locally hosted keeps its plain `tell`: there is no cell
   * and no queue to be exempt from.  Nothing constructs one today — the ref
   * is always the connection actor's own `self` — and one `instanceof` is the
   * price of not asserting that forever.
   */
  close(code = 1000, reason = ''): void {
    this.closeRequested = true;
    const command: CloseCommand = { kind: 'close', code, reason };
    if (this.connectionRef instanceof LocalActorRef) {
      this.connectionRef.getCell().postSignalEnvelope({ message: command, sender: null });
      return;
    }
    this.connectionRef.tell(command);
  }
}
