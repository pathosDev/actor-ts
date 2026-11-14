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
 * `peerCertificate()`, and their `write` drops what the kernel will not take
 * (#931), so every callback goes through {@link wrapSocket} and a
 * {@link BunSocket}.
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
        drain: (s: BunSocketNative) => onNativeDrain(s, options.handlers),
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
      drain: (s: BunSocketNative) => {
        if (state === 'open') onNativeDrain(s, handlers);
      },
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
const wrappers = new WeakMap<BunSocketNative, BunSocket>();

/** Where a {@link BunSocket} stands on its way out: `ending` holds the FIN until the backlog is written. */
type BunSocketClosing = 'open' | 'ending' | 'ended';

function wrapSocket(socket: BunSocketNative): BunSocket {
  const existing = wrappers.get(socket);
  if (existing) return existing;
  const wrapper = new BunSocket(socket);
  wrappers.set(socket, wrapper);
  return wrapper;
}

/**
 * Bun's `drain` callback: write what the socket was holding, and tell the
 * caller once nothing is left — the one place both the listener and a native
 * dial route it, so the two cannot disagree about when a socket has drained.
 */
function onNativeDrain(socket: BunSocketNative, handlers: TcpSocketHandlers): void {
  const wrapper = wrapSocket(socket);
  if (wrapper.flushBacklog()) handlers.onDrain?.(wrapper);
}

/**
 * A native Bun socket as a `TcpSocketLike`, with the write queue Bun does not
 * keep (#931).
 *
 * `socket.write` answers with how many bytes the kernel took and keeps none of
 * the rest: measured on Bun 1.4.2, a socket whose peer was not reading took
 * seven 64 KiB writes and answered `0` to every one after — and `-1` once the
 * socket had closed.  Writing a framed stream through it cut the stream at
 * whatever byte the kernel stopped at, and the receiver read the next frame's
 * bytes as a length prefix.  So the remainder is kept here, in order, written
 * on Bun's `drain`, and every write made while it is non-empty queues behind
 * it rather than overtaking it.
 *
 * Exported for its tests; not part of the backend's surface.
 */
export class BunSocket implements TcpSocketLike {
  /** Bytes the kernel has not taken yet, oldest first. */
  private readonly backlog: Uint8Array[] = [];
  /** `ending`: `end()` arrived over a non-empty backlog, and the FIN waits for it. */
  private closing: BunSocketClosing = 'open';

  constructor(private readonly native: BunSocketNative) {}

  write(data: Uint8Array): boolean {
    if (this.closing !== 'open') return false;
    if (this.backlog.length > 0) {
      // Copied: the caller may reuse its buffer the moment this returns.
      this.backlog.push(data.slice());
      return false;
    }
    const written = this.native.write(data);
    // Closed: there is nobody left to write the rest to.
    if (written < 0) return false;
    if (written >= data.byteLength) return true;
    this.backlog.push(data.slice(written));
    return false;
  }

  /**
   * Write as much of the backlog as the kernel takes now; `true` once it is
   * empty — the moment the caller may resume.
   */
  flushBacklog(): boolean {
    while (this.backlog.length > 0) {
      const head = this.backlog[0]!;
      const written = this.native.write(head);
      if (written < 0) {
        this.backlog.length = 0;
        return false;
      }
      if (written < head.byteLength) {
        this.backlog[0] = head.subarray(written);
        return false;
      }
      this.backlog.shift();
    }
    if (this.closing === 'ending') {
      this.closing = 'ended';
      this.native.end();
    }
    return true;
  }

  /**
   * Half-close once everything written has gone out: a FIN sent over a
   * non-empty backlog would end the stream short of what the caller wrote —
   * `Cluster.leave` writes its `leave` frames immediately before the transport
   * ends its sockets.  Node's `end()` waits for its queue the same way.
   */
  end(): void {
    if (this.closing !== 'open') return;
    if (this.backlog.length > 0) {
      this.closing = 'ending';
      return;
    }
    this.closing = 'ended';
    this.native.end();
  }

  /** Bun's abort, which discards the backlog with everything else. */
  destroy(): void {
    this.closing = 'ended';
    this.backlog.length = 0;
    this.native.terminate();
  }

  get remoteAddress(): string | undefined { return this.native.remoteAddress; }

  // Read on demand.  Bun runs `open` *before* the TLS handshake completes —
  // `authorized` is still false there and no certificate is available — so
  // capturing this eagerly would silently yield nothing on Bun while
  // working on Node.  Any inbound frame implies a finished handshake.
  peerCertificate(): PeerCertificate | undefined {
    return toPeerCertificate(this.native.getPeerCertificate?.());
  }
}

interface BunGlobal {
  listen(options: unknown): { stop(): void; port?: number };
  connect(options: unknown): Promise<BunSocketNative> | BunSocketNative;
}
