import type { Logger } from '../Logger.js';
import {
  getTcpBackend,
  type TcpBackend,
  type TcpListener,
  type TcpSocketLike,
  type TlsTransportOptionsType,
} from '../runtime/tcp/index.js';
import { NodeAddress } from './NodeAddress.js';
import {
  encodeFrame,
  FrameDecoder,
  DEFAULT_MAX_FRAME_BYTES,
  type HelloMessage,
  type HelloAcknowledgmentMessage,
  type WireMessage,
} from './Protocol.js';

export type WireHandler = (from: NodeAddress, message: WireMessage) => void;
export type { TlsTransportOptionsType };

/**
 * Lower-level networking interface consumed by the Cluster.  The TCP
 * implementation is the production one; tests use an in-memory transport
 * that loops frames through JS structures.
 */
export interface Transport {
  readonly self: NodeAddress;
  start(): Promise<void>;
  shutdown(): Promise<void>;
  setHandler(handler: WireHandler): void;
  /** Best-effort fire-and-forget send. Opens a connection on first use. */
  send(to: NodeAddress, message: WireMessage): void;
  /** Close the connection to a peer. */
  disconnect(peer: NodeAddress): void;
  /** Peers currently connected (either inbound or outbound). */
  peers(): NodeAddress[];
}

/* ============================== TCP Transport ============================= */

interface Connection {
  socket: TcpSocketLike | null;     // populated on `onOpen`
  peer: NodeAddress | null;         // populated on hello / hello-ack
  decoder: FrameDecoder;
  /** Buffered frames written before the hello handshake completed. */
  pending: WireMessage[];
  outbound: boolean;
}

/**
 * TCP-backed cluster transport.  Wire framing lives in `Protocol.ts`; the
 * actual socket API is plugged in per runtime via `TcpBackend`
 * (`src/runtime/tcp/`), so this class is identical on Bun, Node.js, and
 * Deno — the differences in listen/connect/socket shape are absorbed by
 * the adapter.
 *
 * Per-connection state is tracked in a `WeakMap<TcpSocketLike, Connection>` —
 * `TcpSocketLike` is intentionally opaque and has no stash slot.
 */
export class TcpTransport implements Transport {
  private backend: TcpBackend | null = null;
  private listener: TcpListener | null = null;
  private byPeer = new Map<string, Connection>();
  private bySocket = new WeakMap<TcpSocketLike, Connection>();
  private handler: WireHandler = () => {};
  private stopped = false;

  constructor(
    readonly self: NodeAddress,
    private readonly log: Logger,
    /** Optional TLS configuration — when set, both listener and dialer use TLS. */
    private readonly tls: TlsTransportOptionsType | null = null,
    /**
     * Per-frame size cap (security).  Frames whose length-prefix
     * exceeds this are rejected before any payload bytes are
     * buffered — closes the 4-GiB-claim DoS vector documented on
     * {@link FrameDecoder}.  Default: {@link DEFAULT_MAX_FRAME_BYTES}
     * (16 MiB).  Raise it only if you genuinely send larger
     * envelopes; the cap is per-frame, not aggregate.
     */
    private readonly maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
  ) {}

  setHandler(handler: WireHandler): void { this.handler = handler; }

  async start(): Promise<void> {
    this.backend = await getTcpBackend();
    this.listener = await this.backend.listen({
      host: this.self.host,
      port: this.self.port,
      tls: this.tls ?? undefined,
      handlers: {
        onOpen: (sock) => this.attachInbound(sock),
        onData: (sock, chunk) => this.onData(sock, chunk),
        onClose: (sock) => this.onClose(sock),
        onError: (_sock, err) => this.log.warn('inbound socket error', err),
      },
    });
    this.log.info(`cluster transport listening on ${this.self.host}:${this.self.port}`);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const connection of this.byPeer.values()) {
      try { connection.socket?.end(); } catch { /* ignore */ }
    }
    this.byPeer.clear();
    if (this.listener) {
      try { await this.listener.close(); } catch { /* ignore */ }
    }
    this.listener = null;
  }

  send(to: NodeAddress, message: WireMessage): void {
    if (this.stopped) return;
    const connection = this.byPeer.get(to.toString()) ?? this.openOutbound(to);
    if (connection.peer && connection.socket) {
      connection.socket.write(encodeFrame(message));
    } else {
      connection.pending.push(message); // wait for hello / hello-ack
    }
  }

  disconnect(peer: NodeAddress): void {
    const connection = this.byPeer.get(peer.toString());
    if (!connection) return;
    try { connection.socket?.end(); } catch { /* ignore */ }
    this.byPeer.delete(peer.toString());
  }

  peers(): NodeAddress[] {
    const out: NodeAddress[] = [];
    for (const connection of this.byPeer.values()) if (connection.peer) out.push(connection.peer);
    return out;
  }

  /* --------------------------- internals -------------------------------- */

  private attachInbound(sock: TcpSocketLike): void {
    const connection: Connection = {
      socket: sock,
      peer: null,
      decoder: new FrameDecoder(this.maxFrameBytes),
      pending: [],
      outbound: false,
    };
    this.bySocket.set(sock, connection);
  }

  private openOutbound(to: NodeAddress): Connection {
    const connection: Connection = {
      socket: null,
      peer: null,
      decoder: new FrameDecoder(this.maxFrameBytes),
      pending: [],
      outbound: true,
    };
    this.byPeer.set(to.toString(), connection);

    // Kick off the connect — when it resolves, install the socket into the
    // pre-registered Connection so subsequent `send(...)` calls can use it.  If
    // the connect fails, drop the Connection from byPeer so the next send()
    // retries.
    void (async (): Promise<void> => {
      try {
        const backend = this.backend ?? (await getTcpBackend());
        this.backend = backend;
        const sock = await backend.connect({
          host: to.host,
          port: to.port,
          tls: this.tls ?? undefined,
          handlers: {
            onOpen: (s) => {
              // Send hello; remote will ack and we'll flush `pending` then.
              const hello: HelloMessage = { t: 'hello', self: this.self.toJSON() };
              s.write(encodeFrame(hello));
            },
            onData: (s, chunk) => this.onData(s, chunk),
            onClose: (s) => this.onClose(s),
            onError: (_s, err) => this.log.warn(`outbound error -> ${to}`, err),
          },
        });
        connection.socket = sock;
        this.bySocket.set(sock, connection);
      } catch (err) {
        this.log.warn(`failed to connect to ${to}`, err as Error);
        this.byPeer.delete(to.toString());
      }
    })();

    return connection;
  }

  private onData(sock: TcpSocketLike, chunk: Uint8Array): void {
    let connection = this.bySocket.get(sock);
    if (!connection) {
      // Bun delivers `data` before `open` completes its microtask in some
      // edge cases — attach a fresh inbound Connection lazily.
      connection = {
        socket: sock, peer: null, decoder: new FrameDecoder(this.maxFrameBytes),
        pending: [], outbound: false,
      };
      this.bySocket.set(sock, connection);
    }
    let frames: WireMessage[];
    try {
      frames = connection.decoder.push(chunk);
    } catch (err) {
      // Frame-decoder rejected the input (oversized length-prefix,
      // malformed JSON).  Drop the connection rather than letting the
      // error propagate up the runtime's socket-data callback.
      this.log.warn(`frame-decoder error from ${connection.peer ?? '<unknown peer>'}; closing`, err as Error);
      try { sock.end(); } catch { /* ignore */ }
      this.bySocket.delete(sock);
      if (connection.peer) this.byPeer.delete(connection.peer.toString());
      return;
    }
    for (const message of frames) this.onMessage(connection, message);
  }

  private onMessage(connection: Connection, message: WireMessage): void {
    if (message.t === 'hello') {
      const peer = NodeAddress.fromJSON(message.self);
      const peerKey = peer.toString();
      // Security: reject a duplicate-identity hello on a different
      // socket.  Without this, a second connection claiming the
      // same address as an existing peer would *overwrite* the
      // byPeer map — every outbound message intended for the
      // legitimate peer would then be routed to the attacker's
      // socket.  First-connection-wins is also the right semantic for
      // legitimate reconnects: the dropped connection's `onClose` runs
      // before any new hello arrives in the common case; only a
      // tight race causes one retry.  See {@link Transport.test}
      // for the exploit walkthrough.
      const existing = this.byPeer.get(peerKey);
      if (existing && existing !== connection) {
        this.log.warn(
          `hello hijack rejected: peer ${peerKey} already has an active connection; ` +
          `closing the new socket`,
        );
        try { connection.socket?.end(); } catch { /* ignore */ }
        this.bySocket.delete(connection.socket as TcpSocketLike);
        return;
      }
      connection.peer = peer;
      this.byPeer.set(peerKey, connection);
      const ack: HelloAcknowledgmentMessage = { t: 'hello-ack', self: this.self.toJSON() };
      connection.socket?.write(encodeFrame(ack));
      return;
    }
    if (message.t === 'hello-ack') {
      const peer = NodeAddress.fromJSON(message.self);
      const peerKey = peer.toString();
      const existing = this.byPeer.get(peerKey);
      if (existing && existing !== connection) {
        // Same defense on the outbound-handshake side: someone
        // already owns this peer-key, we don't take it over from
        // them.
        this.log.warn(
          `hello-ack hijack rejected: peer ${peerKey} already mapped to a different connection`,
        );
        try { connection.socket?.end(); } catch { /* ignore */ }
        this.bySocket.delete(connection.socket as TcpSocketLike);
        return;
      }
      connection.peer = peer;
      this.byPeer.set(peerKey, connection);
      const buffered = connection.pending.splice(0, connection.pending.length);
      for (const bufferedMessage of buffered) connection.socket?.write(encodeFrame(bufferedMessage));
      return;
    }
    if (!connection.peer) {
      this.log.warn('received message before hello handshake', message);
      return;
    }
    this.handler(connection.peer, message);
  }

  private onClose(sock: TcpSocketLike): void {
    const connection = this.bySocket.get(sock);
    if (!connection) return;
    this.bySocket.delete(sock);
    if (connection.peer) this.byPeer.delete(connection.peer.toString());
  }
}

/* =========================== In-memory Transport =========================== */

/**
 * A transport that keeps everything inside the current process.  Useful for
 * tests where we want to simulate a cluster without opening TCP sockets.
 */
export class InMemoryTransport implements Transport {
  /** Shared registry so peer transports find each other. */
  private static registry = new Map<string, InMemoryTransport>();

  private handler: WireHandler = () => {};
  private stopped = false;

  constructor(readonly self: NodeAddress) {}

  setHandler(handler: WireHandler): void { this.handler = handler; }

  async start(): Promise<void> {
    InMemoryTransport.registry.set(this.self.toString(), this);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    InMemoryTransport.registry.delete(this.self.toString());
  }

  send(to: NodeAddress, message: WireMessage): void {
    if (this.stopped) return;
    const peer = InMemoryTransport.registry.get(to.toString());
    if (!peer || peer.stopped) return;
    const from = this.self;
    // Decouple sender and receiver via microtask so ordering mirrors TCP.
    queueMicrotask(() => {
      if (!peer.stopped) peer.handler(from, message);
    });
  }

  disconnect(_peer: NodeAddress): void { /* stateless registry */ }

  peers(): NodeAddress[] {
    return Array.from(InMemoryTransport.registry.keys())
      .filter(k => k !== this.self.toString())
      .map(k => NodeAddress.parse(k));
  }
}
