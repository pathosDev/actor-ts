import type { Logger } from '../Logger.js';
import {
  HANDSHAKE_TIMEOUT_MS,
  INCOMPLETE_FRAME_IDLE_MS,
  MAX_INBOUND_CONNECTIONS,
  MAX_PENDING_FRAMES,
} from './Constants.js';
import {
  getTcpBackend,
  type TcpBackend,
  type TcpListener,
  type TcpSocketLike,
  type TlsTransportOptionsType,
} from '../runtime/tcp/index.js';
import { NodeAddress } from './NodeAddress.js';
import { certificateVouchesFor } from './PeerIdentity.js';
import type { ReadConstraintsOptions } from '../serialization/ReadConstraintsOptions.js';
import { TcpTransportOptionsValidator } from './TcpTransportOptions.js';
import type { TcpTransportOptions, TcpTransportOptionsType } from './TcpTransportOptions.js';
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
  /**
   * Per-frame payload cap this transport enforces, when it enforces one —
   * `undefined` where framing does not apply at all.
   *
   * Published so a *sender* can size its own payload before handing it over.
   * Nothing else on this interface reports failure: `send` is fire-and-forget
   * and the cap is checked on the far side, by a `FrameDecoder` whose throw
   * costs {@link TcpTransport} the whole association — heartbeats, membership
   * gossip and every cross-node `tell` along with the offending frame.  A
   * sender that keeps producing oversized frames therefore kills the link once
   * per attempt and never learns that it did (#691).
   *
   * Optional rather than a number every implementation must invent, because
   * three of the four in this repository genuinely frame nothing: the
   * in-memory, `MessageChannel` and multi-node transports hand the message
   * *object* to the peer, so there is no length prefix to overflow and any
   * figure here would be fiction.  Read it as "the cap this transport will
   * reject on", not "how large a message may be".
   *
   * It is the *local* cap.  There is no protocol negotiation yet (#823), so a
   * peer configured lower than this node is still able to reject a frame this
   * node considered safe; homogeneous configuration is the assumption.
   */
  readonly maxFrameBytes?: number;
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
   * Whether the runtime has reported the socket open.  Accepted sockets are
   * open by the time they exist; a dial becomes open once, on its first
   * `onOpen`, and a second report changes nothing (#1475) — an adapter that
   * maps two native events to `onOpen` would otherwise announce the dial
   * twice.
   */
  opened: boolean;
  /**
   * For an outbound dial: the address key it was registered under, captured
   * at `openOutbound` time.  `peer` only appears once the handshake lands, so
   * without this a dial that never completes owns its `byPeer` slot forever —
   * unreachable *and* un-redialable (#697).
   */
  targetKey: string | null;
  /**
   * For an outbound dial: what gives the dial up, handed to the backend as
   * `connect`'s `signal` and fired once, when the connection is retired —
   * however it is retired (#1475).
   *
   * Without it the transport could only *forget* a dial.  Its deadline
   * dropped the `Connection` and the socket under it went on connecting —
   * about 21 s past the deadline on Bun and on Node, where `end()` on a socket
   * still connecting does not stop the connect.  Aborted, the backend destroys
   * the socket while it connects, and does nothing at all to one it has
   * already handed over, so retiring an established connection still closes it
   * the way the caller chose.
   */
  dial: AbortController | null;
  /**
   * For an outbound dial: the deadline to open by, armed with the handshake
   * deadline and cleared by the dial's first `onOpen` (#1475).  A dial that
   * misses it could not connect; one that opened is the handshake deadline's
   * to end.  `null` on an accepted socket, which is open by the time it exists.
   * See {@link TcpTransport.connectTimeoutMs}.
   */
  connectTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Deadline for the handshake, armed the moment the connection exists and
   * cleared by the `hello` / `hello-ack` that completes it.  See
   * {@link TcpTransport.handshakeTimeoutMs}.
   *
   * **Both directions get one.**  A dial that never receives its `hello-ack`
   * strands a `byPeer` slot (#697); an accepted socket that never sends a
   * `hello` strands one of the {@link TcpTransport.maxInboundConnections} — the same bug
   * on the two sides of the same handshake, and only the first of the two was
   * ever bounded (#588).
   */
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Armed whenever the decoder is left holding part of a frame, re-armed on
   * every chunk and cleared when the buffer drains.  See
   * {@link TcpTransport.incompleteFrameIdleMs}.
   */
  incompleteFrameTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Whether this connection still counts against the transport's inbound cap.
   * A flag rather than `!outbound`, because the slot is given back exactly once
   * and both `onClose` and `dropConnection` can be the one to do it.
   */
  holdsInboundSlot: boolean;
  /** Set once when `pending` first overflows, so the warning is not per-frame. */
  pendingOverflowed: boolean;
  /**
   * Set when the connection is torn down, and never cleared (#1476).
   *
   * Tearing a connection down does not stop everything it already set in
   * motion, and every one of those checks this.  Retiring a dial aborts it
   * (see {@link dial}), but a backend that cannot honour the abort — Deno over
   * TLS, a `TcpBackend` of the caller's own — can still run `onOpen` and
   * resolve `connect` after the dial was given up, and would otherwise install
   * its socket, write its hello and re-enter `byPeer` on the `hello-ack`,
   * alive again with no deadline left on it.
   */
  dropped: boolean;
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
  /** Live inbound sockets, bounded by {@link maxInboundConnections} (#588). */
  private inboundConnections = 0;
  /**
   * What every socket refused at the inbound cap maps to in `bySocket`: a
   * connection retired from the start, holding no slot and no peer.  One for
   * all of them, because nothing in it is per-socket — it exists only so that
   * whatever a refused socket still delivers is recognised as a dead
   * connection's bytes and discarded.  See {@link acceptInbound}.
   */
  private readonly refusedInbound: Connection;
  /** Set while the cap is saturated, so the refusal is one WARN per episode. */
  private inboundCapReported = false;

  /**
   * Per-frame size cap (security).  Frames whose length-prefix exceeds this
   * are rejected before any payload bytes are buffered — closes the
   * 4-GiB-claim DoS vector documented on {@link FrameDecoder}.
   *
   * Public because a sender has to be able to read it — see
   * {@link Transport.maxFrameBytes} for why the send side needs the number at
   * all.
   */
  readonly maxFrameBytes: number;
  /** TLS material for both listener and dialer; `null` is plaintext. */
  private readonly tls: TlsTransportOptionsType | null;
  /**
   * Interface and port to bind, which need not be what {@link self}
   * advertises — a container binds `0.0.0.0` on its own port and tells its
   * peers one dialable address (#944, #845).  Used for exactly one thing, the
   * `listen` call: `self` stays the identity everywhere else, in the handshake
   * announcement and in the peer keys, because a wildcard would identify
   * nothing there and a remapped port would name something unreachable.
   */
  private readonly bindHost: string;
  private readonly bindPort: number;
  /** Decode ceilings for every {@link FrameDecoder} this transport builds (#880). */
  private readonly readConstraints: ReadConstraintsOptions;
  /** The four association-lifecycle bounds, resolved once (#846). */
  private readonly handshakeTimeoutMs: number;
  private readonly outboundQueueSize: number;
  private readonly maxInboundConnections: number;
  private readonly incompleteFrameIdleMs: number;
  /**
   * How long a dial has to open, resolved once (#1475): the handshake
   * deadline when nothing set one, which is what every dial ran before.
   */
  private readonly connectTimeoutMs: number;

  /**
   * `self` and `log` stay positional; everything else arrives as
   * {@link TcpTransportOptions} (#846).
   *
   * The list this replaces was seven positional parameters deep, and the four
   * lifecycle bounds would have made it eleven — a call site that wanted only
   * the inbound cap would have been five `undefined`s and a number, with
   * nothing on the line saying which bound it set.  `self` and `log` are the
   * two every construction site has an opinion about and neither has a default
   * to fall through to, so they keep their places.
   *
   * Validation runs here, once, on the merged settings: this is the consume
   * time for a transport, and it is the only point that sees an explicit
   * option and a HOCON value in the same shape (`Cluster` merges the block
   * into `ClusterOptions` before building this).
   */
  constructor(
    readonly self: NodeAddress,
    private readonly log: Logger,
    options: TcpTransportOptions = {},
  ) {
    const settings = options as TcpTransportOptionsType;
    new TcpTransportOptionsValidator().validate(settings);
    this.tls = settings.tls ?? null;
    this.maxFrameBytes = settings.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.bindHost = settings.bindHost ?? self.host;
    this.bindPort = settings.bindPort ?? self.port;
    this.readConstraints = settings.readConstraints ?? {};
    this.handshakeTimeoutMs = settings.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.connectTimeoutMs = settings.connectTimeoutMs ?? this.handshakeTimeoutMs;
    this.outboundQueueSize = settings.outboundQueueSize ?? MAX_PENDING_FRAMES;
    this.maxInboundConnections = settings.maxInboundConnections ?? MAX_INBOUND_CONNECTIONS;
    this.incompleteFrameIdleMs = settings.incompleteFrameIdleMs ?? INCOMPLETE_FRAME_IDLE_MS;
    this.refusedInbound = {
      socket: null,
      peer: null,
      decoder: new FrameDecoder(this.maxFrameBytes, this.readConstraints),
      pending: [],
      outbound: false,
      opened: true,
      targetKey: null,
      dial: null,
      connectTimer: null,
      handshakeTimer: null,
      incompleteFrameTimer: null,
      holdsInboundSlot: false,
      pendingOverflowed: false,
      dropped: true,
    };
  }

  setHandler(handler: WireHandler): void { this.handler = handler; }

  async start(): Promise<void> {
    this.backend = await getTcpBackend();
    this.listener = await this.backend.listen({
      host: this.bindHost,
      port: this.bindPort,
      tls: this.tls ?? undefined,
      handlers: {
        onOpen: (sock) => this.attachInbound(sock),
        onData: (sock, chunk) => this.onData(sock, chunk),
        onClose: (sock) => this.onClose(sock),
        onError: (_sock, err) => this.log.warn('inbound socket error', err),
      },
    });
    // Both addresses when they differ: one line that answers "what did it
    // bind" and "what will peers dial", which are the two questions a node
    // that binds a wildcard makes separable.
    //
    // Compared whole rather than host-against-host: with the port separable
    // too (#845), a node that binds 2552 and advertises 3000 differs on the
    // half a host comparison cannot see, and would log a single address that
    // reads as though nothing were split — the exact silence #944 was filed
    // to end.
    const bound = `${this.bindHost}:${this.bindPort}`;
    const advertised = `${this.self.host}:${this.self.port}`;
    this.log.info(
      bound === advertised
        ? `cluster transport listening on ${bound}`
        : `cluster transport listening on ${bound}, advertising ${advertised}`,
    );
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    // Retired, not just closed (#1476).  A dial still connecting has no socket
    // to close yet, and unmarked its `connect` installed one into the stopped
    // transport and registered it on the `hello-ack`; an established
    // connection unmarked went on handing the handler whatever the peer sent
    // until the peer closed its half.  A set, because one connection can hold
    // two keys.
    for (const connection of new Set(this.byPeer.values())) this.closeConnection(connection);
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
      this.writeFrame(connection, message);
    } else {
      // Wait for hello / hello-ack, but never without a bound.
      if (connection.pending.length >= this.outboundQueueSize) {
        connection.pending.shift();
        if (!connection.pendingOverflowed) {
          connection.pendingOverflowed = true;
          this.log.warn(
            `handshake buffer for ${to} hit ${this.outboundQueueSize} frames; dropping oldest`,
          );
        }
      }
      connection.pending.push(message);
    }
  }

  disconnect(peer: NodeAddress): void {
    // Every key the connection holds goes with it, not just the one asked for:
    // a dial is registered under the address it dialled and, once acked, under
    // the one the peer announced, and the two differ whenever a seed names a
    // host the peer does not advertise itself as.
    const connection = this.byPeer.get(peer.toString());
    if (connection) this.closeConnection(connection);
  }

  peers(): NodeAddress[] {
    // A set, because one connection can hold two keys: a dial is registered
    // under the address it dialled and, once acked, under the one the peer
    // announced.  Walking the keys listed that peer twice.
    const out: NodeAddress[] = [];
    for (const connection of new Set(this.byPeer.values())) if (connection.peer) out.push(connection.peer);
    return out;
  }

  /* --------------------------- internals -------------------------------- */

  /**
   * Encode and write one frame, dropping it if it cannot be encoded.
   *
   * `send` is reached from `RemoteActorRef.tell`, which is reached from user
   * code, and `tell` is fire-and-forget — it must not throw the way a failed
   * `ask` rejects.  Before the frame codec carried tagged values a `bigint`
   * anywhere in the body raised a bare `TypeError` from `JSON.stringify` that
   * travelled all the way back into the sending actor's `onReceive` (#450);
   * the codec refuses a narrower set now (functions, symbols, `Promise`,
   * `WeakMap` / `WeakSet`, cycles) but it still refuses, and the same route out
   * would still be there.  It is also reached from the gossip and heartbeat
   * timers, where a throw has no caller at all to catch it.
   *
   * Dropping is the only honest outcome — there is no dead-letter queue at this
   * layer — so it is logged at `error`, naming the frame kind and the peer.
   */
  private writeFrame(connection: Connection, message: WireMessage): void {
    let frame: Uint8Array;
    try {
      frame = encodeFrame(message);
    } catch (err) {
      this.log.error(
        `dropping a '${message.kind}' frame for ${connection.peer ?? connection.targetKey ?? '<unknown peer>'}: `
        + `its payload cannot be serialised`,
        err as Error,
      );
      return;
    }
    connection.socket?.write(frame);
  }

  /**
   * Register an inbound socket, unless {@link TcpTransport.maxInboundConnections} is
   * already saturated — then the socket is aborted straight away, mapped to
   * {@link refusedInbound} so that nothing it still sends is ever taken for a
   * new connection, and `null` comes back (#588).
   *
   * Idempotent, because `onData` can beat `onOpen` on Bun and both routes end
   * here: attaching twice would replace a decoder mid-frame *and* count the
   * same socket against the cap twice.  A socket whose connection was torn
   * down gets that dead connection back, never a fresh one (#1476).
   *
   * The slot is handed out against a handshake deadline, never open-ended.  A
   * socket that sends *no bytes at all* reaches neither the frame decoder nor
   * `trackIncompleteFrame`, so before that deadline existed the cheapest attack
   * on the cap was also the only one it did not cover: open
   * {@link TcpTransport.maxInboundConnections} connections, say nothing, and every
   * subsequent peer and `ClusterClient` is refused for the process's lifetime.
   * On Bun that is reachable even under mTLS, because the socket's `open`
   * callback fires *before* the TLS handshake completes — the slot is taken
   * while there is still no certificate to check.
   */
  private acceptInbound(sock: TcpSocketLike): Connection | null {
    const existing = this.bySocket.get(sock);
    if (existing) return existing;
    if (this.inboundConnections >= this.maxInboundConnections) {
      if (!this.inboundCapReported) {
        this.inboundCapReported = true;
        this.log.warn(
          `refusing inbound connections: ${this.maxInboundConnections} are already open`,
        );
      }
      // Aborted, and remembered as dead.  Half-closed and forgotten, a refused
      // socket stayed with a peer that never answered the FIN, and on Node it
      // went on delivering: every chunk came back here as a stranger's first
      // bytes, and the first one after a slot freed was adopted — its fresh
      // decoder starting in the middle of whatever frame the peer was sending.
      this.bySocket.set(sock, this.refusedInbound);
      this.abortSocket(sock);
      return null;
    }
    this.inboundConnections += 1;
    const connection: Connection = {
      socket: sock,
      peer: null,
      decoder: new FrameDecoder(this.maxFrameBytes, this.readConstraints),
      pending: [],
      outbound: false,
      opened: true,
      targetKey: null,
      dial: null,
      connectTimer: null,
      handshakeTimer: null,
      incompleteFrameTimer: null,
      holdsInboundSlot: true,
      pendingOverflowed: false,
      dropped: false,
    };
    this.bySocket.set(sock, connection);
    this.armHandshakeTimer(connection);
    return connection;
  }

  private attachInbound(sock: TcpSocketLike): void {
    this.acceptInbound(sock);
  }

  private openOutbound(to: NodeAddress): Connection {
    const targetKey = to.toString();
    const connection: Connection = {
      socket: null,
      peer: null,
      decoder: new FrameDecoder(this.maxFrameBytes, this.readConstraints),
      pending: [],
      outbound: true,
      opened: false,
      targetKey,
      dial: new AbortController(),
      connectTimer: null,
      handshakeTimer: null,
      incompleteFrameTimer: null,
      holdsInboundSlot: false,
      pendingOverflowed: false,
      dropped: false,
    };
    this.byPeer.set(targetKey, connection);
    // Connect first, from the same moment: with the two deadlines equal —
    // what an unset connect deadline is — the connect one still fires first
    // for a dial that never opened, and takes the handshake one with it.
    this.armConnectTimer(connection);
    this.armHandshakeTimer(connection);

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
          signal: connection.dial?.signal,
          handlers: {
            onOpen: (s) => {
              // Every backend runs this *before* `connect` resolves, so the
              // check after the `await` below comes too late to keep a dial
              // that was given up from announcing itself (#1476).
              if (connection.dropped || this.stopped) return;
              if (connection.opened) return;
              connection.opened = true;
              // Connected, so no longer a connect problem: from here only the
              // handshake deadline decides, and it reports a silent peer.
              this.clearConnectTimer(connection);
              // Send hello; remote will ack and we'll flush `pending` then.
              const hello: HelloMessage = { kind: 'hello', self: this.self.toJSON() };
              s.write(encodeFrame(hello));
            },
            // Both pass the connection explicitly: the socket is absent from
            // `bySocket` until the `await` below installs it, and never enters
            // it at all when the dial was given up first.  By socket alone, a
            // close would strand the `byPeer` slot (#697) and a `hello-ack`
            // would reach `acceptInbound` as a stranger's first bytes (#1476).
            onData: (s, chunk) => this.onData(s, chunk, connection),
            onClose: (s) => this.onClose(s, connection),
            onError: (_s, err) => this.log.warn(`outbound error -> ${to}`, err),
          },
        });
        // The dial may have been given up while `connect` was pending and
        // resolved anyway — a backend that could not honour the abort (Deno
        // over TLS closes such a connection itself; a caller's own backend may
        // not) lands here after its own deadline (#1476).  Installing the
        // socket would revive a connection nothing tracks any more; nobody is
        // waiting for it, so it is aborted rather than closed.
        if (connection.dropped || this.stopped) {
          this.abortSocket(sock);
          return;
        }
        connection.socket = sock;
        this.bySocket.set(sock, connection);
      } catch (err) {
        // A dial given up — by its deadline, a fault, `disconnect` or
        // `shutdown` — rejects with its signal's reason, and whatever gave it
        // up has already said so, or had nothing to say.  Reporting it again
        // here was a second WARN for the same dead dial (#1476).
        if (connection.dropped || this.stopped) return;
        this.log.warn(this.couldNotConnect(connection), err as Error);
        this.dropConnection(connection);
      }
    })();

    return connection;
  }

  /**
   * Bytes from a socket.  `fallback` is the dial's own connection when the
   * socket is a dial's — the one case where the socket may be in no map yet.
   */
  private onData(sock: TcpSocketLike, chunk: Uint8Array, fallback?: Connection): void {
    // Bun delivers `data` before `open` completes its microtask in some edge
    // cases — attach a fresh inbound Connection lazily, subject to the same
    // inbound cap the `onOpen` route goes through.
    const connection = this.bySocket.get(sock) ?? fallback ?? this.acceptInbound(sock);
    // A torn-down connection's bytes are nobody's: a dial's `hello-ack` that
    // arrived after the dial was given up, or whatever a runtime still delivers
    // on a socket it was told to close (#1476).  Decoding them would re-arm a
    // stall deadline on a dead connection, and handing them on would revive it.
    if (connection === null || connection.dropped) return;
    // A stopped transport takes nothing from anyone.  `shutdown` retires every
    // connection in `byPeer`, but one still waiting for its hello is in no map
    // it walks, and that hello would register a peer — and hand the handler
    // its frames — on a transport that has stopped (#1476).  Its deadline
    // would close it eventually; its first byte after the stop closes it now.
    if (this.stopped) {
      this.dropConnection(connection);
      return;
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
    this.trackIncompleteFrame(connection);
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
    // Before either hijack guard and any `byPeer.set`: a connection can be
    // torn down halfway through a chunk — a guard below refuses one frame and
    // `onData` goes on to the next — and nothing after that is a handshake or
    // a message from anyone (#1476).
    if (connection.dropped) return;
    if (message.kind === 'hello') {
      const peer = NodeAddress.fromJSON(message.self);
      if (this.refuseOwnAddress(connection, peer, 'hello')) return;
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
          // Only a claim on an *acked* connection is a hijack.  A slot that
          // holds our own unfinished dial is the other half of a crossing
          // dial, on the side whose dial the tie-break keeps — the ordinary
          // race of two seeds starting together, which this used to report
          // at WARN as a hijack (#1476).  Turned away the same either way;
          // and under mTLS `certificateAdmits` has already established that
          // the hello really is that peer's.
          if (this.isUnfinishedDial(existing)) {
            this.log.debug(`crossing dial with ${peerKey}: keeping our outbound, refusing theirs`);
          } else {
            this.log.warn(
              `hello hijack rejected: peer ${peerKey} already has an active connection; ` +
              `closing the new socket`,
            );
          }
          this.dropConnection(connection);
          return;
        }
        this.log.debug(
          `crossing dial with ${peerKey}: retiring our outbound, keeping theirs`,
        );
        this.dropConnection(existing);
      }
      connection.peer = peer;
      this.clearHandshakeTimer(connection);
      this.byPeer.set(peerKey, connection);
      const ack: HelloAcknowledgmentMessage = { kind: 'hello-ack', self: this.self.toJSON() };
      connection.socket?.write(encodeFrame(ack));
      return;
    }
    if (message.kind === 'hello-ack') {
      const peer = NodeAddress.fromJSON(message.self);
      if (this.refuseOwnAddress(connection, peer, 'hello-ack')) return;
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
      for (const bufferedMessage of buffered) this.writeFrame(connection, bufferedMessage);
      return;
    }
    if (!connection.peer) {
      this.log.warn('received message before hello handshake', message);
      return;
    }
    this.handler(connection.peer, message);
  }

  /**
   * Refuse a handshake frame that names this node itself, and say whether it
   * did.
   *
   * A peer is never the node it is talking to.  Neither guard after this one
   * can say so: a node holds no connection to itself, so the duplicate-identity
   * check finds nothing under its own address to defend, and without a
   * certificate {@link certificateAdmits} has nothing to hold the claim
   * against.  So it is asked first, of the `hello` an accepted socket opens
   * with and of the `hello-ack` that answers a dial alike, and a claim on this
   * node's own address gets the connection dropped with no identity and
   * nothing registered under the address.
   *
   * The line renders {@link self}, which the claim equals field for field, so
   * it names the claimed address without carrying a byte the peer wrote.
   */
  private refuseOwnAddress(connection: Connection, claimed: NodeAddress, frame: 'hello' | 'hello-ack'): boolean {
    if (!claimed.equals(this.self)) return false;
    this.log.warn(
      `${frame} refused: the peer claims ${this.self.toString()}, this node's own address — closing the connection`,
    );
    this.dropConnection(connection);
    return true;
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
    if (connection) this.retireConnection(connection);
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
    if (!this.isUnfinishedDial(existing)) return false;
    return peerKey < this.self.toString();
  }

  /** Our own dial that has not been acked yet — the one connection a crossing dial may contest. */
  private isUnfinishedDial(connection: Connection): boolean {
    return connection.peer === null && connection.outbound;
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

  /**
   * Give an inbound connection's slot back, once (#588).
   *
   * Clearing the saturation flag here rather than on the next refusal is what
   * makes the WARN one line per saturation episode instead of one per lifetime:
   * a node that fills up, drains and fills up again is worth telling an
   * operator about twice.
   */
  private releaseInboundSlot(connection: Connection): void {
    if (!connection.holdsInboundSlot) return;
    connection.holdsInboundSlot = false;
    this.inboundConnections -= 1;
    this.inboundCapReported = false;
  }

  /**
   * Put a connection on the handshake clock (#588, #697).
   *
   * One helper for both directions, because arming it in only one of the two
   * places that build a `Connection` is exactly the hole this closes — and a
   * parallel mechanism for the inbound side would have to be kept in step with
   * this one by hand.
   *
   * Deliberately *not* re-armed on progress, unlike the incomplete-frame
   * deadline: the handshake is a single small frame, so re-arming would let a
   * socket dripping one byte every few seconds hold its slot for as long as it
   * cares to. Nothing legitimate is punished by the hard bound either — the
   * peer on the other end runs the same {@link handshakeTimeoutMs} from an
   * *earlier* moment (its clock starts before the TCP connect and the TLS
   * handshake, this one starts after the accept), so a peer that is still
   * trying has always given up first.  On a dial it bounds the whole dial and
   * is armed together with the connect deadline ({@link armConnectTimer}),
   * which gives up a dial that never opened before this one can: what reaches
   * this deadline on a dial is one that connected and was never answered.
   *
   * "The same" survives the value becoming configurable (#846) because there
   * is **one** key for both directions: an operator raising or lowering
   * `actor-ts.remote.handshake-timeout` moves the dial and the accept together
   * on the node that reads it, and a homogeneous deployment keeps the ordering
   * for free.  Splitting it in two would put the invariant in an operator's
   * hands, where an accept deadline below the dial deadline makes a healthy
   * peer unreachable with nothing in the log that says why.
   */
  private armHandshakeTimer(connection: Connection): void {
    connection.handshakeTimer = setTimeout(
      () => this.onHandshakeTimeout(connection),
      this.handshakeTimeoutMs,
    );
    // Don't let a pending handshake hold the process open — the cluster's own
    // lifecycle decides when the runtime may exit, not a handshake in flight.
    (connection.handshakeTimer as { unref?: () => void }).unref?.();
  }

  private clearHandshakeTimer(connection: Connection): void {
    if (connection.handshakeTimer === null) return;
    clearTimeout(connection.handshakeTimer);
    connection.handshakeTimer = null;
  }

  /**
   * Put a dial on the connect clock (#1475): {@link connectTimeoutMs} to open,
   * counted from the moment the dial is registered, and cleared by its first
   * `onOpen`.
   *
   * The handshake deadline used to be the only one a dial had, which made
   * a blackholed connect and a peer that accepted and never spoke the same
   * failure at the same moment.  They are not: the first is known once the
   * connect has had its chance, the second deserves the whole handshake
   * deadline.  The validators keep this one at or below the handshake one, and
   * it is armed first, so it is always the deadline that gives up a dial that
   * never opened — the handshake one then only ever sees dials that did.
   */
  private armConnectTimer(connection: Connection): void {
    connection.connectTimer = setTimeout(
      () => this.onConnectTimeout(connection),
      this.connectTimeoutMs,
    );
    // Unreferenced for the handshake timer's reason: a dial in flight is not
    // what decides when the runtime may exit.
    (connection.connectTimer as { unref?: () => void }).unref?.();
  }

  private clearConnectTimer(connection: Connection): void {
    if (connection.connectTimer === null) return;
    clearTimeout(connection.connectTimer);
    connection.connectTimer = null;
  }

  /**
   * The dial never opened within {@link connectTimeoutMs}: report it as one
   * that could not connect and give it up — `dropConnection` aborts the
   * connect, so the socket under it is destroyed rather than left connecting,
   * and clears the handshake deadline with everything else the dial held.
   */
  private onConnectTimeout(connection: Connection): void {
    connection.connectTimer = null;
    if (connection.dropped || connection.opened) return;
    // A `byPeer` slot already taken over by a replacement dial is not ours.
    if (this.byPeer.get(connection.targetKey ?? '') !== connection) return;
    this.log.warn(this.couldNotConnect(connection));
    this.dropConnection(connection);
  }

  /**
   * Arm — or disarm — the deadline on a half-received frame (#588).
   *
   * Re-arming on every chunk is deliberate: the bound is "no byte has arrived
   * since", not "this frame is taking too long", so a peer pushing a large
   * frame over a congested link keeps its connection for as long as it keeps
   * making progress.  Ordinary traffic pays nothing — a chunk that ends on a
   * frame boundary leaves no pending bytes, so no timer is ever created.
   */
  private trackIncompleteFrame(connection: Connection): void {
    this.clearIncompleteFrameTimer(connection);
    if (connection.decoder.pendingBytes() === 0) return;
    connection.incompleteFrameTimer = setTimeout(
      () => this.onIncompleteFrameTimeout(connection),
      this.incompleteFrameIdleMs,
    );
    // Same reasoning as the handshake timer: a half-received frame must not be
    // what keeps the runtime from exiting.
    (connection.incompleteFrameTimer as { unref?: () => void }).unref?.();
  }

  private clearIncompleteFrameTimer(connection: Connection): void {
    if (connection.incompleteFrameTimer === null) return;
    clearTimeout(connection.incompleteFrameTimer);
    connection.incompleteFrameTimer = null;
  }

  /** The peer stopped mid-frame and never came back — reclaim the buffer. */
  private onIncompleteFrameTimeout(connection: Connection): void {
    connection.incompleteFrameTimer = null;
    const pending = connection.decoder.pendingBytes();
    if (pending === 0) return;
    this.log.warn(
      `no data from ${connection.peer ?? '<unknown peer>'} for ${this.incompleteFrameIdleMs} ms `
      + `while ${pending} byte(s) of an incomplete frame are buffered; closing the connection`,
    );
    this.dropConnection(connection);
  }

  /**
   * Tear a connection down for a fault and give up whatever it was still
   * holding: a deadline that passed, a frame or a handshake that was refused,
   * a dial that failed or gave way.
   *
   * The socket is aborted, not half-closed (#1096, #1476).  `end()` sends a
   * FIN and leaves the peer's half open, so a peer that never answers keeps
   * the socket and its descriptor for as long as it likes — and on Node the
   * socket stays readable meanwhile, which is the door a dropped connection's
   * late bytes used to come back through.  Nothing written to a connection
   * dropped for a fault is worth flushing.
   */
  private dropConnection(connection: Connection): void {
    if (!this.retireConnection(connection)) return;
    if (connection.socket) this.abortSocket(connection.socket);
  }

  /**
   * Close a connection in order — for the closes this transport is asked for,
   * `disconnect` and `shutdown`, where {@link dropConnection} is for the ones
   * it decides on after a fault.
   *
   * Retired the same way, so nothing the connection set in motion brings it
   * back (#1476).  But the socket is half-closed rather than aborted, so what
   * was written to it still reaches the peer: `Cluster.leave` writes its leave
   * frames immediately before `shutdown()`, and an abort discards whatever is
   * still buffered.
   *
   * Except on a connection that never completed its handshake, which is
   * aborted like a fault (#1475).  Nothing but its own `hello` was ever written
   * to it — frames wait in `pending` for the `hello-ack` — so there is nothing
   * to flush, and a half-close leaves the socket open for as long as a peer
   * that accepted and never spoke keeps its own half.
   */
  private closeConnection(connection: Connection): void {
    if (!this.retireConnection(connection)) return;
    const socket = connection.socket;
    if (socket === null) return;
    if (connection.peer === null) {
      this.abortSocket(socket);
      return;
    }
    try { socket.end(); } catch { /* ignore */ }
  }

  /**
   * Mark a connection dead and give back everything it holds — its deadlines,
   * its inbound slot, its `byPeer` entries and the frames it was buffering —
   * once; `false` when it was already retired.  The socket is the caller's,
   * because how to close it depends on why the connection is going.
   *
   * The `bySocket` entry is deliberately left in place (#1476).  It is a
   * `WeakMap`, so it costs nothing once the socket is gone, and while the
   * socket is not gone it is what makes anything a runtime still delivers on
   * it bytes for a dead connection — rather than a stranger's first bytes,
   * which is what `onData` makes of a socket it cannot find.  Node delivers on
   * a socket this side half-closed until the peer closes its own half, so
   * forgetting the socket turned a dropped dial's late `hello-ack` into a new
   * inbound connection, and re-armed the inbound handshake deadline for a
   * socket that drips one byte per deadline.
   *
   * A dial still connecting is aborted here, the one place every way a
   * connection dies passes through (#1475) — a deadline, a fault, a crossing
   * dial giving way, `disconnect`, `shutdown`, the socket's own close.  The
   * backend destroys the socket under a connect in flight, and ignores an
   * abort that comes after it handed the socket over, so the socket's fate on
   * an established connection is still the caller's to decide.
   */
  private retireConnection(connection: Connection): boolean {
    if (connection.dropped) return false;
    connection.dropped = true;
    connection.dial?.abort();
    this.clearConnectTimer(connection);
    this.clearHandshakeTimer(connection);
    this.clearIncompleteFrameTimer(connection);
    this.releaseInboundSlot(connection);
    this.releasePeerSlot(connection);
    connection.pending.length = 0;
    return true;
  }

  /**
   * Close both halves of a socket at once, for one nobody is going to read
   * from (#1096) — falling back to `end()` where the socket offers no
   * `destroy()`, since a half-close still beats leaving it open.
   *
   * Written out rather than as `destroy?.() ?? end()`: `destroy()` returns
   * `undefined`, so that spelling half-closes every socket it has just aborted.
   */
  private abortSocket(socket: TcpSocketLike): void {
    try {
      if (socket.destroy) socket.destroy();
      else socket.end();
    } catch { /* already closing */ }
  }

  /**
   * The line for a dial that never got a connection — its connect deadline
   * passed first, or its connect failed first.  Either way it names the
   * connect deadline, the bound a dial that never opened ran against.
   *
   * Worded from what the transport knows, never from the runtime's error code:
   * on Windows Bun 1.4.2 reports an unanswered SYN as `ECONNREFUSED`, so a line
   * that quoted the code would call a blackholed peer a refusal.  The runtime's
   * error, when there is one, travels as the WARN's argument, and the line is
   * the same on every runtime because every backend reports a failed dial the
   * same way, by rejecting `connect` (#1475).
   */
  private couldNotConnect(connection: Connection): string {
    return `could not connect to ${connection.targetKey} within ${this.connectTimeoutMs} ms; `
      + `dropping the connection and ${connection.pending.length} buffered frame(s)`;
  }

  /**
   * The handshake never landed.  What that strands differs by direction — a
   * dial owns a `byPeer` entry, an accepted socket owns one of the
   * {@link TcpTransport.maxInboundConnections} — but `dropConnection` gives back whatever
   * this connection was holding, so only the diagnosis and the "is this still
   * the connection that matters?" test are per-direction.
   *
   * A dial that reaches this deadline reached its peer and was never answered
   * — a peer that is up and not speaking the protocol.  One that never opened
   * is the connect deadline's ({@link onConnectTimeout}): armed first, never
   * later than this one, and it clears this one when it gives the dial up.
   * The two failures used to read the same, though the other one is a network
   * problem (#1475).
   */
  private onHandshakeTimeout(connection: Connection): void {
    connection.handshakeTimer = null;
    if (connection.peer !== null) return;   // handshake landed after all
    if (connection.outbound) {
      // A `byPeer` slot already taken over by a replacement dial is not ours.
      if (this.byPeer.get(connection.targetKey ?? '') !== connection) return;
      this.log.warn(
        `connected to ${connection.targetKey}, but no hello-ack came within `
        + `${this.handshakeTimeoutMs} ms; dropping the connection and `
        + `${connection.pending.length} buffered frame(s)`,
      );
    } else if (!this.stopped) {
      // Guarded because `shutdown` cannot reach an un-handshaken inbound
      // connection — it walks `byPeer`, which one has not entered yet — so this
      // deadline is also what finally closes those sockets.  Doing that is
      // right; calling it a timeout in the log is not.
      this.log.warn(
        `inbound socket from ${connection.socket?.remoteAddress ?? '<unknown address>'} sent no ` +
        `hello within ${this.handshakeTimeoutMs} ms; closing it and releasing its inbound slot`,
      );
    }
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
