import { listenerTlsOptions, toPeerCertificate } from './TcpBackend.js';
import type {
  PeerCertificate,
  TcpBackend,
  TcpListener,
  TcpSocketHandlers,
  TcpSocketLike,
  TlsTransportOptionsType,
} from './TcpBackend.js';

/**
 * Bun implementation of `TcpBackend` — wraps `Bun.listen` / `Bun.connect`.
 *
 * Bun's sockets satisfy most of `TcpSocketLike` structurally, but not
 * `peerCertificate()`, so every callback goes through {@link wrapSocket}.
 * That wrapper is memoised per native socket: the transport keys its
 * per-connection state on socket identity, so handing out a fresh object
 * per callback would break every lookup after `open`.  We intentionally do
 * NOT touch `sock.data` — the transport keeps its own `WeakMap<socket, conn>`.
 */
export class BunTcpBackend implements TcpBackend {
  async listen(options: {
    host: string; port: number; tls?: TlsTransportOptionsType; handlers: TcpSocketHandlers;
  }): Promise<TcpListener> {
    const bun = (globalThis as { Bun?: BunGlobal }).Bun;
    if (!bun) throw new Error('BunTcpBackend: globalThis.Bun is not defined');

    const listenOptions: Record<string, unknown> = {
      hostname: options.host,
      port: options.port,
      socket: {
        open: (s: BunSocketNative) => options.handlers.onOpen(wrapSocket(s)),
        data: (s: BunSocketNative, chunk: Uint8Array) => options.handlers.onData(wrapSocket(s), chunk),
        close: (s: BunSocketNative) => options.handlers.onClose(wrapSocket(s)),
        error: (s: BunSocketNative, err: Error) => options.handlers.onError(wrapSocket(s), err),
      },
    };
    if (options.tls?.cert && options.tls.key) {
      listenOptions.tls = listenerTlsOptions(options.tls, 'Bun');
    }
    const server = bun.listen(listenOptions);
    return {
      get port(): number { return server.port ?? options.port; },
      close: (): void => server.stop(),
    };
  }

  async connect(options: {
    host: string; port: number; tls?: TlsTransportOptionsType; handlers: TcpSocketHandlers;
  }): Promise<TcpSocketLike> {
    const bun = (globalThis as { Bun?: BunGlobal }).Bun;
    if (!bun) throw new Error('BunTcpBackend: globalThis.Bun is not defined');
    const connectOptions: Record<string, unknown> = {
      hostname: options.host,
      port: options.port,
      socket: {
        open: (s: BunSocketNative) => options.handlers.onOpen(wrapSocket(s)),
        data: (s: BunSocketNative, chunk: Uint8Array) => options.handlers.onData(wrapSocket(s), chunk),
        close: (s: BunSocketNative) => options.handlers.onClose(wrapSocket(s)),
        error: (s: BunSocketNative, err: Error) => options.handlers.onError(wrapSocket(s), err),
      },
    };
    if (options.tls) {
      connectOptions.tls = {
        ca: options.tls.ca,
        cert: options.tls.cert,
        key: options.tls.key,
        serverName: options.tls.serverName ?? options.host,
        rejectUnauthorized: options.tls.rejectUnauthorized ?? true,
      };
    }
    const ready = await bun.connect(connectOptions);
    return wrapSocket(ready);
  }
}

/* ----------------------------- internals --------------------------------- */

interface BunSocketNative {
  write(data: Uint8Array | string): number;
  end(): void;
  remoteAddress?: string;
  /** Bun mirrors Node's TLS socket API; absent on a plaintext socket. */
  getPeerCertificate?(): unknown;
}

/**
 * One `TcpSocketLike` per native socket, for the lifetime of that socket.
 *
 * Bun hands the *same* native socket to `open`, `data`, `close` and `error`,
 * and `TcpTransport` keys its per-connection state on
 * `WeakMap<TcpSocketLike, …>` — so a fresh wrapper per callback would make
 * every lookup after `open` miss.  A `WeakMap` keyed on the native socket
 * keeps identity stable and lets both die together.
 */
const wrappers = new WeakMap<BunSocketNative, TcpSocketLike>();

function wrapSocket(socket: BunSocketNative): TcpSocketLike {
  const existing = wrappers.get(socket);
  if (existing) return existing;
  const wrapper: TcpSocketLike = {
    write(data: Uint8Array): void { socket.write(data); },
    end(): void { socket.end(); },
    get remoteAddress(): string | undefined { return socket.remoteAddress; },
    // Read on demand.  Bun runs `open` *before* the TLS handshake completes —
    // `authorized` is still false there and no certificate is available — so
    // capturing this eagerly would silently yield nothing on Bun while
    // working on Node.  Any inbound frame implies a finished handshake.
    peerCertificate(): PeerCertificate | undefined {
      return toPeerCertificate(socket.getPeerCertificate?.());
    },
  };
  wrappers.set(socket, wrapper);
  return wrapper;
}

interface BunGlobal {
  listen(options: unknown): { stop(): void; port?: number };
  connect(options: unknown): Promise<BunSocketNative> | BunSocketNative;
}
