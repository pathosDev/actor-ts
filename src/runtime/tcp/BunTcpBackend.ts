import { NodeTcpBackend } from './NodeTcpBackend.js';
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
 * Bun implementation of `TcpBackend` — wraps `Bun.listen` / `Bun.connect`.
 *
 * Bun's sockets satisfy most of `TcpSocketLike` structurally, but not
 * `peerCertificate()`, so every callback goes through {@link wrapSocket}.
 * That wrapper is memoised per native socket: the transport keys its
 * per-connection state on socket identity, so handing out a fresh object
 * per callback would break every lookup after `open`.  We intentionally do
 * NOT touch `sock.data` — the transport keeps its own `WeakMap<socket, conn>`.
 *
 * A dial that carries a `signal` does not use `Bun.connect` at all — see
 * {@link connect}.
 */
export class BunTcpBackend implements TcpBackend {
  /**
   * @param cancellable What a dial carrying a `signal` goes through: by
   *   default {@link NodeTcpBackend}, which on Bun runs on Bun's own
   *   `node:net` and `node:tls`.  Replaceable so a test can see which path a
   *   dial took.
   */
  constructor(private readonly cancellable: Pick<TcpBackend, 'connect'> = new NodeTcpBackend()) {}

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
    // `listenerUsesTls` both decides and validates — a half-configured `tls`
    // throws here instead of falling through to a plaintext bind (#144).
    if (listenerUsesTls(options.tls, 'Bun')) {
      listenOptions.tls = listenerTlsOptions(options.tls, 'Bun');
    }
    const server = bun.listen(listenOptions);
    return {
      get port(): number { return server.port ?? options.port; },
      close: (): void => server.stop(),
    };
  }

  /**
   * Dial natively — unless the dial may have to be given up.
   *
   * `Bun.connect` takes no signal and nothing cancels it: a dial abandoned on
   * it went on connecting for about 21 s, and on Windows Bun 1.4.2 then
   * reported the unanswered SYN as `ECONNREFUSED`.  Bun's `node:net` and
   * `node:tls` destroy a pending socket within milliseconds, so a dial with a
   * `signal` goes through them, and keeps the `TcpBackend.connect` contract on
   * an abort.  A dial without one stays native, and is settled by
   * {@link dialNatively} rather than by `Bun.connect`'s own promise.
   */
  async connect(options: {
    host: string;
    port: number;
    tls?: TlsTransportOptionsType;
    handlers: TcpSocketHandlers;
    signal?: AbortSignal;
  }): Promise<TcpSocketLike> {
    if (options.signal !== undefined) return this.cancellable.connect(options);
    const bun = (globalThis as { Bun?: BunGlobal }).Bun;
    if (!bun) throw new Error('BunTcpBackend: globalThis.Bun is not defined');
    // Only a verifying TLS dial checks the peer's identity itself, and it needs
    // the check in hand before the handshake reports — the handler is synchronous.
    const verifies = options.tls !== undefined && (options.tls.rejectUnauthorized ?? true);
    const checkIdentity = verifies ? (await import('node:tls')).checkServerIdentity : undefined;
    return dialNatively(bun, options, checkIdentity);
  }
}

/* ----------------------------- internals --------------------------------- */

/** Where a native dial stands.  The caller's handlers run only once it is `open`. */
type NativeDialState = 'dialing' | 'open' | 'failed';

/**
 * `Bun.connect`, settled the way `TcpBackend.connect` promises: resolved once
 * the socket is open — over TLS, once the handshake is done — and rejected,
 * with no handler run, when it never opens.
 *
 * `Bun.connect`'s promise says neither.  Over TLS it resolves at the TCP
 * connect, and Bun drops what is written before the handshake completes —
 * `write` answers 0 — so a caller that wrote as soon as it resumed lost those
 * bytes: the first batch of a GELF or syslog sink, on every fresh connection
 * (#1475).  A peer whose certificate the CA does not sign resolved it too,
 * followed by `open` and `close`.  Given a `handshake` handler, Bun runs `open`
 * at the TCP connect and reports the handshake, verdict included, on its own;
 * so a TLS dial opens on that report and a plaintext one on `open`.  The
 * verdict is meant to fold in the caller's `rejectUnauthorized`, so that a
 * peer that could not be verified is a success exactly when the caller opted
 * out of verifying it.
 *
 * A verifying dial does not rest on that one flag (#1793): it opens only on a
 * success that carries no authorization error and whose peer certificate
 * passes `checkServerIdentity` for the name the handshake was made for — the
 * checks `node:tls` makes itself.  Where the runtime's verdict is right, they
 * agree with it; they cost one certificate read per dial.
 */
function dialNatively(
  bun: BunGlobal,
  options: { host: string; port: number; tls?: TlsTransportOptionsType; handlers: TcpSocketHandlers },
  checkIdentity?: CheckServerIdentity,
): Promise<TcpSocketLike> {
  const { handlers, tls } = options;
  const target = `${options.host}:${options.port}`;
  return new Promise<TcpSocketLike>((resolve, reject) => {
    let state: NativeDialState = 'dialing';
    const open = (socket: BunSocketNative): void => {
      if (state !== 'dialing') return;
      state = 'open';
      const wrapped = wrapSocket(socket);
      handlers.onOpen(wrapped);
      resolve(wrapped);
    };
    const fail = (socket: BunSocketNative | undefined, reason: unknown): void => {
      if (state !== 'dialing') return;
      state = 'failed';
      socket?.terminate();
      reject(reason);
    };
    const socketHandlers: Record<string, unknown> = {
      open: (s: BunSocketNative) => { if (tls === undefined) open(s); },
      data: (s: BunSocketNative, chunk: Uint8Array) => {
        if (state === 'open') handlers.onData(wrapSocket(s), chunk);
      },
      close: (s: BunSocketNative) => {
        if (state === 'open') handlers.onClose(wrapSocket(s));
        else fail(s, new Error(`the connection to ${target} closed before it opened`));
      },
      error: (s: BunSocketNative, error: Error) => {
        if (state === 'open') handlers.onError(wrapSocket(s), error);
        else fail(s, error);
      },
      // Runs before `Bun.connect` rejects, with the same error — refused,
      // unresolvable — and having it keeps that rejection from also being
      // reported as an unhandled one.
      connectError: (_s: BunSocketNative, error: Error) => { fail(undefined, error); },
    };
    const connectOptions: Record<string, unknown> = {
      hostname: options.host,
      port: options.port,
      socket: socketHandlers,
    };
    if (tls !== undefined) {
      const serverName = tls.serverName ?? options.host;
      socketHandlers.handshake = (s: BunSocketNative, success: boolean, authorizationError: Error | null | undefined) => {
        const refusal = handshakeRefusal(s, success, authorizationError, serverName, checkIdentity);
        if (refusal === undefined) open(s);
        else fail(s, refusal ?? new Error(`the TLS handshake with ${target} failed`));
      };
      connectOptions.tls = {
        ca: tls.ca,
        cert: tls.cert,
        key: tls.key,
        serverName,
        rejectUnauthorized: tls.rejectUnauthorized ?? true,
      };
    }
    // The promise decides nothing here: over plaintext `open` has run by the
    // time it resolves, and over TLS the handshake is still to come.
    Promise.resolve(bun.connect(connectOptions)).then(
      () => {},
      (error: unknown) => { fail(undefined, error); },
    );
  });
}

/** `node:tls`'s `checkServerIdentity`: `undefined` when the certificate names the host, the error otherwise. */
type CheckServerIdentity = (hostname: string, certificate: never) => Error | undefined;

/**
 * Why a native TLS handshake must not open the dial — `undefined` when it may,
 * `null` when it failed without saying why.  Without `checkIdentity` the
 * caller opted out of verification, and Bun's own verdict decides.
 */
export function handshakeRefusal(
  socket: BunSocketNative,
  success: boolean,
  authorizationError: Error | null | undefined,
  serverName: string,
  checkIdentity: CheckServerIdentity | undefined,
): Error | null | undefined {
  // Bun hands `undefined` as well as `null` for "no error"; either must not read as "may open".
  const error = authorizationError ?? null;
  if (checkIdentity === undefined) return success ? undefined : error;
  if (!success || error !== null) return error;
  return checkIdentity(serverName, (socket.getPeerCertificate?.() ?? {}) as never) ?? undefined;
}

interface BunSocketNative {
  write(data: Uint8Array | string): number;
  end(): void;
  /** Bun's abort: closes without flushing, where `end()` half-closes. */
  terminate(): void;
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
    destroy(): void { socket.terminate(); },
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
