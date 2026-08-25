/**
 * Client-side TLS material for the broker actors, and the single place that
 * maps it onto what their drivers accept (#743).
 *
 * The material shape itself is {@link TlsTransportOptionsType} — the same one
 * the cluster transport, `ClusterClient`, `GelfSink` and `SyslogSink` already
 * take.  Reusing it rather than minting a broker-local twin is deliberate: an
 * operator who has already loaded a CA bundle for the cluster transport hands
 * the identical object to a broker, and there is one shape to document instead
 * of two.  Its `requestClientCert` field is listener-only and is dropped here —
 * an outbound dial has no clients to request a certificate from.
 *
 * The mapping is **not** a rename-free spread, which is why it is a function
 * and not a cast.  Node spells the SNI override `servername` (all lowercase)
 * while this project spells it `serverName`, and `amqplib`, `ioredis`,
 * `mqtt.js`, `nats.js` and `kafkajs` all hand their TLS option object to
 * `tls.connect` unchanged — so the lowercase spelling is the one that has to
 * arrive.  A spread would carry `serverName` through, every driver would
 * ignore it, and the connection would silently verify against the wrong name:
 * the same class of quietly-dropped TLS configuration this issue exists to
 * remove.
 *
 * As everywhere else in the project, every certificate field carries **the
 * material itself**, never a path to it — none of these drivers reads a file
 * for you.  Load it (`readFileSync(path, 'utf8')`, a mounted secret, a KMS
 * fetch) and pass what you loaded.  That is also why none of this is reachable
 * from HOCON: a private key does not belong in a config file, the same call
 * `TcpServerOptions` documents.
 */
import type { TlsTransportOptionsType } from '../../runtime/tcp/TcpBackend.js';

/**
 * The TLS option object every broker driver forwards to `tls.connect`.
 *
 * Deliberately narrower than {@link TlsTransportOptionsType}: it is what the
 * drivers read, in the spelling they read it in, and nothing else.
 */
export type BrokerDriverTlsOptions = {
  /** Trusted CA bundle — PEM contents or DER bytes, not a file path. */
  readonly ca?: string | Uint8Array;
  /** Client certificate presented to the broker (mTLS). */
  readonly cert?: string | Uint8Array;
  /** Private key matching `cert`. */
  readonly key?: string | Uint8Array;
  /** Reject a broker whose certificate does not verify.  Default: true. */
  readonly rejectUnauthorized?: boolean;
  /** SNI hostname — Node's spelling of `serverName`; see the module note. */
  readonly servername?: string;
};

/**
 * Translate configured TLS material into the drivers' option object.
 *
 * Returns `undefined` for unconfigured TLS so a caller can pass the result
 * straight through as the driver's optional second argument and reproduce the
 * exact call it made before TLS existed — `connect(url, undefined)` is
 * `connect(url)`.  An **empty** `tls: {}` is not the same thing and is not
 * collapsed to it: it means "negotiate TLS with the system trust store", which
 * for `kafkajs` and `nats.js` is expressed by the option object being present
 * at all.
 */
export function toBrokerDriverTls(
  tls: TlsTransportOptionsType | undefined,
): BrokerDriverTlsOptions | undefined {
  if (tls === undefined) return undefined;
  return {
    ca: tls.ca,
    cert: tls.cert,
    key: tls.key,
    rejectUnauthorized: tls.rejectUnauthorized,
    servername: tls.serverName,
  };
}

/**
 * Describe why client TLS material is incoherent, or `null` when it is fine.
 *
 * Only the cert/key pairing is checkable up front — whether a CA actually
 * signs the broker's certificate is the TLS stack's business at handshake
 * time.  The pairing is worth catching here anyway, and for the same reason
 * `TcpServerOptions.tlsRules` gives: a half-configured certificate throws
 * inside `connectImplementation`, {@link BrokerActor} reads that as a
 * *connection* failure and answers it with the reconnect policy, whose
 * `maxAttempts` defaults to `Number.POSITIVE_INFINITY`.  The mistake would
 * therefore retry forever instead of failing the actor's start — the exact
 * no-path-to-success loop #743 is about.
 */
export function findBrokerTlsProblem(tls: TlsTransportOptionsType | undefined): string | null {
  if (tls === undefined) return null;
  const hasCertificate = tls.cert !== undefined;
  const hasKey = tls.key !== undefined;
  if (hasCertificate && !hasKey) {
    return 'cert without key — a client certificate cannot be presented without its private key';
  }
  if (hasKey && !hasCertificate) {
    return 'key without cert — a private key on its own identifies nothing';
  }
  return null;
}
