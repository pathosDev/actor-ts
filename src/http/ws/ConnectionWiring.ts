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
import type { WebSocketSocketAdapter } from './SocketAdapter.js';

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
