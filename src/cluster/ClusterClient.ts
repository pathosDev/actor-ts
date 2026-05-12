/**
 * Outside-in entrypoint for talking to actors on a remote cluster (#86).
 *
 * `ClusterClient` is a lightweight handle that connects to one of a
 * supplied list of "contact-point" cluster nodes and exchanges wire
 * messages with the `ClusterClientReceptionist` running there.  The
 * client itself does NOT join the cluster — it has no NodeAddress in
 * the membership ring, no heartbeat duty, no gossip role.  It's
 * appropriate for:
 *
 *   - REST frontends sending commands to a sharded entity actor.
 *   - Cron / batch jobs poking specific actors on a schedule.
 *   - Operator scripts talking to administrative actors.
 *
 * **What's IN scope for v1:**
 *   - Fire-and-forget `send(targetPath, message)`.
 *   - Request/reply `ask(targetPath, message, timeoutMs)`.
 *   - Contact-point failover on dial errors (round-robin).
 *
 * **What's OUT of scope for v1:**
 *   - ActorRef payloads.  If `message` contains an embedded `ActorRef`
 *     it won't be rewritten — the cluster will receive whatever the
 *     JSON-serialized form is, typically dead-letter-bound.
 *   - Per-message routing to a specific cluster node.  Whoever
 *     happens to be the active contact-point routes locally; if your
 *     target is sharded across the cluster, the receiving node's
 *     local `ShardRegion` does the further hop.
 *   - Push-style subscriptions (the cluster pushing events to the
 *     client without a prior ask).  Add a follow-up issue if needed.
 *
 * Design notes — TCP-piggyback over the cluster transport (Plan-A
 * from the v0.8.0 plan-doc): the client opens one persistent TCP
 * connection to the active contact-point, performs the standard
 * `hello`/`hello-ack` handshake from `Protocol.ts` with a synthetic
 * client address, then exchanges `cluster-client-envelope` and
 * `cluster-client-reply` frames.  Reusing the wire layer means we
 * inherit framing, ordering, and TLS for free.
 */

import { getTcpBackend, type TcpSocketLike, type TlsTransportSettings } from '../runtime/tcp/index.js';
import { ConsoleLogger, LogLevel, type Logger } from '../Logger.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../util/Constants.js';
import { NodeAddress, type NodeAddressData } from './NodeAddress.js';
import { encodeFrame, FrameDecoder, type WireMessage, type HelloMsg, type HelloAckMsg } from './Protocol.js';
import type {
  ClusterClientEnvelopeMsg,
  ClusterClientReplyMsg,
} from './ClusterClientReceptionist.js';

export interface ClusterClientSettings {
  /**
   * Cluster nodes to dial.  Each is a `host:port` or `<system>@host:port`
   * string — the same shape `Cluster.join` accepts for seeds.  Tried in
   * order; on dial failure the next is attempted.
   */
  readonly contactPoints: ReadonlyArray<string>;
  /** Synthetic system name embedded in the client's hello.  Default: 'cluster-client'. */
  readonly systemName?: string;
  /**
   * Host + port the client claims as its identity.  The cluster uses this
   * to route `cluster-client-reply` frames back over the right connection.
   * Use a host:port that uniquely identifies this client instance — random
   * defaults are fine because the cluster only needs it for connection
   * routing, not for actual networking back to the client.
   */
  readonly clientIdentity?: { readonly host: string; readonly port: number };
  /** Default ask timeout (ms).  Default: 5_000. */
  readonly askTimeoutMs?: number;
  /** Optional TLS config — must match the cluster's. */
  readonly tls?: TlsTransportSettings;
  /** Custom logger; default: ConsoleLogger at WARN. */
  readonly log?: Logger;
}

interface PendingAsk {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const HELLO_TIMEOUT_MS = 5_000;

let _askCounter = 0;
function nextAskId(): string {
  _askCounter = (_askCounter + 1) >>> 0;
  return `c${Date.now()}-${_askCounter}`;
}

/**
 * Connect to a cluster via one of the listed contact-points and exchange
 * messages with actors on the cluster.  See the file header for scope.
 */
export class ClusterClient {
  private readonly contactPoints: ReadonlyArray<NodeAddress>;
  private readonly identity: NodeAddress;
  private readonly tls: TlsTransportSettings | null;
  private readonly askTimeoutMs: number;
  private readonly log: Logger;
  private socket: TcpSocketLike | null = null;
  private decoder = new FrameDecoder();
  private connectingPromise: Promise<void> | null = null;
  private nextContactIdx = 0;
  private readonly pending = new Map<string, PendingAsk>();
  private stopped = false;
  /** Filled by `hello-ack`; the contact-point's real address (post-handshake). */
  private contactPointPeer: NodeAddress | null = null;

  constructor(private readonly settings: ClusterClientSettings) {
    if (!settings.contactPoints || settings.contactPoints.length === 0) {
      throw new Error('ClusterClient: contactPoints must contain at least one entry');
    }
    const sysName = settings.systemName ?? 'cluster-client';
    this.contactPoints = settings.contactPoints.map((s) => {
      const withSys = s.includes('@') ? s : `${sysName}@${s}`;
      return NodeAddress.parse(withSys);
    });
    const id = settings.clientIdentity ?? {
      host: '127.0.0.1',
      // Synthetic port — must be unique per ClusterClient instance in the
      // same process so the cluster's byPeer map doesn't collide.  Use
      // hrtime-derived randomness within the ephemeral range.
      port: 50_000 + Math.floor(Math.random() * 15_000),
    };
    this.identity = new NodeAddress(sysName, id.host, id.port);
    this.tls = settings.tls ?? null;
    this.askTimeoutMs = settings.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
    this.log = settings.log ?? new ConsoleLogger(LogLevel.Warn, 'cluster-client');
  }

  /** The synthetic identity this client uses in its `hello` handshake. */
  get clientAddress(): NodeAddress { return this.identity; }

  /**
   * Fire-and-forget tell to the actor at `targetPath` on the cluster.
   * `targetPath` accepts the same shapes as `ActorSystem.actorSelection`:
   * full URI, absolute path, or relative-to-`/user`.
   */
  async send(targetPath: string, message: unknown): Promise<void> {
    await this.ensureConnected();
    const env: ClusterClientEnvelopeMsg = {
      t: 'cluster-client-envelope',
      from: this.identity.toJSON(),
      to: targetPath,
      body: message,
    };
    this.writeFrame(env as unknown as WireMessage);
  }

  /**
   * Send a message and wait for a reply.  Resolves with the reply body
   * on success, rejects with an Error on path-not-found / timeout /
   * cluster-side ask failure.
   */
  async ask<R = unknown>(
    targetPath: string,
    message: unknown,
    timeoutMs?: number,
  ): Promise<R> {
    await this.ensureConnected();
    const askId = nextAskId();
    const env: ClusterClientEnvelopeMsg = {
      t: 'cluster-client-envelope',
      from: this.identity.toJSON(),
      to: targetPath,
      askId,
      body: message,
    };
    return new Promise<R>((resolve, reject) => {
      const ms = timeoutMs ?? this.askTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(askId);
        reject(new Error(`ClusterClient.ask timed out after ${ms}ms (path=${targetPath})`));
      }, ms);
      this.pending.set(askId, {
        resolve: (v: unknown) => resolve(v as R),
        reject, timer,
      });
      this.writeFrame(env as unknown as WireMessage);
    });
  }

  /** Close the connection.  Idempotent. */
  async close(): Promise<void> {
    this.stopped = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('ClusterClient closed'));
    }
    this.pending.clear();
    if (this.socket) {
      try { this.socket.end(); } catch { /* ignore */ }
      this.socket = null;
    }
  }

  /* --------------------------- internals ---------------------------- */

  private async ensureConnected(): Promise<void> {
    if (this.stopped) throw new Error('ClusterClient is closed');
    if (this.socket && this.contactPointPeer) return;
    if (this.connectingPromise) return this.connectingPromise;
    this.connectingPromise = this.connect();
    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  private async connect(): Promise<void> {
    const backend = await getTcpBackend();
    const errors: Error[] = [];
    // Try each contact-point in order, advancing the round-robin index
    // so a future reconnect prefers the next one.
    for (let attempt = 0; attempt < this.contactPoints.length; attempt++) {
      const target = this.contactPoints[
        (this.nextContactIdx + attempt) % this.contactPoints.length
      ]!;
      try {
        const sock = await new Promise<TcpSocketLike>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(
            `ClusterClient connect to ${target} timed out after ${HELLO_TIMEOUT_MS}ms`,
          )), HELLO_TIMEOUT_MS);

          let openSock: TcpSocketLike | null = null;
          backend.connect({
            host: target.host,
            port: target.port,
            ...(this.tls ? { tls: this.tls } : {}),
            handlers: {
              onOpen: (s) => {
                openSock = s;
                // Send hello.
                const hello: HelloMsg = { t: 'hello', self: this.identity.toJSON() };
                try { s.write(encodeFrame(hello)); } catch (e) {
                  clearTimeout(timer);
                  reject(e as Error);
                }
              },
              onData: (s, chunk) => {
                this.onData(s, chunk, (peer) => {
                  this.contactPointPeer = peer;
                  this.socket = s;
                  clearTimeout(timer);
                  resolve(s);
                });
              },
              onClose: (_s) => this.onSocketClose(),
              onError: (_s, err) => {
                clearTimeout(timer);
                if (openSock === null) reject(err);
                else this.log.warn(`ClusterClient socket error`, err);
              },
            },
          }).catch((err) => {
            clearTimeout(timer);
            reject(err as Error);
          });
        });
        void sock;
        // Move the round-robin index past the successful contact-point
        // so the next reconnect prefers a different one.
        this.nextContactIdx = (this.nextContactIdx + attempt + 1) % this.contactPoints.length;
        return;
      } catch (e) {
        errors.push(e as Error);
      }
    }
    throw new Error(
      `ClusterClient: failed to connect to any of ${this.contactPoints.length} `
      + `contact-point(s).  Errors: ${errors.map((e) => e.message).join('; ')}`,
    );
  }

  private onData(
    sock: TcpSocketLike,
    chunk: Uint8Array,
    onHelloAck: (peer: NodeAddress) => void,
  ): void {
    const frames = this.decoder.push(chunk);
    for (const frame of frames) {
      if (frame.t === 'hello-ack') {
        const ack = frame as HelloAckMsg;
        onHelloAck(NodeAddress.fromJSON(ack.self));
        continue;
      }
      const t = (frame as { t: string }).t;
      if (t === 'cluster-client-reply') {
        this.handleReply(frame as unknown as ClusterClientReplyMsg);
        continue;
      }
      this.log.debug(`ClusterClient: ignoring unsolicited frame type "${t}"`);
    }
    void sock;
  }

  private handleReply(reply: ClusterClientReplyMsg): void {
    const pending = this.pending.get(reply.askId);
    if (!pending) return;
    this.pending.delete(reply.askId);
    clearTimeout(pending.timer);
    if (reply.ok) {
      pending.resolve(reply.body);
    } else {
      pending.reject(new Error(
        typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body),
      ));
    }
  }

  private onSocketClose(): void {
    this.socket = null;
    this.contactPointPeer = null;
    this.decoder = new FrameDecoder();
    // Pending asks fail — the user can retry, which will reconnect.
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('ClusterClient: connection closed before reply arrived'));
      void id;
    }
    this.pending.clear();
  }

  private writeFrame(msg: WireMessage): void {
    if (!this.socket) {
      throw new Error('ClusterClient: not connected — call send()/ask() which awaits ensureConnected()');
    }
    this.socket.write(encodeFrame(msg));
  }
}

