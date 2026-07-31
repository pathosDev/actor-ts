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

    const useTls = !!(options.tls && options.tls.cert && options.tls.key);
    const listener: DenoListener = useTls
      ? deno.listenTls({
          hostname: options.host,
          port: options.port,
          cert: asString(options.tls!.cert!),
          key: asString(options.tls!.key!),
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
      ? await deno.connectTls({
          hostname: options.host,
          port: options.port,
          caCerts: options.tls!.ca !== undefined ? [asString(options.tls!.ca)] : undefined,
          hostname_: options.tls!.serverName,
        })
      : await deno.connect({ hostname: options.host, port: options.port, transport: 'tcp' });

    const sock = this.attach(connection, options.handlers);
    return sock;
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
      get remoteAddress(): string | undefined {
        // Deno.NetAddr on TCP carries { hostname, port, transport }.  Return
        // `hostname:port` for parity with Bun/Node's `socket.remoteAddress`.
        const address = connection.remoteAddr;
        if (address && 'hostname' in address && 'port' in address) return `${address.hostname}:${address.port}`;
        return undefined;
      },
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

interface DenoGlobal {
  listen(options: { hostname: string; port: number; transport: 'tcp' }): DenoListener;
  listenTls(options: { hostname: string; port: number; cert: string; key: string }): DenoListener;
  connect(options: { hostname: string; port: number; transport: 'tcp' }): Promise<DenoConnection>;
  connectTls(options: {
    hostname: string; port: number; caCerts?: string[]; hostname_?: string;
  }): Promise<DenoConnection>;
}
