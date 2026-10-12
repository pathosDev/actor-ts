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
  /**
   * Close this connection (1000 by default) after everything already sent to
   * it: the close is queued behind those frames, so a reply followed by
   * `close()` reaches the peer first.  No mailbox bound can shed it.
   * {@link abort} is the close that does not wait.
   */
  close(code?: number, reason?: string): void;
  /**
   * Drop this connection now (1008 by default).  Frames still queued for it
   * are never written, and the socket is shut before this returns:
   * hard-closed where the backend can, so the peer sees the connection drop
   * without a close frame, otherwise closed with `code` and `reason`.  The hub
   * still gets exactly one `onClientDisconnected`, carrying this `code` and
   * `reason` with `initiatedBy: 'server'`.  Does nothing on a connection that
   * is no longer open.
   */
  abort(code?: number, reason?: string): void;
  /**
   * `true` while the underlying socket is open **and** neither {@link close}
   * nor {@link abort} has been called.
   */
  readonly isOpen: boolean;
}

export class WebsocketConnectionImplementation<TOut> extends ActorRef<TOut> implements WebsocketConnection<TOut> {
  readonly path: ActorPath;

  /**
   * A close or an abort has been asked for.
   *
   * After `close()` the socket may not have shut yet: the request and the
   * shutdown are separated by a mailbox hop, and for that whole gap the raw
   * `readyState` still reads OPEN.
   */
  private closeRequested = false;

  /**
   * @param abortConnection  The connection actor's half of {@link abort}:
   *   record the close as this side's, shut the socket, stop the actor.  The
   *   actor hands it over from its `preStart`, the one place this class is
   *   built, so everything an abort changes stays the actor's own state,
   *   changed by the actor's own code — nothing here writes into it.
   */
  constructor(
    readonly id: string,
    readonly upgrade: WebsocketUpgradeInfo,
    private readonly socket: WebsocketSocketAdapter,
    private readonly connectionRef: ActorRef<WebsocketOutboundCommand<TOut>>,
    systemName: string,
    private readonly abortConnection: (code: number, reason: string) => void,
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
   *
   * `abort()` sets the same latch.  It needs it less — the socket has been
   * acted on by the time `abort()` returns — but with it, `isOpen` does not
   * depend on how promptly an adapter's `readyState` reflects that.
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
   * Ask the connection actor to shut the socket down once everything queued
   * ahead of the request has been written, through a lane no overflow policy
   * may shed (#985).
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
   * mailbox the default again — but one setting away from it, in two ways:
   * `actor-ts.mailbox.default.capacity` bounds every connection actor along
   * with every other application actor (#862), and a route bounds its own
   * connections with `withConnectionMailboxCapacity` or the
   * `actor-ts.http.websocket.connection-mailbox-capacity` leaf (#1432).
   *
   * The command still arrives at the **tail** of the user lane, and that is
   * decided rather than pending (#1431): frames already queued ahead of it are
   * written first, which is the ordering `tell` / `sendRaw` depend on and what
   * makes reply-then-close work — the actor writes nothing after a close, so a
   * close that overtook the reply would lose it.  Only its deletability
   * changed.  A close that must not wait behind the backlog makes the peer a
   * different promise, and it is a different method: {@link abort}.
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

  /**
   * Shut the connection down on the caller's stack and discard its backlog
   * (#1431).
   *
   * {@link close} keeps its place in line, which is what a goodbye needs and
   * the wrong answer for a peer the hub has stopped serving: a `close(1008)`
   * for a flooding client waits behind every frame already queued for it and
   * hands it the whole backlog first.  `abort()` does not queue anything.  The
   * connection actor's half runs before this returns — see
   * `WebsocketConnectionActor.abortConnection` for why its order matters —
   * and stops the actor through the system lane, ahead of the queued frames,
   * which are then dead-lettered like any stopped actor's queue.
   *
   * Gated on {@link isOpen}, so it does nothing after `close()` — the first
   * decision about a socket stands, and an ordered close has already promised
   * the peer its backlog — nor after an earlier `abort()`, nor once either
   * side has closed the socket.
   */
  abort(code = 1008, reason = ''): void {
    if (!this.isOpen) return;
    this.closeRequested = true;
    this.abortConnection(code, reason);
  }
}
