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
 *
 * Every certificate field carries **the material itself**, never a path to
 * it — no layer here or below reads from disk, and none of the three runtimes
 * accepts a filename in these fields either.  Load it yourself
 * (`readFileSync(path, 'utf8')`, a mounted secret, a KMS fetch) and pass what
 * you loaded.
 */

export type TlsTransportOptionsType = {
  /**
   * Server certificate — PEM contents or DER bytes, not a file path.
   *
   * On a **listener** this is mandatory whenever `tls` is supplied at all, and
   * so is {@link key}: see {@link assertListenerTlsIsCoherent}.  On an
   * outbound dial it is the client certificate, and omitting it is ordinary —
   * that is one-way TLS, where only the server is authenticated.
   */
  readonly cert?: string | Uint8Array;
  /** Private key matching `cert` — PEM contents or DER bytes, not a file path. */
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
 * The names a peer's certificate vouches for, normalised across runtimes.
 *
 * Only the identity fields are carried.  Whether the certificate *chains* to
 * the configured `ca` is the TLS stack's job and has already happened by the
 * time anything can read this — `requestClientCert` plus `rejectUnauthorized`
 * mean an untrusted peer never reaches the application at all.  What is left
 * over, and what this exists for, is *which* trusted peer it is.
 */
export type PeerCertificate = {
  /** Subject CN, when the certificate has one. */
  readonly commonName?: string;
  /** `subjectAltName` entries, rendered as `DNS:x` / `IP Address:x` are stripped to bare values. */
  readonly subjectAlternativeNames: readonly string[];
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
  /**
   * The peer's TLS certificate, or `undefined` when there is none to read —
   * a plaintext socket, one-way TLS, or a runtime that does not expose it.
   *
   * **Read it lazily, never at `onOpen`.**  On Bun the socket's `open`
   * callback fires *before* the TLS handshake completes: `authorized` is
   * still `false` and `getPeerCertificate()` returns nothing.  Node hands
   * over a socket that is already secure, so it would work there and fail
   * only on Bun — the worst kind of difference.  Calling this while
   * handling inbound data is always safe, because encrypted bytes cannot
   * arrive before the handshake that decrypts them.
   *
   * Optional because {@link DenoTcpBackend} has nothing to implement it
   * with: `Deno.TlsConn` exposes no peer certificate, and `handshake()`
   * returns only the negotiated ALPN protocol.
   */
  peerCertificate?(): PeerCertificate | undefined;
}

/**
 * Normalise a Node-style certificate object — which Bun also implements — to
 * {@link PeerCertificate}.  Exported for the adapters and for tests; not part
 * of the transport's own surface.
 *
 * Both runtimes return `subjectaltname` as one comma-separated string with a
 * type prefix per entry (`DNS:node-a, IP Address:10.0.0.7`).  The prefix is
 * dropped: a caller matching an address against these does not care how the
 * name was typed, and keeping it would push that parsing into every consumer.
 */
export function toPeerCertificate(raw: unknown): PeerCertificate | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const certificate = raw as { subject?: { CN?: unknown }; subjectaltname?: unknown };
  // An empty object is how Node reports "no certificate presented".
  if (Object.keys(certificate).length === 0) return undefined;

  const commonName = typeof certificate.subject?.CN === 'string' ? certificate.subject.CN : undefined;
  const subjectAlternativeNames = typeof certificate.subjectaltname === 'string'
    ? certificate.subjectaltname
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const separator = entry.indexOf(':');
        return separator < 0 ? entry : entry.slice(separator + 1).trim();
      })
    : [];

  if (commonName === undefined && subjectAlternativeNames.length === 0) return undefined;
  return commonName === undefined
    ? { subjectAlternativeNames }
    : { commonName, subjectAlternativeNames };
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
 * The same options with the server credential proven present — what
 * {@link listenerUsesTls} narrows to, so an adapter that is about to bind TLS
 * reads `cert` / `key` without a non-null assertion.
 */
export type CredentialedTlsTransportOptionsType = TlsTransportOptionsType & {
  readonly cert: string | Uint8Array;
  readonly key: string | Uint8Array;
};

/**
 * Whether a field carries usable certificate material.
 *
 * Empty is treated as absent on purpose: an empty string or a zero-length
 * buffer is what a mis-mounted secret or an unset environment variable looks
 * like by the time it arrives here, and calling that "configured" would push
 * the failure down into the TLS stack, where it surfaces as a PEM parse error
 * that says nothing about which field was wrong.
 */
function carriesMaterial(pem: string | Uint8Array | undefined): boolean {
  return pem !== undefined && pem.length > 0;
}

/**
 * Reject a TLS listener configuration that reads as secured but cannot be.
 * Called by each adapter before it hands the options to the runtime, because
 * failing closed at bind time is the only way a misconfiguration becomes
 * visible — an under-secured listener behaves exactly like a correct one until
 * someone attacks it.
 *
 * The credential rule below closes a **fail-open** (#144).  Every adapter
 * decided whether to bind TLS by testing `cert && key`, so a listener
 * configured with only one of the two — the shape a rotated-but-half-applied
 * secret produces — quietly bound in **plaintext**.  Nothing announced it: the
 * dialing half of the very same options object treats any `tls` value as TLS,
 * so the operator saw a node that had "TLS configured" and a cluster that
 * formed.  Refusing the bind converts a silent downgrade into a startup
 * failure.
 *
 * This is a **listener-only** rule and deliberately not applied to
 * {@link TcpBackend.connect}.  A dialer given `{ ca }` alone is the ordinary,
 * correct configuration for one-way TLS — authenticate the server, present no
 * client certificate — and `ClusterClient`, which never listens, relies on
 * exactly that.  On a listener the same shape has no reading under which it
 * works: without a certificate there is nothing to present, so there is no
 * handshake to have.
 */
export function assertListenerTlsIsCoherent(
  tls: TlsTransportOptionsType,
  runtime: 'Node.js' | 'Bun' | 'Deno',
): void {
  const hasCertificate = carriesMaterial(tls.cert);
  const hasKey = carriesMaterial(tls.key);
  if (hasCertificate !== hasKey) {
    const present = hasCertificate ? 'cert' : 'key';
    const absent = hasCertificate ? 'key' : 'cert';
    throw new Error(
      `TLS transport: \`${present}\` is set on this listener but \`${absent}\` is not, so there ` +
      'is no usable server credential and the listener would bind in PLAINTEXT while the same ' +
      'configuration still dials out over TLS. Supply both halves, or omit `tls` entirely for a ' +
      'deliberately plaintext listener. Both fields take the certificate material itself — PEM ' +
      'contents or DER bytes — not a path to a file.',
    );
  }
  if (!hasCertificate) {
    throw new Error(
      'TLS transport: a `tls` option was supplied to this listener but it carries no `cert` and ' +
      'no `key`, so the listener has nothing to present and would bind in PLAINTEXT. A `ca` ' +
      'authenticates the peers this node dials; it cannot serve inbound connections. Supply the ' +
      'server certificate and its key, or omit `tls` entirely for a plaintext listener.',
    );
  }
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
 * Whether the listener must bind TLS — and the single place that decision is
 * made, for all three runtimes.
 *
 * The check is welded to the decision rather than sitting beside it because
 * that is precisely how #144 survived: each adapter answered "should I bind
 * TLS?" with its own `cert && key` test, and a `false` answer therefore
 * *skipped* validation instead of triggering it.  Anything that can return
 * `false` here has already been through {@link assertListenerTlsIsCoherent},
 * so "plaintext" can now only mean "no `tls` was supplied at all".
 */
export function listenerUsesTls(
  tls: TlsTransportOptionsType | undefined,
  runtime: 'Node.js' | 'Bun' | 'Deno',
): tls is CredentialedTlsTransportOptionsType {
  if (tls === undefined) return false;
  assertListenerTlsIsCoherent(tls, runtime);
  return true;
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
