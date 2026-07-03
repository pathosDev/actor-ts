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
import { WsConnectionImpl, type WsConnection } from './WsConnection.js';
import { WsConnectedSignal, WsDataSignal, WsDisconnectedSignal, WsInvalidSignal, type WsServerRef } from './WsMessages.js';
import { WebSocketSessionActor } from './WebSocketSessionActor.js';
import { WsDecodeError, type WsCodec } from './WsCodec.js';
import type { ResolvedWsPolicy } from './WsPolicy.js';
import { frameByteLength, normalizeInbound } from './types.js';

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
 * Turn one accepted upgrade into a live actor-backed connection.  Called
 * synchronously from the backend's upgrade callback (via the route's
 * `connect` handler).  This is the single place that solves the
 * first-frame race:
 *
 *   1. Spawn the per-connection session actor (returns synchronously).
 *   2. Build the {@link WsConnection} and tell the hub `connected` —
 *      queued in the hub's mailbox before any data.
 *   3. Attach socket listeners **synchronously**.  Inbound frames are
 *      size-checked, decoded, and told to the (already-alive) hub with
 *      this connection as the sender.  Nothing can be lost between
 *      upgrade and listener attach.
 */
export function wireConnection<TOut, TIn, TSelf = never>(
  system: ActorSystem,
  hub: WsServerRef<TOut, TIn, TSelf>,
  req: HttpRequest,
  socket: WebSocketSocketAdapter,
  codec: WsCodec<TOut, TIn>,
  policy: ResolvedWsPolicy,
): WsConnection<TOut> {
  const id = `ws-${++connectionCounter}`;
  const upgrade = {
    path: req.path,
    params: req.params,
    query: req.query,
    headers: req.headers,
    remoteAddress: req.remoteAddress ?? socket.remoteAddress,
    subprotocol: socket.protocol,
  };

  const sessionRef = system.spawnAnonymous(
    Props.create(() => new WebSocketSessionActor<TOut, TIn>(socket, codec, policy)),
  );
  const connection: WsConnection<TOut> = new WsConnectionImpl<TOut>(id, upgrade, socket, sessionRef, system.name);

  // 'connected' before listeners → mailbox-ordered before any data.
  hub.tell(new WsConnectedSignal<TOut>(connection), connection);

  let closed = false;
  socket.setListeners({
    onMessage: (data) => {
      const frame = normalizeInbound(data);
      if (!frame) {
        system.log.warn('websocket: unrecognised inbound frame type — dropped');
        return;
      }
      if (frameByteLength(frame) > policy.maxFrameBytes) {
        if (policy.onOversizeFrame === 'close') {
          socket.close(1009, 'message too big');
        } else {
          system.log.warn(`websocket: dropped oversize inbound frame (> ${policy.maxFrameBytes} bytes)`);
        }
        return;
      }
      let decoded: TIn;
      try {
        decoded = codec.decode(frame);
      } catch (err) {
        const decodeErr = err instanceof WsDecodeError ? err : new WsDecodeError(String(err), frame);
        if (policy.onInvalidMessage === 'close') {
          socket.close(1003, 'unsupported data');
        } else if (policy.onInvalidMessage === 'hook') {
          hub.tell(new WsInvalidSignal<TOut>(connection, decodeErr), connection);
        } else {
          system.log.warn(`websocket: invalid inbound message — dropped: ${decodeErr.message}`);
        }
        return;
      }
      hub.tell(new WsDataSignal<TOut, TIn>(connection, decoded), connection);
    },
    onClose: (code, reason) => {
      if (closed) return;
      closed = true;
      hub.tell(
        new WsDisconnectedSignal<TOut>(connection, { code, reason, initiatedBy: 'client' }),
        connection,
      );
      sessionRef.stop();
    },
    onError: (err) => {
      system.log.warn(`websocket: socket error on ${id}: ${err.message}`);
    },
  });

  return connection;
}
