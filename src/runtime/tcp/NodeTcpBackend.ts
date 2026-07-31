import { Lazy } from '../../util/Lazy.js';
import type {
  TcpBackend,
  TcpListener,
  TcpSocketHandlers,
  TcpSocketLike,
  TlsTransportOptionsType,
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
  async listen(options: {
    host: string; port: number; tls?: TlsTransportOptionsType; handlers: TcpSocketHandlers;
  }): Promise<TcpListener> {
    const useTls = !!(options.tls && options.tls.cert && options.tls.key);
    const attach = (raw: NodeSocketLike): void => {
      const sock = wrapSocket(raw);
      raw.on('data', (chunk: Buffer) => options.handlers.onData(sock, toUint8(chunk)));
      raw.on('close', () => options.handlers.onClose(sock));
      raw.on('error', (err: Error) => options.handlers.onError(sock, err));
      options.handlers.onOpen(sock);
    };
    if (useTls) {
      const tls = await loadTls();
      const server = tls.createServer({
        cert: options.tls!.cert,
        key: options.tls!.key,
        ca: options.tls!.ca,
        requestCert: options.tls!.requestClientCert ?? false,
        rejectUnauthorized: options.tls!.rejectUnauthorized ?? true,
      }, attach);
      return startServer(server, options.host, options.port);
    }
    const net = await loadNet();
    const server = net.createServer(attach);
    return startServer(server, options.host, options.port);
  }

  async connect(options: {
    host: string; port: number; tls?: TlsTransportOptionsType; handlers: TcpSocketHandlers;
  }): Promise<TcpSocketLike> {
    const useTls = !!options.tls;
    let raw: NodeSocketLike;
    if (useTls) {
      const tls = await loadTls();
      raw = tls.connect({
        host: options.host,
        port: options.port,
        ca: options.tls!.ca,
        cert: options.tls!.cert,
        key: options.tls!.key,
        servername: options.tls!.serverName ?? options.host,
        rejectUnauthorized: options.tls!.rejectUnauthorized ?? true,
      }) as NodeSocketLike;
    } else {
      const net = await loadNet();
      raw = net.connect({ host: options.host, port: options.port }) as NodeSocketLike;
    }
    const sock = wrapSocket(raw);
    raw.on('connect', () => options.handlers.onOpen(sock));
    raw.on('secureConnect', () => options.handlers.onOpen(sock)); // fires instead of 'connect' on TLS
    raw.on('data', (chunk: Buffer) => options.handlers.onData(sock, toUint8(chunk)));
    raw.on('close', () => options.handlers.onClose(sock));
    raw.on('error', (err: Error) => options.handlers.onError(sock, err));
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
  connect(options: { host: string; port: number }): NodeSocketLike;
}

interface NodeTlsModule {
  createServer(options: unknown, handler?: (sock: NodeSocketLike) => void): NodeServerLike;
  connect(options: unknown): NodeSocketLike;
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

function toUint8(buffer: Buffer): Uint8Array {
  // Node Buffers are Uint8Array instances with `.buffer`/`.byteOffset`/`.byteLength`.
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
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
