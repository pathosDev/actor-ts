import type { Logger } from '../Logger.js';
import { HANDSHAKE_TIMEOUT_MS, MAX_PENDING_FRAMES } from './Constants.js';
import {
  getTcpBackend,
  type TcpBackend,
  type TcpListener,
  type TcpSocketLike,
  type TlsTransportOptionsType,
} from '../runtime/tcp/index.js';
import { NodeAddress } from './NodeAddress.js';
import { certificateVouchesFor } from './PeerIdentity.js';
import {
  encodeFrame,
  FrameDecoder,
  DEFAULT_MAX_FRAME_BYTES,
  type HelloMessage,
  type HelloAcknowledgmentMessage,
  type WireMessage,
} from './Protocol.js';
import { validateWireFrame } from './WireValidation.js';

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

type Connection = {
  socket: TcpSocketLike | null;     // populated on `onOpen`
  peer: NodeAddress | null;         // populated on hello / hello-ack
  decoder: FrameDecoder;
  /** Buffered frames written before the hello handshake completed. */
  pending: WireMessage[];
  outbound: boolean;
  /**
   * For an outbound dial: the address key it was registered under, captured
   * at `openOutbound` time.  `peer` only appears once the handshake lands, so
   * without this a dial that never completes owns its `byPeer` slot forever —
   * unreachable *and* un-redialable (#697).
   */
  targetKey: string | null;
  /** Armed on dial, cleared by `hello-ack`.  See {@link HANDSHAKE_TIMEOUT_MS}. */
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  /** Set once when `pending` first overflows, so the warning is not per-frame. */
  pendingOverflowed: boolean;
};

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
      this.clearHandshakeTimer(connection);
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
      // Wait for hello / hello-ack, but never without a bound.
      if (connection.pending.length >= MAX_PENDING_FRAMES) {
        connection.pending.shift();
        if (!connection.pendingOverflowed) {
          connection.pendingOverflowed = true;
          this.log.warn(
            `handshake buffer for ${to} hit ${MAX_PENDING_FRAMES} frames; dropping oldest`,
          );
        }
      }
      connection.pending.push(message);
    }
  }

  disconnect(peer: NodeAddress): void {
    const connection = this.byPeer.get(peer.toString());
    if (!connection) return;
    this.clearHandshakeTimer(connection);
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
      targetKey: null,
      handshakeTimer: null,
      pendingOverflowed: false,
    };
    this.bySocket.set(sock, connection);
  }

  private openOutbound(to: NodeAddress): Connection {
    const targetKey = to.toString();
    const connection: Connection = {
      socket: null,
      peer: null,
      decoder: new FrameDecoder(this.maxFrameBytes),
      pending: [],
      outbound: true,
      targetKey,
      handshakeTimer: null,
      pendingOverflowed: false,
    };
    this.byPeer.set(targetKey, connection);
    connection.handshakeTimer = setTimeout(
      () => this.onHandshakeTimeout(connection),
      HANDSHAKE_TIMEOUT_MS,
    );
    // Don't let a pending handshake hold the process open — the cluster's own
    // lifecycle decides when the runtime may exit, not a dial in flight.
    (connection.handshakeTimer as { unref?: () => void }).unref?.();

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
              const hello: HelloMessage = { kind: 'hello', self: this.self.toJSON() };
              s.write(encodeFrame(hello));
            },
            onData: (s, chunk) => this.onData(s, chunk),
            // Pass the connection explicitly: a socket that closes or errors
            // before the `await` below installs it is absent from `bySocket`,
            // and cleaning up by socket alone would strand its `byPeer` slot.
            onClose: (s) => this.onClose(s, connection),
            onError: (_s, err) => this.log.warn(`outbound error -> ${to}`, err),
          },
        });
        connection.socket = sock;
        this.bySocket.set(sock, connection);
      } catch (err) {
        this.log.warn(`failed to connect to ${to}`, err as Error);
        this.dropConnection(connection);
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
        targetKey: null, handshakeTimer: null, pendingOverflowed: false,
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
      this.dropConnection(connection);
      return;
    }
    for (const frame of frames) {
      // Two tiers, because the two failures mean different things.  A frame
      // that fails its shape check is *this frame's* problem — skip it and
      // keep the connection, so one bad frame cannot cost a healthy peer its
      // link (#705, #711).  A handler that throws is a problem we do not
      // understand, and until #563 this loop had no guard at all: the throw
      // left `onData`, left the runtime's socket callback, and took the
      // process with it.
      const checked = validateWireFrame(frame);
      if ('problem' in checked) {
        this.log.warn(
          `rejecting malformed frame from ${connection.peer ?? '<unknown peer>'}: ${checked.problem}`,
        );
        continue;
      }
      try {
        this.onMessage(connection, checked.message);
      } catch (err) {
        this.log.warn(
          `wire handler threw on a frame from ${connection.peer ?? '<unknown peer>'}; closing`,
          err as Error,
        );
        this.dropConnection(connection);
        return;
      }
    }
  }

  private onMessage(connection: Connection, message: WireMessage): void {
    if (message.kind === 'hello') {
      const peer = NodeAddress.fromJSON(message.self);
      if (!this.certificateAdmits(connection, peer, 'hello')) return;
      const peerKey = peer.toString();
      // Security: reject a duplicate-identity hello on a different
      // socket.  Without this, a second connection claiming the
      // same address as an existing peer would *overwrite* the
      // byPeer map — every outbound message intended for the
      // legitimate peer would then be routed to the attacker's
      // socket.  See `tests/multi-node/cluster-security.test.ts` for
      // the exploit walkthrough.
      //
      // The one case that is *not* a hijack is a crossing dial: both
      // nodes dialled each other at the same moment, so each holds an
      // un-acked outbound under the other's key and — comparing
      // identity alone — would reject the other's legitimate hello.
      // Neither dial then ever gets its `hello-ack`, and the pair stays
      // split for the process's lifetime (#697).  An *established*
      // peer connection is still never displaced; only our own
      // unfinished dial gives way, and which side gives way is decided
      // by address order so the two nodes cannot both stand down.
      const existing = this.byPeer.get(peerKey);
      if (existing && existing !== connection) {
        if (!this.crossingDialYieldsTo(existing, peerKey)) {
          this.log.warn(
            `hello hijack rejected: peer ${peerKey} already has an active connection; ` +
            `closing the new socket`,
          );
          this.dropConnection(connection);
          return;
        }
        this.log.debug(
          `crossing dial with ${peerKey}: retiring our outbound, keeping theirs`,
        );
        this.dropConnection(existing);
      }
      connection.peer = peer;
      this.byPeer.set(peerKey, connection);
      const ack: HelloAcknowledgmentMessage = { kind: 'hello-ack', self: this.self.toJSON() };
      connection.socket?.write(encodeFrame(ack));
      return;
    }
    if (message.kind === 'hello-ack') {
      const peer = NodeAddress.fromJSON(message.self);
      if (!this.certificateAdmits(connection, peer, 'hello-ack')) return;
      const peerKey = peer.toString();
      const existing = this.byPeer.get(peerKey);
      if (existing && existing !== connection) {
        // Same defense on the outbound-handshake side: someone
        // already owns this peer-key, we don't take it over from
        // them.
        this.log.warn(
          `hello-ack hijack rejected: peer ${peerKey} already mapped to a different connection`,
        );
        this.dropConnection(connection);
        return;
      }
      connection.peer = peer;
      this.clearHandshakeTimer(connection);
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

  /**
   * Whether the peer's TLS certificate vouches for the identity it just
   * claimed in its handshake frame (#912).
   *
   * mTLS decides *whether* a peer belongs in the cluster; nothing decided
   * *which* member it is.  Every gossip-authority rule since #562 keys off
   * the connection's peer, so a CA-signed node that announced itself under
   * another member's address inherited that member's standing — and, because
   * `byPeer` is keyed on the claimed address, its traffic too.  The
   * duplicate-identity guard below does not cover it: a fresh claim, or one
   * made after the real holder's connection dropped, is not a duplicate.
   *
   * Skipped entirely when there is no certificate to check.  A plaintext
   * cluster is documented as unauthenticated, one-way TLS has no client
   * certificate by design, and Deno cannot report one — in all three the
   * transport has nothing to verify against, and rejecting on that basis
   * would break every one of them rather than harden anything.  The check
   * therefore strengthens mTLS deployments without introducing a new
   * configuration knob that could be left off.
   */
  private certificateAdmits(
    connection: Connection,
    claimed: NodeAddress,
    frame: 'hello' | 'hello-ack',
  ): boolean {
    const certificate = connection.socket?.peerCertificate?.();
    if (certificate === undefined) return true;
    if (certificateVouchesFor(certificate, claimed)) return true;

    const vouchedFor = [
      ...(certificate.commonName === undefined ? [] : [certificate.commonName]),
      ...certificate.subjectAlternativeNames,
    ].join(', ');
    this.log.warn(
      `${frame} rejected: peer claims ${claimed.toString()} but its certificate names `
      + `${vouchedFor.length === 0 ? '(nothing)' : vouchedFor} — closing the connection`,
    );
    this.dropConnection(connection);
    return false;
  }

  private onClose(sock: TcpSocketLike, fallback?: Connection): void {
    const connection = this.bySocket.get(sock) ?? fallback;
    if (!connection) return;
    this.bySocket.delete(sock);
    this.clearHandshakeTimer(connection);
    this.releasePeerSlot(connection);
  }

  /* ----------------------- connection bookkeeping ----------------------- */

  /**
   * Whether an incoming `hello` from `peerKey` may retire `existing` — true
   * only for a crossing dial, never for an established peer.
   *
   * Both nodes evaluate this on their own side of the same pair and reach
   * opposite answers, because each compares the *initiator* of the connection
   * it is judging against itself: the dial from the lexicographically smaller
   * address is the one that survives.  So exactly one of the two crossing
   * dials is retired, and the surviving one completes its handshake.
   */
  private crossingDialYieldsTo(existing: Connection, peerKey: string): boolean {
    // An acked peer connection is the thing the hijack guard exists to
    // protect; only our own unfinished dial is negotiable.
    if (existing.peer !== null || !existing.outbound) return false;
    return peerKey < this.self.toString();
  }

  /**
   * Release the `byPeer` slots a connection owns.  A dialled connection is
   * registered under `targetKey` *before* the handshake, so keying cleanup on
   * `peer` alone (as this did) stranded the slot whenever the handshake never
   * completed — the address could then never be re-dialled (#697).
   *
   * Both deletes are guarded on the map still pointing at this connection, so
   * a slot already taken over by its replacement is left alone.
   */
  private releasePeerSlot(connection: Connection): void {
    for (const key of [connection.peer?.toString(), connection.targetKey]) {
      if (key !== undefined && key !== null && this.byPeer.get(key) === connection) {
        this.byPeer.delete(key);
      }
    }
  }

  private clearHandshakeTimer(connection: Connection): void {
    if (connection.handshakeTimer === null) return;
    clearTimeout(connection.handshakeTimer);
    connection.handshakeTimer = null;
  }

  /** Tear a connection down and give up whatever it was still holding. */
  private dropConnection(connection: Connection): void {
    this.clearHandshakeTimer(connection);
    const sock = connection.socket;
    if (sock) {
      try { sock.end(); } catch { /* ignore */ }
      this.bySocket.delete(sock);
    }
    this.releasePeerSlot(connection);
    connection.pending.length = 0;
  }

  /**
   * The dial produced a socket (or not) but never a `hello-ack`.  Give the
   * slot back so the next `send` re-dials, rather than queueing into a
   * connection that will never carry anything.
   */
  private onHandshakeTimeout(connection: Connection): void {
    connection.handshakeTimer = null;
    if (connection.peer !== null) return;   // handshake landed after all
    if (this.byPeer.get(connection.targetKey ?? '') !== connection) return;
    this.log.warn(
      `handshake with ${connection.targetKey} did not complete within ` +
      `${HANDSHAKE_TIMEOUT_MS} ms; dropping the connection and ` +
      `${connection.pending.length} buffered frame(s)`,
    );
    this.dropConnection(connection);
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
      if (peer.stopped) return;
      // The same two tiers as `TcpTransport.onData`, because the guarantee
      // belongs to the `Transport` contract and not to one implementation of
      // it.  Skipping this here would also make it untestable: the cluster's
      // security tests inject their hostile frames through this transport, so
      // an unguarded path would report the exploits as still open (#563, #705).
      //
      // A microtask has no caller to unwind into — an escaping throw is an
      // unhandled top-level error, which is how one poisoned gossip frame took
      // down a second node after the first had re-gossiped it.
      const checked = validateWireFrame(message);
      if ('problem' in checked) return;
      try {
        peer.handler(from, checked.message);
      } catch {
        /* Mirrors dropping the connection; there is no socket to close. */
      }
    });
  }

  disconnect(_peer: NodeAddress): void { /* stateless registry */ }

  peers(): NodeAddress[] {
    return Array.from(InMemoryTransport.registry.keys())
      .filter(k => k !== this.self.toString())
      .map(k => NodeAddress.parse(k));
  }
}
