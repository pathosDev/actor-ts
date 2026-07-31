import type {
  TcpBackend,
  TcpListener,
  TcpSocketHandlers,
  TcpSocketLike,
  TlsTransportOptionsType,
} from './TcpBackend.js';

/**
 * Bun implementation of `TcpBackend` — wraps `Bun.listen` / `Bun.connect`.
 *
 * Bun's sockets already match `TcpSocketLike` structurally, so both
 * callbacks (`listen`'s socket.open/data/close/error and `connect`'s
 * equivalent) are forwarded almost verbatim.  We intentionally do NOT
 * touch `sock.data` — the transport keeps its own `WeakMap<socket, conn>`.
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
        open: (s: BunSocketNative) => options.handlers.onOpen(s),
        data: (s: BunSocketNative, chunk: Uint8Array) => options.handlers.onData(s, chunk),
        close: (s: BunSocketNative) => options.handlers.onClose(s),
        error: (s: BunSocketNative, err: Error) => options.handlers.onError(s, err),
      },
    };
    if (options.tls?.cert && options.tls.key) {
      listenOptions.tls = {
        cert: options.tls.cert,
        key: options.tls.key,
        ca: options.tls.ca,
        requestCert: options.tls.requestClientCert ?? false,
        rejectUnauthorized: options.tls.rejectUnauthorized ?? true,
      };
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
        open: (s: BunSocketNative) => options.handlers.onOpen(s),
        data: (s: BunSocketNative, chunk: Uint8Array) => options.handlers.onData(s, chunk),
        close: (s: BunSocketNative) => options.handlers.onClose(s),
        error: (s: BunSocketNative, err: Error) => options.handlers.onError(s, err),
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
    const ready = bun.connect(connectOptions);
    return Promise.resolve(ready);
  }
}

/* ----------------------------- internals --------------------------------- */

interface BunSocketNative {
  write(data: Uint8Array | string): number;
  end(): void;
  remoteAddress?: string;
}

interface BunGlobal {
  listen(options: unknown): { stop(): void; port?: number };
  connect(options: unknown): Promise<BunSocketNative> | BunSocketNative;
}
