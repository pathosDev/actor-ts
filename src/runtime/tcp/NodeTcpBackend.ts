import { Lazy } from '../../util/Lazy.js';
import { listenerTlsOptions, listenerUsesTls, toPeerCertificate } from './TcpBackend.js';
import type {
  PeerCertificate,
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
  /**
   * @param modules Where `node:net` and `node:tls` come from: the runtime's
   *   own, imported on first use.  Replaceable for one reason — a test that
   *   needs a dial to stay in its TCP connect until it says so has no other
   *   way to get one, since a loopback connect lands before anything can
   *   abort it and an unroutable address fails fast on some networks.
   */
  constructor(private readonly modules: NodeSocketModules = runtimeSocketModules) {}

  async listen(options: {
    host: string; port: number; tls?: TlsTransportOptionsType; handlers: TcpSocketHandlers;
  }): Promise<TcpListener> {
    const attach = (raw: NodeSocketLike): void => {
      const sock = wrapSocket(raw);
      raw.on('data', (chunk: Uint8Array) => options.handlers.onData(sock, toUint8(chunk)));
      raw.on('close', () => options.handlers.onClose(sock));
      raw.on('error', (err: Error) => options.handlers.onError(sock, err));
      options.handlers.onOpen(sock);
    };
    // `listenerUsesTls` both decides and validates — a half-configured `tls`
    // throws here instead of falling through to a plaintext bind (#144).
    if (listenerUsesTls(options.tls, 'Node.js')) {
      const serverTlsOptions = listenerTlsOptions(options.tls, 'Node.js');
      const tls = await this.modules.tls();
      const server = tls.createServer(serverTlsOptions, attach);
      return startServer(server, options.host, options.port);
    }
    const net = await this.modules.net();
    const server = net.createServer(attach);
    return startServer(server, options.host, options.port);
  }

  async connect(options: {
    host: string;
    port: number;
    tls?: TlsTransportOptionsType;
    handlers: TcpSocketHandlers;
    signal?: AbortSignal;
  }): Promise<TcpSocketLike> {
    const { host, port, tls, handlers, signal } = options;
    // Asked again once the module is loaded: the first dial `import()`s it,
    // and an abort that lands meanwhile must dial nothing at all — dialling
    // and then destroying still sends a SYN to a peer that was given up on.
    signal?.throwIfAborted();
    let raw: NodeSocketLike;
    if (tls === undefined) {
      const net = await this.modules.net();
      signal?.throwIfAborted();
      raw = net.connect({ host, port });
    } else {
      const tlsModule = await this.modules.tls();
      // For `isIP` alone — see `serverNameOption`.
      const net = await this.modules.net();
      signal?.throwIfAborted();
      raw = tlsModule.connect({
        host,
        port,
        ca: tls.ca,
        cert: tls.cert,
        key: tls.key,
        ...serverNameOption(tls.serverName, host, net),
        rejectUnauthorized: tls.rejectUnauthorized ?? true,
      });
    }
    // One open event per dial, never both.  A TLS socket emits `connect` when
    // the TCP connect lands *and* `secureConnect` when the handshake does — on
    // Node and on Bun's `node:tls` alike — so listening for both opened every
    // TLS dial twice, and every caller wrote its `hello` twice (#1475).  The
    // later one is the open that matters: before it nothing is verified.
    const openEvent = tls === undefined ? 'connect' : 'secureConnect';
    return settleOnOpen(raw, openEvent, handlers, signal, `${host}:${port}`);
  }
}

/* ----------------------------- internals --------------------------------- */

/**
 * The name a TLS dial announces through SNI, if it has one to announce
 * (#1475).
 *
 * A configured `serverName` is announced as configured.  Without one the host
 * stands in — unless the host is an IP literal.  RFC 6066 admits only host
 * names to SNI, and `node:tls` enforces it: `tls.connect` throws
 * `ERR_INVALID_ARG_VALUE` for an IP before a byte is sent, on Node and on
 * Bun's `node:tls` alike, so announcing the host unconditionally meant that no
 * TLS dial to an IP-addressed peer ever completed.  Announcing nothing costs an
 * IP-addressed peer nothing: `node:tls` verifies the certificate against the
 * announced name or, without one, against the host it dialled — for an IP
 * literal, the certificate's IP SAN, which is the check an IP-addressed
 * cluster wants.
 *
 * Asked of the runtime's own `net.isIP` rather than of a pattern here, because
 * that is the predicate `node:tls` throws on: the two cannot disagree about
 * what an IP literal is.
 */
function serverNameOption(
  configured: string | undefined,
  host: string,
  net: Pick<NodeNetModule, 'isIP'>,
): { readonly servername?: string } {
  if (configured !== undefined) return { servername: configured };
  return net.isIP(host) === 0 ? { servername: host } : {};
}

/** Where a dial stands: still connecting, handed to the caller, or given up. */
type DialState = 'dialing' | 'open' | 'abandoned';

/**
 * Settle a dial on its socket's own events, per the `TcpBackend.connect`
 * contract: resolve on the open event, reject on an error or a close that
 * comes first, and give the dial up on `signal`.
 *
 * Every listener stays attached for the socket's life and asks the dial's
 * state first, rather than being removed as the state changes.  That keeps an
 * `error` listener on the socket for good — a socket with none turns its next
 * error into an uncaught exception — and it is what silences a dial once it
 * is given up: the socket goes on emitting (`destroy()` still fires `close`),
 * and nothing it emits reaches a handler.
 */
function settleOnOpen(
  raw: NodeSocketLike,
  openEvent: 'connect' | 'secureConnect',
  handlers: TcpSocketHandlers,
  signal: AbortSignal | undefined,
  target: string,
): Promise<TcpSocketLike> {
  return new Promise<TcpSocketLike>((resolve, reject) => {
    const sock = wrapSocket(raw);
    let state: DialState = 'dialing';
    const giveUp = (reason: unknown): void => {
      state = 'abandoned';
      signal?.removeEventListener('abort', onAbort);
      // Destroyed, not ended: `end()` on a socket still in its TCP connect
      // lets the connect run on to the OS timeout (#1475).
      raw.destroy();
      reject(reason);
    };
    const onAbort = (): void => {
      if (state === 'dialing') giveUp(signal?.reason);
    };
    raw.on(openEvent, () => {
      if (state !== 'dialing') return;
      state = 'open';
      signal?.removeEventListener('abort', onAbort);
      handlers.onOpen(sock);
      resolve(sock);
    });
    raw.on('data', (chunk: Uint8Array) => {
      if (state === 'open') handlers.onData(sock, toUint8(chunk));
    });
    raw.on('close', () => {
      if (state === 'open') handlers.onClose(sock);
      else if (state === 'dialing') giveUp(new Error(`the connection to ${target} closed before it opened`));
    });
    raw.on('error', (err: Error) => {
      if (state === 'open') handlers.onError(sock, err);
      else if (state === 'dialing') giveUp(err);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The slice of a `net.Socket` / `tls.TLSSocket` this adapter uses. */
export interface NodeSocketLike {
  write(data: Uint8Array | string, callback?: () => void): boolean;
  end(): void;
  /** `net.Socket.destroy()` — closes both halves at once, unlike `end()`. */
  destroy(): void;
  on(event: 'connect' | 'secureConnect' | 'close', listener: () => void): this;
  on(event: 'data', listener: (chunk: Uint8Array) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  readonly remoteAddress?: string;
  /** Present on `tls.TLSSocket` only — a plain `net.Socket` has no such method. */
  getPeerCertificate?(): unknown;
}

/** The slice of a `net.Server` / `tls.Server` this adapter uses. */
export interface NodeServerLike {
  listen(port: number, host: string, callback?: () => void): void;
  close(callback?: () => void): void;
  address(): { port: number; address: string } | string | null;
  once(event: 'error', l: (err: Error) => void): void;
}

/** The slice of `node:net` this adapter uses. */
export interface NodeNetModule {
  createServer(handler?: (sock: NodeSocketLike) => void): NodeServerLike;
  connect(options: { host: string; port: number }): NodeSocketLike;
  /** `0` for anything that is not an IP literal, else the IP version — the predicate `node:tls` checks a server name with. */
  isIP(input: string): number;
}

/** The slice of `node:tls` this adapter uses. */
export interface NodeTlsModule {
  createServer(options: unknown, handler?: (sock: NodeSocketLike) => void): NodeServerLike;
  connect(options: unknown): NodeSocketLike;
}

/** Where {@link NodeTcpBackend} gets its socket modules from. */
export interface NodeSocketModules {
  net(): Promise<NodeNetModule>;
  tls(): Promise<NodeTlsModule>;
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

/** The runtime's own modules, imported once and shared by every instance. */
const runtimeSocketModules: NodeSocketModules = {
  net: () => netLazy.get(),
  tls: () => tlsLazy.get(),
};

function wrapSocket(raw: NodeSocketLike): TcpSocketLike {
  return {
    write(data: Uint8Array): void { raw.write(data); },
    end(): void { raw.end(); },
    destroy(): void { raw.destroy(); },
    get remoteAddress(): string | undefined { return raw.remoteAddress; },
    // Read on demand, not captured at wrap time: a plain `net.Socket` has no
    // such method at all, and the value is only meaningful once the handshake
    // has run.  `getPeerCertificate()` returns `{}` when the peer presented
    // nothing, which `toPeerCertificate` maps to `undefined`.
    peerCertificate(): PeerCertificate | undefined {
      return toPeerCertificate(raw.getPeerCertificate?.());
    },
  };
}

function toUint8(buffer: Uint8Array): Uint8Array {
  // A Node `Buffer` is a `Uint8Array` subclass; a plain view over the same
  // bytes keeps `Buffer`'s overridden methods away from the decoder.
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
