import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { getTcpBackend } from '../../runtime/tcp/index.js';
import type { TcpListener, TcpSocketLike } from '../../runtime/tcp/index.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import {
  DEFAULT_FRAMING,
  appendChunk,
  extractFrames,
  readFramingFromConfig,
} from './TcpFraming.js';
import type { TcpFrame } from './TcpFraming.js';
import { TcpServerOptionsValidator } from './TcpServerOptions.js';
import type { TcpServerOptions, TcpServerOptionsType } from './TcpServerOptions.js';
import type { TcpOutbound } from './TcpSocketActor.js';

/**
 * Handle for one accepted connection, opaque to callers.
 *
 * A local bookkeeping key, not a wire identifier: it never leaves the
 * process, so a counter is the right generator — it is greppable in a log,
 * and the peer has no way to see or influence it.
 */
export type TcpConnectionId = string;

/**
 * Write bytes (or a UTF-8-encoded string) to one accepted connection.
 *
 * The five variants below are exported, unlike most variant types in the
 * project, because this union crosses the package boundary: the `target`
 * actor handles them, and a handler takes the named variant type (#1095).
 */
export type SendCommand = {
  readonly kind: 'send';
  readonly connectionId: TcpConnectionId;
  readonly payload: TcpOutbound;
};
/** Close one accepted connection.  The listener keeps serving the rest. */
export type CloseCommand = { readonly kind: 'close'; readonly connectionId: TcpConnectionId };

/** What a {@link TcpServerActor} accepts. */
export type TcpServerCommand = SendCommand | CloseCommand;

/** A peer connected and was admitted. */
export type ConnectionOpenedMessage = {
  readonly kind: 'connectionOpened';
  readonly connectionId: TcpConnectionId;
  /** Peer address when the runtime exposes one. */
  readonly remoteAddress?: string;
};
/** One inbound frame, as cut by the configured framing. */
export type FrameMessage = {
  readonly kind: 'frame';
  readonly connectionId: TcpConnectionId;
  readonly payload: TcpFrame;
};
/** The connection is gone — peer closed, error, cap breach, or unbind. */
export type ConnectionClosedMessage = {
  readonly kind: 'connectionClosed';
  readonly connectionId: TcpConnectionId;
};

/** What the configured `target` receives from a {@link TcpServerActor}. */
export type TcpServerMessage = ConnectionOpenedMessage | FrameMessage | ConnectionClosedMessage;

/** One live connection and the partial frame it has accumulated. */
type ServerConnection = {
  readonly connectionId: TcpConnectionId;
  readonly socket: TcpSocketLike;
  /** Bytes not yet matched by the framing strategy. */
  inboundBuffer: Uint8Array;
  /**
   * How far into {@link inboundBuffer} the `lines` delimiter search already
   * reached — per connection, because each peer sets its own pace (#610).
   */
  inboundScanFrom: number;
};

/**
 * TCP **listener** actor — the server-side counterpart to
 * {@link TcpSocketActor} (#158).
 *
 * Built on `runtime/tcp`'s {@link getTcpBackend} rather than `node:net`, so
 * the Bun / Node / Deno differences (and TLS, including mTLS) come from the
 * adapter the cluster transport already uses, not from a second copy.
 *
 * **Why a `BrokerActor` and not a separate IO manager.**  A listener needs
 * exactly what the base class already owns: a lifecycle with an explicit
 * state, a backoff policy for a bind that fails (a port in `TIME_WAIT` is the
 * ordinary case), `BrokerConnected` / `BrokerDisconnected` events, the
 * three-layer options merge, and validation.  {@link UdpSocketActor} already
 * maps *bound* onto `connected` for the same reason; a parallel
 * manager-actor + registration handshake would re-implement all of it to gain
 * nothing this API needs.
 *
 * **One actor, not one actor per connection.**  Connections are addressed by
 * an opaque {@link TcpConnectionId} instead of getting an actor each, because
 * an actor's restart semantics do not apply to a socket — a restarted
 * connection actor cannot resurrect the peer's TCP connection, so the
 * supervision that per-connection actors would buy is illusory.  The `target`
 * is free to spawn a child per `connectionOpened` when it wants per-connection
 * state; nothing here forces the allocation.
 *
 * Inbound goes to `target` as {@link TcpServerMessage}; outbound is the
 * ordinary broker path, so ordering follows the mailbox.
 */
export class TcpServerActor
  extends BrokerActor<TcpServerOptionsType, TcpServerCommand, TcpServerCommand> {
  private listener: TcpListener | null = null;
  private actualPort = 0;
  private connectionCounter = 0;
  private readonly connections = new Map<TcpConnectionId, ServerConnection>();
  /**
   * Reverse index: the backend hands the socket back to the handlers, never
   * our id.  A `WeakMap` because the adapters explicitly do not let callers
   * stash state on the socket (Bun's `.data` is not portable).
   */
  private readonly connectionsBySocket = new WeakMap<TcpSocketLike, ServerConnection>();

  constructor(options: TcpServerOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.tcpServer; }

  /**
   * `outboundBuffer: 0` — the one default that differs from every other
   * broker actor, and deliberately.  Buffering while "disconnected" exists so
   * a message survives a reconnect; here "disconnected" means the listener is
   * down, which means every connection it accepted is already gone, so a
   * buffered write is addressed to a connection id that can never come back.
   * Failing fast (a `BrokerNotConnected` event) says that; replaying it later
   * against a stale id would not.
   */
  protected builtInDefaultOptions(): Partial<TcpServerOptionsType> {
    return {
      bindHost: '0.0.0.0',
      framing: DEFAULT_FRAMING,
      maxConnections: Number.POSITIVE_INFINITY,
      outboundBuffer: 0,
    };
  }

  /** `tls` is intentionally absent — a private key does not belong in a config file. */
  protected readOptionsFromConfig(config: Config): Partial<TcpServerOptionsType> {
    const out: { -readonly [K in keyof TcpServerOptionsType]?: TcpServerOptionsType[K] } = {};
    if (config.hasPath('bindHost')) out.bindHost = config.getString('bindHost');
    if (config.hasPath('bindPort')) out.bindPort = config.getInt('bindPort');
    if (config.hasPath('maxConnections')) out.maxConnections = config.getInt('maxConnections');
    if (config.hasPath('framing')) out.framing = readFramingFromConfig(config.getConfig('framing'));
    return out;
  }

  protected requiredOptions(): ReadonlyArray<keyof TcpServerOptionsType> {
    return ['bindPort', 'target'];
  }

  protected override optionsValidator(): TcpServerOptionsValidator {
    return new TcpServerOptionsValidator();
  }

  protected endpointLabel(): string {
    const scheme = this.options.tls ? 'tls' : 'tcp';
    return `${scheme}://${this.options.bindHost}:${this.actualPort || this.options.bindPort}`;
  }

  /** OS-assigned port after `bind` — the value to read back when `bindPort: 0`. */
  get boundPort(): number { return this.actualPort; }

  /** Connections currently accepted and registered. */
  get connectionCount(): number { return this.connections.size; }

  /* ----------------------------- lifecycle ------------------------------ */

  protected async connectImplementation(): Promise<void> {
    const backend = await getTcpBackend();
    this.listener = await backend.listen({
      host: this.options.bindHost ?? '0.0.0.0',
      port: this.options.bindPort!,
      ...(this.options.tls === undefined ? {} : { tls: this.options.tls }),
      handlers: {
        onOpen: (socket) => this.onSocketOpened(socket),
        onData: (socket, chunk) => this.onSocketData(socket, chunk),
        onClose: (socket) => this.onSocketClosed(socket),
        onError: (socket, error) => this.onSocketError(socket, error),
      },
    });
    this.actualPort = this.listener.port;
  }

  /**
   * Drop the listener and every connection it accepted.  Idempotent: the base
   * class calls this before every reconnect attempt and again on stop.
   *
   * Each connection is announced closed before its socket goes, so the
   * `target` learns that its ids are dead from the same message it would have
   * got had the peer hung up — one code path, not two.
   */
  protected async disconnectImplementation(): Promise<void> {
    const listener = this.listener;
    this.listener = null;
    this.actualPort = 0;
    for (const connection of [...this.connections.values()]) this.closeConnection(connection);
    this.connections.clear();
    if (listener) await listener.close();
  }

  /* ------------------------------ outbound ------------------------------ */

  override onReceive(command: TcpServerCommand): void {
    // Both commands act on a connection the listener owns, so both go through
    // the outbound path: that is what keeps a `send` followed by a `close`
    // from being reordered, and what answers either one with
    // `BrokerNotConnected` while the listener is down.
    this.enqueueOutbound(command);
  }

  protected async dispatchOutgoing(envelope: OutboundEnvelope<TcpServerCommand>): Promise<void> {
    match(envelope.payload)
      .with({ kind: 'send' }, (c) => this.onSend(c))
      .with({ kind: 'close' }, (c) => this.onClose(c))
      .exhaustive();
  }

  private onSend(command: SendCommand): void {
    const connection = this.connections.get(command.connectionId);
    if (connection === undefined) { this.warnUnknownConnection('send', command.connectionId); return; }
    const bytes = command.payload instanceof Uint8Array
      ? command.payload
      : new TextEncoder().encode(command.payload);
    connection.socket.write(bytes);
  }

  private onClose(command: CloseCommand): void {
    const connection = this.connections.get(command.connectionId);
    if (connection === undefined) { this.warnUnknownConnection('close', command.connectionId); return; }
    this.closeConnection(connection);
  }

  /**
   * A command naming a connection that has already gone is warned about and
   * dropped — never thrown.  `BrokerActor` reads a throw out of
   * `dispatchOutgoing` as the transport failing and answers it by tearing the
   * connection down and reconnecting; here that would drop every *other*
   * client because one id lost a race with its own `connectionClosed`.
   */
  private warnUnknownConnection(action: string, connectionId: TcpConnectionId): void {
    this.log.warn(`TcpServerActor: dropped '${action}' for unknown connection '${connectionId}'`);
  }

  /* ------------------------- accepted connections ------------------------ */

  private onSocketOpened(socket: TcpSocketLike): void {
    const cap = this.options.maxConnections ?? Number.POSITIVE_INFINITY;
    if (this.connections.size >= cap) {
      // Refuse at the door rather than accept-and-forget: an unregistered
      // socket nothing reads from is a file descriptor leak with extra steps.
      //
      // Aborted, not ended.  `end()` is a half-close, so a peer that does not
      // answer the FIN keeps the socket in FIN_WAIT_2 — still writable from
      // its side, still holding a descriptor, and not counted by
      // `connections`, which is what the cap is enforced against.  Refusing
      // that way is not a cap at all: it bounds only peers that cooperate
      // (#1096).
      this.abortSocketQuietly(socket);
      this.log.warn(`TcpServerActor: refused a connection — at maxConnections=${cap}`);
      return;
    }
    const connectionId = `tcp-${++this.connectionCounter}`;
    const connection: ServerConnection = {
      connectionId,
      socket,
      inboundBuffer: new Uint8Array(0),
      inboundScanFrom: 0,
    };
    this.connections.set(connectionId, connection);
    this.connectionsBySocket.set(socket, connection);
    this.deliver({ kind: 'connectionOpened', connectionId, remoteAddress: socket.remoteAddress });
  }

  private onSocketData(socket: TcpSocketLike, chunk: Uint8Array): void {
    const connection = this.connectionsBySocket.get(socket);
    // Data on a socket we refused or already forgot: nothing to frame it into.
    if (connection === undefined || !this.connections.has(connection.connectionId)) return;

    connection.inboundBuffer = appendChunk(connection.inboundBuffer, chunk);
    const extraction = extractFrames(
      connection.inboundBuffer,
      this.options.framing ?? DEFAULT_FRAMING,
      connection.inboundScanFrom,
    );
    for (const frame of extraction.frames) {
      this.deliver({ kind: 'frame', connectionId: connection.connectionId, payload: frame });
    }
    if (extraction.overflow !== undefined) {
      // A breached frame cap is one peer's doing.  The client actor answers it
      // by losing its connection, which there *is* the whole transport; a
      // listener that did the same would let any client take the service down.
      this.log.warn(
        `TcpServerActor: closing '${connection.connectionId}' — ${extraction.overflow}`,
      );
      this.closeConnection(connection);
      return;
    }
    connection.inboundBuffer = extraction.remainder;
    connection.inboundScanFrom = extraction.scanFrom ?? 0;
  }

  private onSocketClosed(socket: TcpSocketLike): void {
    const connection = this.connectionsBySocket.get(socket);
    if (connection !== undefined) this.forgetConnection(connection);
  }

  private onSocketError(socket: TcpSocketLike, error: Error): void {
    const connection = this.connectionsBySocket.get(socket);
    if (connection === undefined) return;
    // One socket erroring is not the listener failing, so this must NOT reach
    // handleConnectionLost — that would rebind the port over a peer's bad day.
    this.log.warn(`TcpServerActor: connection '${connection.connectionId}' failed: ${error.message}`);
    this.closeConnection(connection);
  }

  /** End the socket and announce it — the single teardown path for one connection. */
  private closeConnection(connection: ServerConnection): void {
    this.endSocketQuietly(connection.socket);
    this.forgetConnection(connection);
  }

  /**
   * Deregister and announce, exactly once.  `close()` from us and the
   * runtime's own `onClose` both land here, and the peer's FIN can arrive
   * while a teardown is already running.
   */
  private forgetConnection(connection: ServerConnection): void {
    if (!this.connections.delete(connection.connectionId)) return;
    // Release the partial frame with the connection.  `connectionsBySocket` is
    // weak but the socket outlives this call, and a connection closed for
    // breaching a cap is holding the largest buffer of the lot (#578).
    connection.inboundBuffer = new Uint8Array(0);
    connection.inboundScanFrom = 0;
    this.deliver({ kind: 'connectionClosed', connectionId: connection.connectionId });
  }

  /** `end()` on an already-dead socket throws on some runtimes; nothing to do about it. */
  private endSocketQuietly(socket: TcpSocketLike): void {
    try { socket.end(); } catch { /* already closing */ }
  }

  /**
   * Close both halves at once — for a connection this actor never accepted.
   *
   * Falls back to `end()` where the backend offers no `destroy()`: a
   * half-close is still better than leaving the socket open, and a fake
   * socket in a test has no reason to implement both.
   */
  private abortSocketQuietly(socket: TcpSocketLike): void {
    try {
      if (socket.destroy) socket.destroy();
      else socket.end();
    } catch { /* already closing */ }
  }

  private deliver(message: TcpServerMessage): void {
    this.options.target?.tell(message);
  }
}
