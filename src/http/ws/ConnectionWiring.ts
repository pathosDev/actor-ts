/**
 * Shared connection-wiring layer.  Everything that turns an accepted
 * upgrade into a live actor-backed connection lives here, so the three
 * HTTP backends stay thin (they only produce a
 * {@link WebSocketSocketAdapter}).
 *
 * This file grows across the WebSocket work:
 *   - {@link ConnectionTracker} / {@link trackSocket} — shutdown bookkeeping
 *     (used by `HttpExtension.bind`'s unbind path).
 *   - `wireConnection` — spawns the per-connection session actor and
 *     attaches listeners synchronously (added with the actor layer).
 */
import type { ActorSystem } from '../../ActorSystem.js';
import { Props } from '../../Props.js';
import type { HttpRequest } from '../types.js';
import type { WebSocketSocketAdapter } from './SocketAdapter.js';
import { WsAcceptSignal, type WsServerRef } from './WsMessages.js';
import { WebSocketConnectionActor } from './WebSocketConnectionActor.js';
import type { WsCodec } from './WsCodec.js';
import type { ResolvedWsPolicy } from './WsPolicy.js';
import type { WsUpgradeInfo } from './types.js';

/**
 * Tracks the live server-side sockets of one binding so `unbind()` can
 * close them.  Without this a long-lived WebSocket keeps the HTTP
 * server's `close()` pending forever (the process refuses to exit).
 */
export class ConnectionTracker {
  private readonly sockets = new Set<WebSocketSocketAdapter>();

  add(socket: WebSocketSocketAdapter): void {
    this.sockets.add(socket);
  }

  remove(socket: WebSocketSocketAdapter): void {
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
  socket: WebSocketSocketAdapter,
): WebSocketSocketAdapter {
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
 * (SECURITY_AUDIT.md WS-5).  Keyed by the hub ref (one per route); increments
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
  socket: WebSocketSocketAdapter,
  onClosed: () => void,
): WebSocketSocketAdapter {
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
 * Turn one accepted upgrade into a live actor-backed connection.  Called
 * synchronously from the backend's upgrade callback (via the route's
 * `connect` handler).
 *
 * It does NOT spawn or attach anything itself — instead it tells the hub
 * a {@link WsAcceptSignal} carrying the per-connection actor's `Props`, so
 * the hub spawns that actor as its OWN child (`server → conn-N`).  The
 * child then creates the {@link WsConnection}, reports `connected`, and
 * attaches the socket listeners in its `preStart`.
 *
 * First-frame race: the socket adapter attaches its native listeners
 * synchronously at upgrade and BUFFERS inbound frames until the child's
 * `setListeners` runs — so nothing is lost between upgrade and the child
 * becoming ready.
 */
export function wireConnection<TOut, TIn, TSelf = never>(
  _system: ActorSystem,
  hub: WsServerRef<TOut, TIn, TSelf>,
  req: HttpRequest,
  socket: WebSocketSocketAdapter,
  codec: WsCodec<TOut, TIn>,
  policy: ResolvedWsPolicy,
): void {
  // Admission cap (SECURITY_AUDIT.md WS-5): when the route is at its
  // connection limit, close the freshly-upgraded socket with 1013 ("try
  // again later") instead of wiring an actor for it.  Unlimited by default
  // (`policy.maxConnections === Infinity`).
  const cap = policy.maxConnections;
  if (Number.isFinite(cap)) {
    const hubKey = hub as unknown as object;
    const live = liveConnectionsByHub.get(hubKey) ?? 0;
    if (live >= cap) {
      try { socket.close(1013, 'server at capacity'); } catch { /* already closing */ }
      return;
    }
    liveConnectionsByHub.set(hubKey, live + 1);
    socket = decrementOnClose(socket, () => {
      liveConnectionsByHub.set(hubKey, Math.max(0, (liveConnectionsByHub.get(hubKey) ?? 1) - 1));
    });
  }
  const id = `ws-${++connectionCounter}`;
  const upgrade: WsUpgradeInfo = {
    path: req.path,
    params: req.params,
    query: req.query,
    headers: req.headers,
    remoteAddress: req.remoteAddress ?? socket.remoteAddress,
    subprotocol: socket.protocol,
  };

  const props = Props.create(
    () => new WebSocketConnectionActor<TOut, TIn, TSelf>({ socket, codec, policy, hub, id, upgrade }),
  );
  hub.tell(new WsAcceptSignal(props as unknown as Props<unknown>, id), null);
}
