/**
 * Shared connection-wiring layer.  Everything that turns an accepted
 * upgrade into a live actor-backed connection lives here, so the three
 * HTTP backends stay thin (they only produce a
 * {@link WebsocketSocketAdapter}).
 *
 * This file grows across the WebSocket work:
 *   - {@link ConnectionTracker} / {@link trackSocket} — shutdown bookkeeping
 *     (used by `HttpExtension.bind`'s unbind path).
 *   - `wireConnection` — admits the connection and asks the hub to spawn the
 *     per-connection session actor, which attaches the listeners itself
 *     (added with the actor layer).
 */
import type { ActorFactory } from '../../Actor.js';
import type { ActorSystem } from '../../ActorSystem.js';
import type { Cancellable } from '../../Scheduler.js';
import { LocalActorRef } from '../../internal/LocalActorRef.js';
import type { HttpRequest } from '../Types.js';
import type { WebsocketSocketAdapter } from './SocketAdapter.js';
import { websocketAcceptCommand, type WebsocketAcceptCommand, type WebsocketServerRef } from './WebsocketMessages.js';
import { WebsocketConnectionActor } from './WebsocketConnectionActor.js';
import type { WebsocketCodec } from './WebsocketCodec.js';
import type { ResolvedWebsocketPolicy } from './WebsocketPolicy.js';
import type { WebsocketUpgradeInfo } from './Types.js';

/**
 * Tracks the live server-side sockets of one binding so `unbind()` can
 * close them.  Without this a long-lived WebSocket keeps the HTTP
 * server's `close()` pending forever (the process refuses to exit).
 */
export class ConnectionTracker {
  private readonly sockets = new Set<WebsocketSocketAdapter>();

  add(socket: WebsocketSocketAdapter): void {
    this.sockets.add(socket);
  }

  remove(socket: WebsocketSocketAdapter): void {
    this.sockets.delete(socket);
  }

  get size(): number {
    return this.sockets.size;
  }

  /** Send a polite close frame to every tracked socket (best-effort). */
  closeAll(code = 1000, reason = ''): void {
    for (const socket of this.sockets) {
      try {
        socket.close(code, reason);
      } catch {
        /* already closing / closed */
      }
    }
  }

  /** Hard-terminate every tracked socket and forget them all (shutdown). */
  terminateAll(): void {
    for (const socket of this.sockets) {
      try {
        if (socket.terminate) socket.terminate();
        else socket.close(1001, 'going away');
      } catch {
        /* already gone */
      }
    }
    this.sockets.clear();
  }
}

/**
 * Register `socket` with `tracker` and return a thin wrapper whose
 * `setListeners` chains tracker removal into `onClose`.  The tracker
 * always holds the *original* socket, so `closeAll` / `terminateAll`
 * act on the real thing; the wrapper only ensures we stop tracking a
 * socket once it closes on its own.
 */
export function trackSocket(
  tracker: ConnectionTracker,
  socket: WebsocketSocketAdapter,
): WebsocketSocketAdapter {
  tracker.add(socket);
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    terminate: socket.terminate ? () => socket.terminate!() : undefined,
    setListeners: (l) => {
      socket.setListeners({
        onMessage: (data) => l.onMessage(data),
        onClose: (code, reason) => {
          tracker.remove(socket);
          l.onClose(code, reason);
        },
        onError: (err) => l.onError(err),
      });
    },
    get readyState() {
      return socket.readyState;
    },
    bufferedAmount: socket.bufferedAmount ? () => socket.bufferedAmount!() : undefined,
    get remoteAddress() {
      return socket.remoteAddress;
    },
    get protocol() {
      return socket.protocol;
    },
  };
}

let connectionCounter = 0;

/**
 * Live connection count per hub, for the per-route `maxConnections` cap
 * (security audit WS-5).  Keyed by the hub ref (one per route); increments
 * when a connection is admitted and decrements when its socket closes.  A
 * `WeakMap` so a discarded hub doesn't leak its counter.
 */
const liveConnectionsByHub = new WeakMap<object, number>();

/**
 * Wrap `socket` so `onClosed` runs exactly once when it closes — used to
 * decrement the live-connection count.  Mirrors {@link trackSocket}'s onClose
 * chaining.
 */
function decrementOnClose(
  socket: WebsocketSocketAdapter,
  onClosed: () => void,
): WebsocketSocketAdapter {
  let fired = false;
  const fire = (): void => { if (!fired) { fired = true; onClosed(); } };
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    terminate: socket.terminate ? () => socket.terminate!() : undefined,
    setListeners: (l) => socket.setListeners({
      onMessage: (data) => l.onMessage(data),
      onClose: (code, reason) => { fire(); l.onClose(code, reason); },
      onError: (err) => l.onError(err),
    }),
    get readyState() { return socket.readyState; },
    bufferedAmount: socket.bufferedAmount ? () => socket.bufferedAmount!() : undefined,
    get remoteAddress() { return socket.remoteAddress; },
    get protocol() { return socket.protocol; },
  };
}

/**
 * Hand the hub its spawn command through the one lane no load-shedding policy
 * can reach — the seam #729 built for a death-watch `Terminated`, reused here
 * rather than duplicated (#717).
 *
 * A {@link WebsocketAcceptCommand} is the same class of envelope as that
 * notification, for the same reasons: the framework generates it, sends it
 * exactly once, and holds nothing that could send it again — `wireConnection`
 * returns the moment this call does, and the socket the factory closes over is
 * reachable from nowhere else.  So losing it does not cost a *message*, it
 * costs a **socket**: one that finished its upgrade, has no actor to attach
 * listeners for it, accumulates inbound frames in `bufferWebsocketEvents`'
 * pre-attach array with nothing that will ever drain them, and holds its
 * `maxConnections` slot until the client gives up on a peer that will never
 * answer.
 *
 * Only reachable where the hub was bounded on purpose.  #1148 made the default
 * mailbox unbounded, so nothing is evicted from a hub nobody bounded — but
 * bounding one is a plausible thing for an operator to do, since a hub is the
 * textbook "actor exposed to a producer you do not control", and every overflow
 * policy destroyed the accept in its own way.  `drop-head` evicted it once
 * roughly `capacity` further frames had pushed it back to the head; `drop-new`
 * discarded it on arrival, the likelier of the two because a flood fills the
 * queue *before* the next upgrade completes; and `reject` threw
 * `MailboxFullError` out of `hub.tell` on the backend's upgrade stack, where
 * nothing was catching it.
 *
 * The command keeps its **place in line** — `postSignalEnvelope` queues at the
 * tail of the user lane, it is not a priority lane.  Frames already queued
 * ahead of it are still handled first, which is the ordering the hub's own
 * `websocket-data` traffic depends on; what changed is only that the queue may
 * no longer delete it.  Routing control messages *ahead* of bulk traffic is a
 * separate question and a separate design decision (#985, #986).
 *
 * A ref that is not locally hosted keeps its plain `tell`: there is no cell and
 * no queue to be exempt from.  No route can bind such a hub today — it comes
 * from `system.spawn` — and one `instanceof` is the price of not asserting that
 * forever.
 *
 * Returns whether the hub took it.  A **terminated** cell does not: it
 * dead-letters the envelope and returns normally (`ActorCell.postSignalEnvelope`),
 * which is the honest answer for a message but the wrong one for a socket —
 * nothing throws, so the caller's `catch` never runs, and an upgrade routed at
 * a hub that has stopped is orphaned with its admission slot burned.  The state
 * is read here rather than inferred from a throw because the alternative is a
 * dead-letter the wiring layer cannot see (#717).
 */
function postAcceptCommand<TOut, TIn, TSelf>(
  hub: WebsocketServerRef<TOut, TIn, TSelf>,
  command: WebsocketAcceptCommand,
): boolean {
  if (hub instanceof LocalActorRef) {
    const cell = hub.getCell();
    if (cell.isTerminated()) return false;
    cell.postSignalEnvelope({ message: command, sender: null });
    return true;
  }
  hub.tell(command, null);
  return true;
}

/** Handle on the one moment the wiring layer would otherwise lose control of. */
type AcceptHandoff = {
  /** The socket to hand the connection actor — the guarded wrapper, not the raw one. */
  readonly socket: WebsocketSocketAdapter;
  /**
   * Give up on a connection whose actor never attached: closes the socket,
   * unwinds everything chained onto `setListeners`, and answers a late actor
   * with the close instead of a silently dead socket.  Returns `false` when
   * there was nothing to give up on — already attached, or already abandoned.
   */
  readonly abandon: (code: number, reason: string) => boolean;
};

/**
 * Wrap `socket` so `wireConnection` can still act on a connection it has
 * already handed to the hub.
 *
 * Everything that unwinds an admitted connection — the `ConnectionTracker`
 * entry, the `maxConnections` slot, the pre-attach buffer — hangs off
 * `setListeners`, which the connection actor calls from its `preStart`.  That
 * is the right seam for a connection that lives; it is no seam at all for one
 * whose actor never spawns, and *that* is the shape #717 reports.  So the two
 * directions both go through here:
 *
 *   - `onAttached` fires when the actor really did attach, which is the signal
 *     the accept watchdog waits for;
 *   - `abandon` attaches **no-op listeners itself**.  Not a formality: it is
 *     what runs the `onClose` chains below this wrapper, drains the pre-attach
 *     buffer and stops it refilling, and it is the only way to reach them
 *     without the actor that is not coming.
 *
 * An actor that attaches *after* an abandon — the hub drained one tick past
 * the deadline — is answered with the close rather than the socket.  It would
 * otherwise hold a socket the framework already closed, report a connection
 * that does not exist, and never hear a close event, because the real one was
 * consumed by the no-op listeners.
 */
function guardAcceptHandoff(
  socket: WebsocketSocketAdapter,
  onAttached: () => void,
): AcceptHandoff {
  let attached = false;
  let abandonedWith: { readonly code: number; readonly reason: string } | null = null;

  const guarded: WebsocketSocketAdapter = {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    terminate: socket.terminate ? () => socket.terminate!() : undefined,
    setListeners: (l) => {
      attached = true;
      if (abandonedWith !== null) {
        l.onClose(abandonedWith.code, abandonedWith.reason);
        return;
      }
      onAttached();
      socket.setListeners(l);
    },
    get readyState() { return socket.readyState; },
    bufferedAmount: socket.bufferedAmount ? () => socket.bufferedAmount!() : undefined,
    get remoteAddress() { return socket.remoteAddress; },
    get protocol() { return socket.protocol; },
  };

  const abandon = (code: number, reason: string): boolean => {
    if (attached || abandonedWith !== null) return false;
    abandonedWith = { code, reason };
    socket.setListeners({
      onMessage: () => { /* nobody is listening — this is what stops the buffer refilling */ },
      onClose: () => { /* the chains below this wrapper are the point, not the callback */ },
      onError: () => { /* ditto */ },
    });
    try { socket.close(code, reason); } catch { /* already closing */ }
    return true;
  };

  return { socket: guarded, abandon };
}

/**
 * Turn one accepted upgrade into a live actor-backed connection.  Called
 * synchronously from the backend's upgrade callback (via the route's
 * `connect` handler).
 *
 * It does NOT spawn or attach anything itself — instead it hands the hub
 * a {@link WebsocketAcceptCommand} carrying the per-connection actor's factory, so
 * the hub spawns that actor as its OWN child (`server → conn-N`).  The
 * child then creates the {@link WebsocketConnection}, reports `connected`, and
 * attaches the socket listeners in its `preStart`.  The command travels
 * undroppable — see {@link postAcceptCommand} for why that matters.
 *
 * First-frame race: the socket adapter attaches its native listeners
 * synchronously at upgrade and BUFFERS inbound frames until the child's
 * `setListeners` runs — so nothing is lost between upgrade and the child
 * becoming ready.
 */
export function wireConnection<TOut, TIn, TSelf = never>(
  system: ActorSystem,
  hub: WebsocketServerRef<TOut, TIn, TSelf>,
  request: HttpRequest,
  socket: WebsocketSocketAdapter,
  codec: WebsocketCodec<TOut, TIn>,
  policy: ResolvedWebsocketPolicy,
): void {
  // Admission cap (security audit WS-5): when the route is at its
  // connection limit, close the freshly-upgraded socket with 1013 ("try
  // again later") instead of wiring an actor for it.  Unlimited by default
  // (`policy.maxConnections === Infinity`).
  //
  // `releaseSlot` is kept as a callable of its own rather than only chained
  // onto the socket's `onClose`, because the failure paths below have to unwind
  // the slot on a connection whose listeners are never going to be attached —
  // and the chained release runs *from* `setListeners`, which is precisely
  // what did not happen.
  let releaseSlot: (() => void) | null = null;
  const cap = policy.maxConnections;
  if (Number.isFinite(cap)) {
    const hubKey = hub as unknown as object;
    const live = liveConnectionsByHub.get(hubKey) ?? 0;
    if (live >= cap) {
      try { socket.close(1013, 'server at capacity'); } catch { /* already closing */ }
      return;
    }
    liveConnectionsByHub.set(hubKey, live + 1);
    // The latch lives on `releaseSlot` itself, not on `decrementOnClose`'s
    // chained call alone.  There are now three callers — the refusal below, the
    // accept watchdog, and the socket's own close — and only the third goes
    // through that wrapper, so a latch inside it would let an abandoned
    // connection that closes late decrement the same admission twice and hand
    // the route a slot it never had.
    let released = false;
    releaseSlot = (): void => {
      if (released) return;
      released = true;
      liveConnectionsByHub.set(hubKey, Math.max(0, (liveConnectionsByHub.get(hubKey) ?? 1) - 1));
    };
    socket = decrementOnClose(socket, releaseSlot);
  }

  // The watchdog and the socket wrapper that cancels it are set up before the
  // actor factory closes over the socket, because the factory is what carries
  // the socket to the hub — after that call there is no other way back to it.
  let acceptWatchdog: Cancellable | null = null;
  const handoff = guardAcceptHandoff(socket, () => {
    acceptWatchdog?.cancel();
    acceptWatchdog = null;
  });
  socket = handoff.socket;

  const id = `ws-${++connectionCounter}`;
  const upgrade: WebsocketUpgradeInfo = {
    path: request.path,
    params: request.params,
    query: request.query,
    headers: request.headers,
    remoteAddress: request.remoteAddress ?? socket.remoteAddress,
    subprotocol: socket.protocol,
  };

  const actor = (): WebsocketConnectionActor<TOut, TIn, TSelf> =>
    new WebsocketConnectionActor<TOut, TIn, TSelf>({ socket, codec, policy, hub, id, upgrade });

  /**
   * Close the socket, release the slot, and say why — the one unwind path for
   * an upgrade the hub is never going to answer.  `cause` is spread rather
   * than passed positionally because the logger takes varargs, and a bare
   * `undefined` would render as a second line of "undefined" on the two call
   * sites that have no error to show.
   */
  const abandon = (code: number, reason: string, why: string, cause?: unknown): void => {
    const detail = cause === undefined ? [] : [cause];
    system.log.error(`[ws] ${why} for ${request.path} (hub ${hub.path}) — closing ${id}`, ...detail);
    handoff.abandon(code, reason);
    releaseSlot?.();
  };

  let posted: boolean;
  try {
    posted = postAcceptCommand(hub, websocketAcceptCommand(actor as unknown as ActorFactory<unknown>, id));
  } catch (e) {
    // Reached only by a `Mailbox` subclass of the caller's own that throws from
    // `enqueue` without overriding `enqueueSignal` — the built-in bounds all
    // honour the exempt door — or by a remote hub's transport.  Whatever the
    // cause, this runs on the backend's upgrade stack, which no backend guards,
    // so it must end here: an upgrade that cannot be wired becomes a closed
    // socket and a released admission slot, not an exception thrown through a
    // transport callback into whatever the runtime does with one.
    abandon(1011, 'connection setup failed', 'hub refused the connection', e);
    return;
  }
  if (!posted) {
    abandon(1011, 'connection setup failed', 'hub has stopped');
    return;
  }

  // Everything past this point is out of the wiring layer's hands: the hub has
  // the command, and whether an actor comes back from it is the hub's business.
  // The watchdog is the answer to "and if one never does" — a hub stopped
  // between the send and the drain, an `onReceive` an application overrode
  // without handling `websocket-accept`, a factory that throws.  None of those
  // is visible from here, all of them leave an upgraded socket with no
  // listeners, and nothing else ever revisits it (#717).
  //
  // A fallback, not a liveness policy: it fires seconds after a healthy hub
  // would have attached, and it is disarmed by the attach itself rather than by
  // any guess about how long that should take.  `Infinity` opts out.
  if (Number.isFinite(policy.acceptTimeoutMs)) {
    acceptWatchdog = system.scheduler.scheduleOnceFunction(policy.acceptTimeoutMs, () => {
      acceptWatchdog = null;
      if (!handoff.abandon(1013, 'connection setup timed out')) return;
      releaseSlot?.();
      system.log.warn(
        `[ws] hub ${hub.path} did not spawn a connection actor for ${id} within `
        + `${policy.acceptTimeoutMs} ms — closed ${request.path} and released its slot`,
      );
    });
  }
}
