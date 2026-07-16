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

export interface TlsTransportOptionsType {
  /** Server cert (PEM string or DER bytes).  If omitted, TLS is disabled on the listener. */
  readonly cert?: string | Uint8Array;
  /** Private key matching `cert`. */
  readonly key?: string | Uint8Array;
  /** Trusted CA bundle — for client-auth validation and peer-cert validation. */
  readonly ca?: string | Uint8Array;
  /** Require clients to present a valid cert signed by `ca` (server-side). */
  readonly requestClientCert?: boolean;
  /** Reject outbound connections whose cert isn't signed by `ca`.  Default: true. */
  readonly rejectUnauthorized?: boolean;
  /** Override SNI hostname sent on outbound connects. */
  readonly serverName?: string;
}

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
