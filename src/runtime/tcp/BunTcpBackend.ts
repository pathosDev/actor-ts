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
  async listen(opts: {
    host: string; port: number; tls?: TlsTransportOptionsType; handlers: TcpSocketHandlers;
  }): Promise<TcpListener> {
    const bun = (globalThis as { Bun?: BunGlobal }).Bun;
    if (!bun) throw new Error('BunTcpBackend: globalThis.Bun is not defined');

    const listenOpts: Record<string, unknown> = {
      hostname: opts.host,
      port: opts.port,
      socket: {
        open: (s: BunSocketNative) => opts.handlers.onOpen(s),
        data: (s: BunSocketNative, chunk: Uint8Array) => opts.handlers.onData(s, chunk),
        close: (s: BunSocketNative) => opts.handlers.onClose(s),
        error: (s: BunSocketNative, err: Error) => opts.handlers.onError(s, err),
      },
    };
    if (opts.tls?.cert && opts.tls.key) {
      listenOpts.tls = {
        cert: opts.tls.cert,
        key: opts.tls.key,
        ca: opts.tls.ca,
        requestCert: opts.tls.requestClientCert ?? false,
        rejectUnauthorized: opts.tls.rejectUnauthorized ?? true,
      };
    }
    const server = bun.listen(listenOpts);
    return {
      get port(): number { return server.port ?? opts.port; },
      close: (): void => server.stop(),
    };
  }

  async connect(opts: {
    host: string; port: number; tls?: TlsTransportOptionsType; handlers: TcpSocketHandlers;
  }): Promise<TcpSocketLike> {
    const bun = (globalThis as { Bun?: BunGlobal }).Bun;
    if (!bun) throw new Error('BunTcpBackend: globalThis.Bun is not defined');
    const connectOpts: Record<string, unknown> = {
      hostname: opts.host,
      port: opts.port,
      socket: {
        open: (s: BunSocketNative) => opts.handlers.onOpen(s),
        data: (s: BunSocketNative, chunk: Uint8Array) => opts.handlers.onData(s, chunk),
        close: (s: BunSocketNative) => opts.handlers.onClose(s),
        error: (s: BunSocketNative, err: Error) => opts.handlers.onError(s, err),
      },
    };
    if (opts.tls) {
      connectOpts.tls = {
        ca: opts.tls.ca,
        cert: opts.tls.cert,
        key: opts.tls.key,
        serverName: opts.tls.serverName ?? opts.host,
        rejectUnauthorized: opts.tls.rejectUnauthorized ?? true,
      };
    }
    const ready = bun.connect(connectOpts);
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
  listen(opts: unknown): { stop(): void; port?: number };
  connect(opts: unknown): Promise<BunSocketNative> | BunSocketNative;
}
