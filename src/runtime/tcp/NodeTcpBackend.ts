import { Lazy } from '../../util/Lazy.js';
import type {
  TcpBackend,
  TcpListener,
  TcpSocketHandlers,
  TcpSocketLike,
  TlsTransportSettings,
} from './TcpBackend.js';

/**
 * Node.js implementation of `TcpBackend` — built on `node:net` (plain TCP)
 * and `node:tls` (TLS).  The underlying `net.Socket` / `tls.TLSSocket` is
 * wrapped into a `TcpSocketLike` so the caller never sees Node's
 * EventEmitter surface.
 *
 * `node:net` and `node:tls` are loaded dynamically on first use so the
 * module imports safely under Bun and Deno too.
 */
export class NodeTcpBackend implements TcpBackend {
  async listen(opts: {
    host: string; port: number; tls?: TlsTransportSettings; handlers: TcpSocketHandlers;
  }): Promise<TcpListener> {
    const useTls = !!(opts.tls && opts.tls.cert && opts.tls.key);
    const attach = (raw: NodeSocketLike): void => {
      const sock = wrapSocket(raw);
      raw.on('data', (chunk: Buffer) => opts.handlers.onData(sock, toUint8(chunk)));
      raw.on('close', () => opts.handlers.onClose(sock));
      raw.on('error', (err: Error) => opts.handlers.onError(sock, err));
      opts.handlers.onOpen(sock);
    };
    if (useTls) {
      const tls = await loadTls();
      const server = tls.createServer({
        cert: opts.tls!.cert,
        key: opts.tls!.key,
        ca: opts.tls!.ca,
        requestCert: opts.tls!.requestClientCert ?? false,
        rejectUnauthorized: opts.tls!.rejectUnauthorized ?? true,
      }, attach);
      return startServer(server, opts.host, opts.port);
    }
    const net = await loadNet();
    const server = net.createServer(attach);
    return startServer(server, opts.host, opts.port);
  }

  async connect(opts: {
    host: string; port: number; tls?: TlsTransportSettings; handlers: TcpSocketHandlers;
  }): Promise<TcpSocketLike> {
    const useTls = !!opts.tls;
    let raw: NodeSocketLike;
    if (useTls) {
      const tls = await loadTls();
      raw = tls.connect({
        host: opts.host,
        port: opts.port,
        ca: opts.tls!.ca,
        cert: opts.tls!.cert,
        key: opts.tls!.key,
        servername: opts.tls!.serverName ?? opts.host,
        rejectUnauthorized: opts.tls!.rejectUnauthorized ?? true,
      }) as NodeSocketLike;
    } else {
      const net = await loadNet();
      raw = net.connect({ host: opts.host, port: opts.port }) as NodeSocketLike;
    }
    const sock = wrapSocket(raw);
    raw.on('connect', () => opts.handlers.onOpen(sock));
    raw.on('secureConnect', () => opts.handlers.onOpen(sock)); // fires instead of 'connect' on TLS
    raw.on('data', (chunk: Buffer) => opts.handlers.onData(sock, toUint8(chunk)));
    raw.on('close', () => opts.handlers.onClose(sock));
    raw.on('error', (err: Error) => opts.handlers.onError(sock, err));
    return sock;
  }
}

/* ----------------------------- internals --------------------------------- */

interface Buffer extends Uint8Array {}

interface NodeSocketLike {
  write(data: Uint8Array | string, cb?: () => void): boolean;
  end(): void;
  on(event: 'connect' | 'secureConnect' | 'close', listener: () => void): this;
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  readonly remoteAddress?: string;
}

interface NodeServerLike {
  listen(port: number, host: string, cb?: () => void): void;
  close(cb?: () => void): void;
  address(): { port: number; address: string } | string | null;
  once(event: 'error', l: (err: Error) => void): void;
}

interface NodeNetModule {
  createServer(handler?: (sock: NodeSocketLike) => void): NodeServerLike;
  connect(opts: { host: string; port: number }): NodeSocketLike;
}

interface NodeTlsModule {
  createServer(opts: unknown, handler?: (sock: NodeSocketLike) => void): NodeServerLike;
  connect(opts: unknown): NodeSocketLike;
}

// `Lazy<Promise<…>>` — the thunk returns a Promise, so the Promise itself
// is memoised.  Concurrent callers all await the same in-flight import.
const netLazy: Lazy<Promise<NodeNetModule>> = Lazy.of(async () => {
  const name = 'node:net';
  return (await import(name)) as unknown as NodeNetModule;
});

const tlsLazy: Lazy<Promise<NodeTlsModule>> = Lazy.of(async () => {
  const name = 'node:tls';
  return (await import(name)) as unknown as NodeTlsModule;
});

function loadNet(): Promise<NodeNetModule> { return netLazy.get(); }
function loadTls(): Promise<NodeTlsModule> { return tlsLazy.get(); }

function wrapSocket(raw: NodeSocketLike): TcpSocketLike {
  return {
    write(data: Uint8Array): void { raw.write(data); },
    end(): void { raw.end(); },
    get remoteAddress(): string | undefined { return raw.remoteAddress; },
  };
}

function toUint8(buf: Buffer): Uint8Array {
  // Node Buffers are Uint8Array instances with `.buffer`/`.byteOffset`/`.byteLength`.
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function startServer(server: NodeServerLike, host: string, port: number): Promise<TcpListener> {
  return new Promise<TcpListener>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      resolve({
        port: actualPort,
        close(): Promise<void> {
          return new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
  });
}
