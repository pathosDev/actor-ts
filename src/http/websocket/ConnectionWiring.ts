/**
 * Shared connection-wiring layer.  Everything that turns an accepted
 * upgrade into a live actor-backed connection lives here, so the three
 * HTTP backends stay thin (they only produce a
 * {@link WebsocketSocketAdapter}).
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
import type { WebsocketSocketAdapter } from './SocketAdapter.js';
import { WebsocketAcceptSignal, type WebsocketServerRef } from './WebsocketMessages.js';
import { WebsocketConnectionActor } from './WebsocketConnectionActor.js';
import type { WebsocketCodec } from './WebsocketCodec.js';
import type { ResolvedWebsocketPolicy } from './WebsocketPolicy.js';
import type { WebsocketUpgradeInfo } from './types.js';

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
 * Turn one accepted upgrade into a live actor-backed connection.  Called
 * synchronously from the backend's upgrade callback (via the route's
 * `connect` handler).
 *
 * It does NOT spawn or attach anything itself — instead it tells the hub
 * a {@link WebsocketAcceptSignal} carrying the per-connection actor's `Props`, so
 * the hub spawns that actor as its OWN child (`server → conn-N`).  The
 * child then creates the {@link WebsocketConnection}, reports `connected`, and
 * attaches the socket listeners in its `preStart`.
 *
 * First-frame race: the socket adapter attaches its native listeners
 * synchronously at upgrade and BUFFERS inbound frames until the child's
 * `setListeners` runs — so nothing is lost between upgrade and the child
 * becoming ready.
 */
export function wireConnection<TOut, TIn, TSelf = never>(
  _system: ActorSystem,
  hub: WebsocketServerRef<TOut, TIn, TSelf>,
  req: HttpRequest,
  socket: WebsocketSocketAdapter,
  codec: WebsocketCodec<TOut, TIn>,
  policy: ResolvedWebsocketPolicy,
): void {
  const id = `ws-${++connectionCounter}`;
  const upgrade: WebsocketUpgradeInfo = {
    path: req.path,
    params: req.params,
    query: req.query,
    headers: req.headers,
    remoteAddress: req.remoteAddress ?? socket.remoteAddress,
    subprotocol: socket.protocol,
  };

  const props = Props.create(
    () => new WebsocketConnectionActor<TOut, TIn, TSelf>({ socket, codec, policy, hub, id, upgrade }),
  );
  hub.tell(new WebsocketAcceptSignal(props as unknown as Props<unknown>, id), null);
}
