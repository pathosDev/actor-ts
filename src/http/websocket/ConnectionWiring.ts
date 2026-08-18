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
 */
function postAcceptCommand<TOut, TIn, TSelf>(
  hub: WebsocketServerRef<TOut, TIn, TSelf>,
  command: WebsocketAcceptCommand,
): void {
  if (hub instanceof LocalActorRef) {
    hub.getCell().postSignalEnvelope({ message: command, sender: null });
    return;
  }
  hub.tell(command, null);
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
  // onto the socket's `onClose`, because the failure path below has to unwind
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
    releaseSlot = (): void => {
      liveConnectionsByHub.set(hubKey, Math.max(0, (liveConnectionsByHub.get(hubKey) ?? 1) - 1));
    };
    // `decrementOnClose` carries the once-only latch, so the two callers of
    // `releaseSlot` cannot decrement the same admission twice.
    socket = decrementOnClose(socket, releaseSlot);
  }
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
  try {
    postAcceptCommand(hub, websocketAcceptCommand(actor as unknown as ActorFactory<unknown>, id));
  } catch (e) {
    // Reached only by a `Mailbox` subclass of the caller's own that throws from
    // `enqueue` without overriding `enqueueSignal` — the built-in bounds all
    // honour the exempt door — or by a remote hub's transport.  Whatever the
    // cause, this runs on the backend's upgrade stack, which no backend guards,
    // so it must end here: an upgrade that cannot be wired becomes a closed
    // socket and a released admission slot, not an exception thrown through a
    // transport callback into whatever the runtime does with one.
    system.log.error(`[ws] hub ${hub.path} refused the connection for ${request.path} — closing it`, e);
    releaseSlot?.();
    try { socket.close(1011, 'connection setup failed'); } catch { /* already closing */ }
  }
}
