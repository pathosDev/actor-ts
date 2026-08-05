/**
 * Runtime-neutral TCP transport abstraction consumed by `TcpTransport`.
 *
 * Each of Bun / Node.js / Deno exposes TCP with a slightly different API
 * shape (Bun's callback-based `Bun.listen`, Node's EventEmitter-based
 * `node:net`, Deno's async-iterable-based `Deno.listen`).  `TcpBackend`
 * hides the differences so the cluster transport only deals with
 * `TcpSocketLike` values and a small set of callbacks.
 *
 * **TLS:** the `tls` field on listen/connect carries a runtime-neutral
 * shape; each adapter maps it to the corresponding native configuration.
 * Bun and Node share most field names (`cert`, `key`, `ca`,
 * `requestCert`/`requestClientCert`, `rejectUnauthorized`); Deno wraps
 * everything in its `Deno.listenTls` / `Deno.connectTls` shape.
 */

export type TlsTransportOptionsType = {
  /** Server cert (PEM string or DER bytes).  If omitted, TLS is disabled on the listener. */
  readonly cert?: string | Uint8Array;
  /** Private key matching `cert`. */
  readonly key?: string | Uint8Array;
  /** Trusted CA bundle — for client-auth validation and peer-cert validation. */
  readonly ca?: string | Uint8Array;
  /**
   * Require clients to present a valid cert signed by `ca` (server-side).
   *
   * **Defaults to `ca !== undefined`**, not to `false`: supplying a trust
   * bundle to a cluster listener has no other purpose than verifying the peers
   * that connect to it.  See {@link requiresClientCertificate}.
   */
  readonly requestClientCert?: boolean;
  /** Reject outbound connections whose cert isn't signed by `ca`.  Default: true. */
  readonly rejectUnauthorized?: boolean;
  /** Override SNI hostname sent on outbound connects. */
  readonly serverName?: string;
};

/**
 * Minimal socket shape the transport needs.  Adapters wrap their native
 * socket to present this surface.  Per-connection state is NOT stashed on
 * the socket (Bun's `.data` trick is not portable) — the caller keeps its
 * own `WeakMap<TcpSocketLike, State>`.
 */
export interface TcpSocketLike {
  write(data: Uint8Array): void;
  end(): void;
  readonly remoteAddress?: string;
}

export interface TcpSocketHandlers {
  onOpen(sock: TcpSocketLike): void;
  onData(sock: TcpSocketLike, chunk: Uint8Array): void;
  onClose(sock: TcpSocketLike): void;
  onError(sock: TcpSocketLike, err: Error): void;
}

export interface TcpListener {
  readonly port: number;
  close(): Promise<void> | void;
}

/**
 * Whether a TLS listener must demand a certificate from the peer connecting to
 * it — the single place the rule lives, so the runtime adapters cannot drift.
 *
 * The cluster `hello` handshake carries no credential of any kind, so on a TLS
 * cluster mTLS *is* the admission control.  This defaulted to `false`, and
 * nothing in the framework, the examples or the docs ever set it to `true`;
 * `rejectUnauthorized` has no effect on a Node/Bun server unless `requestCert`
 * is on, so the documented `{cert, key, ca, rejectUnauthorized: true}` recipe
 * produced server-authenticated TLS only — any client could complete the
 * handshake with no certificate at all and then claim any identity in its
 * `hello` (#565).
 *
 * Deriving it from `ca` rather than demanding a new flag is what makes the
 * existing documented configuration mean what it says it means.  A listener
 * that deliberately wants one-way TLS sets `requestClientCert: false`
 * explicitly, which still wins.
 */
export function requiresClientCertificate(tls: TlsTransportOptionsType): boolean {
  return tls.requestClientCert ?? tls.ca !== undefined;
}

/**
 * Reject a TLS listener configuration that reads as mutually authenticated but
 * cannot be.  Called by each adapter before it hands the options to the
 * runtime, because failing closed at bind time is the only way a
 * misconfiguration becomes visible — an under-secured listener behaves exactly
 * like a correct one until someone attacks it.
 */
export function assertListenerTlsIsCoherent(
  tls: TlsTransportOptionsType,
  runtime: 'Node.js' | 'Bun' | 'Deno',
): void {
  if (tls.requestClientCert === true && tls.ca === undefined) {
    throw new Error(
      'TLS transport: requestClientCert is true but no `ca` was supplied, so there is ' +
      'nothing to validate peer certificates against. Provide the CA bundle that signs ' +
      'your cluster\'s peer certificates, or set requestClientCert: false for one-way TLS.',
    );
  }
  if (runtime === 'Deno' && requiresClientCertificate(tls)) {
    throw new Error(
      'TLS transport: this node cannot HOST an mTLS listener on Deno — `Deno.listenTls` takes ' +
      'only a cert and key, with no way to request or verify a client certificate, so the ' +
      'listener would authenticate nobody. A Deno node can still JOIN an mTLS cluster: it ' +
      'presents its own `cert`/`key` when dialling. Host the listener on Node.js or Bun, or ' +
      'set requestClientCert: false to accept one-way TLS with no peer authentication.',
    );
  }
}

/**
 * The listener's TLS options in the shape Node's `tls.createServer` and Bun's
 * `Bun.listen` both accept — the two share these field names.
 *
 * Built here rather than in each adapter because the duplication is how #565
 * survived review: the same silently-wrong `requestCert` default was spelled
 * out twice, so neither copy looked like an outlier.  Asserts coherence on the
 * way, so a listener that cannot mean what it says never reaches the runtime.
 */
export function listenerTlsOptions(
  tls: TlsTransportOptionsType,
  runtime: 'Node.js' | 'Bun',
): {
  cert?: string | Uint8Array;
  key?: string | Uint8Array;
  ca?: string | Uint8Array;
  requestCert: boolean;
  rejectUnauthorized: boolean;
} {
  assertListenerTlsIsCoherent(tls, runtime);
  return {
    cert: tls.cert,
    key: tls.key,
    ca: tls.ca,
    requestCert: requiresClientCertificate(tls),
    rejectUnauthorized: tls.rejectUnauthorized ?? true,
  };
}

export interface TcpBackend {
  listen(options: {
    host: string;
    port: number;
    tls?: TlsTransportOptionsType;
    handlers: TcpSocketHandlers;
  }): Promise<TcpListener>;

  connect(options: {
    host: string;
    port: number;
    tls?: TlsTransportOptionsType;
    handlers: TcpSocketHandlers;
  }): Promise<TcpSocketLike>;
}
