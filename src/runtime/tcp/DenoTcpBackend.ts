import { listenerUsesTls } from './TcpBackend.js';
import type {
  TcpBackend,
  TcpListener,
  TcpSocketHandlers,
  TcpSocketLike,
  TlsTransportOptionsType,
} from './TcpBackend.js';

/**
 * Deno implementation of `TcpBackend` — wraps `Deno.listen` / `Deno.connect`
 * (plain TCP) and `Deno.listenTls` / `Deno.connectTls` (TLS).  Deno's
 * connection API is async-iterable; the adapter fans that out into the
 * familiar callback shape (`onOpen` / `onData` / `onClose` / `onError`)
 * that matches the Bun and Node adapters.
 *
 * Requires the process to be started with `--allow-net`; TLS config that
 * reads cert files additionally needs `--allow-read`.  The adapter itself
 * never reads from disk — callers pass cert/key as in-memory strings or
 * bytes.
 */
export class DenoTcpBackend implements TcpBackend {
  async listen(options: {
    host: string; port: number; tls?: TlsTransportOptionsType; handlers: TcpSocketHandlers;
  }): Promise<TcpListener> {
    const deno = (globalThis as { Deno?: DenoGlobal }).Deno;
    if (!deno) throw new Error('DenoTcpBackend: globalThis.Deno is not defined');

    // `listenerUsesTls` both decides and validates — a half-configured `tls`
    // throws here instead of falling through to a plaintext bind (#144).
    const tls = options.tls;
    const listener: DenoListener = listenerUsesTls(tls, 'Deno')
      ? deno.listenTls({
          hostname: options.host,
          port: options.port,
          cert: asString(tls.cert),
          key: asString(tls.key),
        })
      : deno.listen({ hostname: options.host, port: options.port, transport: 'tcp' });

    // Kick off an accept loop — don't await it from `listen()` since it
    // runs for the lifetime of the server.
    (async (): Promise<void> => {
      try {
        for await (const connection of listener) {
          this.attach(connection, options.handlers);
        }
      } catch (err) {
        // Listener closed — emit a synthetic close on any open sockets in
        // the caller is not our concern; just swallow.  `options.handlers`
        // already receives per-connection close events when each `connection`
        // ends.
        if (!isClosedListener(err)) throw err;
      }
    })();

    return {
      get port(): number { return listener.addr.port ?? options.port; },
      close(): void { try { listener.close(); } catch { /* ignore */ } },
    };
  }

  async connect(options: {
    host: string; port: number; tls?: TlsTransportOptionsType; handlers: TcpSocketHandlers;
  }): Promise<TcpSocketLike> {
    const deno = (globalThis as { Deno?: DenoGlobal }).Deno;
    if (!deno) throw new Error('DenoTcpBackend: globalThis.Deno is not defined');

    const useTls = !!options.tls;
    const connection: DenoConnection = useTls
      ? await deno.connectTls(this.denoConnectTlsOptions(options.host, options.port, options.tls!))
      : await deno.connect({ hostname: options.host, port: options.port, transport: 'tcp' });

    const sock = this.attach(connection, options.handlers);
    return sock;
  }

  /**
   * Map the runtime-neutral TLS options onto `Deno.connectTls`.
   *
   * Two things were wrong here before (#576).  The client certificate was
   * never passed, although Deno does support it — `connectTls` accepts
   * `key` + `cert` — so a Deno node could not present a credential to a
   * listener that (correctly, since #565) demands one, and therefore could not
   * join an mTLS cluster at all.  And the SNI override was written as
   * `hostname_`, which is not a Deno option: `ConnectTlsOptions` has no
   * `serverName` either, because on Deno the SNI name *is* `hostname`.  The
   * hand-written `DenoGlobal` interface declared the typo, so the compiler
   * could not see it and the value was silently dropped.
   *
   * `rejectUnauthorized` has no Deno equivalent and is deliberately not mapped:
   * Deno always validates the chain, and its only related knob
   * (`unsafelyDisableHostnameVerification`) is the inverse and covers hostname
   * checking alone.  Setting `rejectUnauthorized: false` to reach a
   * self-signed peer therefore does nothing on Deno — supply the signing CA in
   * `ca` instead, which is the shape the docs already recommend.
   */
  private denoConnectTlsOptions(
    host: string,
    port: number,
    tls: TlsTransportOptionsType,
  ): DenoConnectTlsOptions {
    const options: DenoConnectTlsOptions = {
      // SNI: Deno takes the name to present from `hostname`, so an override
      // replaces the dial target's name rather than riding alongside it.
      hostname: tls.serverName ?? host,
      port,
    };
    if (tls.ca !== undefined) options.caCerts = [asString(tls.ca)];
    // Both halves or neither — a key without its certificate is not a
    // credential, and Deno's own type pairs them for the same reason.
    if (tls.cert !== undefined && tls.key !== undefined) {
      options.cert = asString(tls.cert);
      options.key = asString(tls.key);
    }
    return options;
  }

  /** Wrap a Deno.Conn as a TcpSocketLike and drive its async-iterable reads. */
  private attach(connection: DenoConnection, handlers: TcpSocketHandlers): TcpSocketLike {
    const writer = connection.writable.getWriter();
    let closed = false;

    const sock: TcpSocketLike = {
      write(data: Uint8Array): void {
        if (closed) return;
        void writer.write(data).catch((err) => {
          if (!closed) handlers.onError(sock, err as Error);
        });
      },
      end(): void {
        if (closed) return;
        closed = true;
        void writer.close().catch(() => { /* ignore */ });
        try { connection.close(); } catch { /* ignore */ }
        handlers.onClose(sock);
      },
      // Deno draws no distinction: `Deno.Conn.close()` already tears down
      // both halves, so `end()` is not the half-close it is on Node and Bun
      // and there is nothing stronger to reach for.  Present anyway, so a
      // caller that means "abort" does not have to ask which runtime it is
      // on (#1096).
      destroy(): void { sock.end(); },
      get remoteAddress(): string | undefined {
        // Deno.NetAddr on TCP carries { hostname, port, transport }.  Return
        // `hostname:port` for parity with Bun/Node's `socket.remoteAddress`.
        const address = connection.remoteAddr;
        if (address && 'hostname' in address && 'port' in address) return `${address.hostname}:${address.port}`;
        return undefined;
      },
      // No `peerCertificate()`: Deno exposes none.  `Deno.TlsConn` has no
      // accessor for it and `handshake()` resolves to `{ alpnProtocol }`
      // alone, so there is nothing to normalise.  Leaving the optional
      // method off is the honest signal — the transport then skips the
      // certificate-identity check rather than believing an empty answer
      // means "no certificate was presented".  This is the same Deno gap
      // that makes hosting an mTLS *listener* impossible (see
      // `assertListenerTlsIsCoherent`), so a Deno node can join an mTLS
      // cluster as a client but cannot enforce peer identity itself.
    };

    handlers.onOpen(sock);
    (async (): Promise<void> => {
      // `ReadableStream` has `[Symbol.asyncIterator]()` on Bun/Node/Deno
      // but the vanilla DOM typings don't expose it, so we use the
      // explicit reader API for cross-runtime typing compatibility.
      const reader = connection.readable.getReader();
      try {
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) handlers.onData(sock, value);
        }
      } catch (err) {
        if (!closed) handlers.onError(sock, err as Error);
      } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
        if (!closed) {
          closed = true;
          handlers.onClose(sock);
        }
      }
    })();

    return sock;
  }
}

/* ----------------------------- internals --------------------------------- */

function asString(v: string | Uint8Array): string {
  return typeof v === 'string' ? v : new TextDecoder().decode(v);
}

function isClosedListener(err: unknown): boolean {
  // Deno.errors.BadResource / InvalidData — thrown when the listener has
  // been closed while we're mid-accept.  No stable type export across Deno
  // versions; string-match the common cases.
  const message = (err as Error | undefined)?.message ?? '';
  return /closed|Bad resource/i.test(message);
}

interface DenoConnection {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly remoteAddr?: { hostname?: string; port?: number };
  close(): void;
}

interface DenoListener extends AsyncIterable<DenoConnection> {
  readonly addr: { port?: number };
  close(): void;
}

/**
 * Mirrors `Deno.ConnectTlsOptions` intersected with `Deno.TlsCertifiedKeyPem`.
 *
 * Kept faithful to the real declaration on purpose: the previous version
 * invented a `hostname_` field, and because this interface is what the
 * compiler checks against, the typo type-checked and the SNI override was
 * dropped at runtime with nothing to show for it (#576).  Anything added here
 * should be verified against `deno types` first.
 *
 * Notably absent, and not an oversight: `serverName` (Deno uses `hostname` for
 * SNI) and `rejectUnauthorized` (no equivalent — see
 * `denoConnectTlsOptions`).
 */
interface DenoConnectTlsOptions {
  hostname: string;
  port: number;
  caCerts?: string[];
  /** Client certificate chain, PEM. Paired with {@link key}. */
  cert?: string;
  /** Private key for {@link cert}, PEM. */
  key?: string;
}

interface DenoGlobal {
  listen(options: { hostname: string; port: number; transport: 'tcp' }): DenoListener;
  /**
   * `Deno.ListenTlsOptions` genuinely has no `ca` and no client-certificate
   * request — server-side mTLS is unavailable on Deno, which is why
   * `assertListenerTlsIsCoherent` refuses that configuration up front rather
   * than binding a listener that silently authenticates nobody.
   */
  listenTls(options: { hostname: string; port: number; cert: string; key: string }): DenoListener;
  connect(options: { hostname: string; port: number; transport: 'tcp' }): Promise<DenoConnection>;
  connectTls(options: DenoConnectTlsOptions): Promise<DenoConnection>;
}
