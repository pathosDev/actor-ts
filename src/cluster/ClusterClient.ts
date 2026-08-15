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
 *
 * The handshake is the **only** place the client states who it is (#121).
 * Envelopes used to repeat that address in a `from` field, which the
 * receptionist stopped reading in #711 and no longer accepts on the type at
 * all — the connection, not the payload, is what a reply is routed on.
 */

import { HELLO_TIMEOUT_MS } from './Constants.js';
import { getTcpBackend, type TcpSocketLike, type TlsTransportOptionsType } from '../runtime/tcp/index.js';
import { ConsoleLogger, LogLevel, type Logger } from '../Logger.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../util/Constants.js';
import { randomUuid } from '../util/RandomString.js';
import { safeStringify } from '../util/SafeStringify.js';
import { NodeAddress } from './NodeAddress.js';
import { encodeFrame, FrameDecoder, type WireMessage, type HelloMessage, type HelloAcknowledgmentMessage } from './Protocol.js';
import { validateWireFrame } from './WireValidation.js';
import type {
  ClusterClientEnvelopeMessage,
  ClusterClientReplyMessage,
} from './ClusterClientReceptionist.js';
import { ClusterClientOptionsValidator } from './ClusterClientOptions.js';
import type { ClusterClientOptions, ClusterClientOptionsType } from './ClusterClientOptions.js';

type PendingAsk = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

/**
 * Generate an unpredictable ask ID.  Used by `ClusterClient.ask()` to
 * route a `cluster-client-reply` frame back to the right pending
 * promise.
 *
 * **Security note (#120)**: previously this was `c${Date.now()}-${counter}`,
 * which an attacker on the wire (MitM on plaintext, malicious cluster
 * peer, or someone with frame-level write access via TLS-stripping
 * proxy) could predict and use to inject a forged reply BEFORE the
 * legitimate one arrives.  {@link randomUuid} gives 122 bits of
 * entropy per call — guessing the next ID is computationally
 * infeasible.  Frame replies whose ID doesn't match a current
 * pending entry are dropped by `handleReply()` (existing behaviour).
 *
 * Takes the map rather than a ready-made predicate (#1146) so that the one
 * thing a call site could get wrong — the polarity, where `true` has to mean
 * *taken* — is written once here and covered by a test, instead of being
 * re-derived at the `ask()` that calls it.  `pending` is optional only so the
 * test handle below can still ask for a bare draw.
 */
function nextAskId(pending?: ReadonlyMap<string, unknown>): string {
  return randomUuid(pending === undefined ? undefined : (id) => pending.has(id));
}

/** @internal — test-only handle for the predictability regression. */
export const _nextAskIdForTest = nextAskId;

/**
 * The synthetic port a client without an explicit `clientIdentity` addresses
 * itself by.  It has to be unique per `ClusterClient` in a process so the
 * cluster's `byPeer` map does not collide — but it is also the client's
 * **wire identity**: it goes into the `NodeAddress` the client announces, and
 * a peer that can predict it can address, impersonate or pre-claim that
 * client's slot.  Same reasoning that moved `ask`'s reply refs and the
 * anonymous-actor names off counters and `Math.random()`.
 *
 * Drawn from the CSPRNG rather than `Math.random()`, whose output is
 * predictable from a handful of observed values, and spread across the whole
 * ephemeral range rather than 15 000 slots — at a few dozen clients per
 * process the narrower range made an accidental collision likely enough to
 * matter on its own.
 */
function syntheticClientPort(): number {
  const EPHEMERAL_FIRST = 49_152;                    // IANA dynamic/private range
  const EPHEMERAL_COUNT = 65_535 - EPHEMERAL_FIRST + 1;
  const draw = new Uint16Array(1);
  globalThis.crypto.getRandomValues(draw);
  return EPHEMERAL_FIRST + (draw[0]! % EPHEMERAL_COUNT);
}

/** @internal — test-only handle for the predictability regression. */
export const _syntheticClientPortForTest = syntheticClientPort;

/**
 * Connect to a cluster via one of the listed contact-points and exchange
 * messages with actors on the cluster.  See the file header for scope.
 */
export class ClusterClient {
  private readonly contactPoints: ReadonlyArray<NodeAddress>;
  private readonly identity: NodeAddress;
  private readonly tls: TlsTransportOptionsType | null;
  private readonly askTimeoutMs: number;
  private readonly log: Logger;
  private socket: TcpSocketLike | null = null;
  private decoder = new FrameDecoder();
  private connectingPromise: Promise<void> | null = null;
  private nextContactIndex = 0;
  private readonly pending = new Map<string, PendingAsk>();
  private stopped = false;
  /** Filled by `hello-ack`; the contact-point's real address (post-handshake). */
  private contactPointPeer: NodeAddress | null = null;

  private readonly options: ClusterClientOptionsType;

  constructor(options: ClusterClientOptions) {
    const resolvedOptions = options as ClusterClientOptionsType;
    this.options = resolvedOptions;
    new ClusterClientOptionsValidator().validate(resolvedOptions);
    const sysName = resolvedOptions.systemName ?? 'cluster-client';
    this.contactPoints = resolvedOptions.contactPoints.map((s) => {
      const withSys = s.includes('@') ? s : `${sysName}@${s}`;
      return NodeAddress.parse(withSys);
    });
    const id = resolvedOptions.clientIdentity ?? {
      host: '127.0.0.1',
      port: syntheticClientPort(),
    };
    this.identity = new NodeAddress(sysName, id.host, id.port);
    this.tls = resolvedOptions.tls ?? null;
    this.askTimeoutMs = resolvedOptions.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
    this.log = resolvedOptions.logger ?? new ConsoleLogger(LogLevel.Warn, 'cluster-client');
  }

  /** The synthetic identity this client uses in its `hello` handshake. */
  get clientAddress(): NodeAddress { return this.identity; }

  /**
   * Fire-and-forget tell to the actor at `targetPath` on the cluster.
   * `targetPath` accepts the same shapes as `ActorSystem.actorSelection`:
   * full URI, absolute path, or relative-to-`/user`.  A path starting with
   * `system/` addresses a framework actor — e.g.
   * `'system/cluster/receptionist'`.
   */
  async send(targetPath: string, message: unknown): Promise<void> {
    await this.ensureConnected();
    const env: ClusterClientEnvelopeMessage = {
      kind: 'cluster-client-envelope',
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
    // Drawn against the map it is about to key (#1146).  `pending.set` below
    // overwrites, so a repeat would not raise anything — it would replace the
    // earlier ask's `resolve`/`reject` with this one's, leaving that promise to
    // hang until its own timer fires with a timeout that never happened.  122
    // bits make it near-impossible; the map is right here, so it is now also
    // ruled out.
    const askId = nextAskId(this.pending);
    const env: ClusterClientEnvelopeMessage = {
      kind: 'cluster-client-envelope',
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
        (this.nextContactIndex + attempt) % this.contactPoints.length
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
                const hello: HelloMessage = { kind: 'hello', self: this.identity.toJSON() };
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
        this.nextContactIndex = (this.nextContactIndex + attempt + 1) % this.contactPoints.length;
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
    onHelloAcknowledgment: (peer: NodeAddress) => void,
  ): void {
    // The client trusts its contact points no more than a node trusts a peer.
    // `push` throws on an oversized length-prefix or malformed JSON, and this
    // runs inside the runtime's socket-data callback — so an unguarded call
    // meant one bad frame from one contact point killed the client process
    // (#587).  The transport-side equivalent has been guarded since #563.
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (e) {
      this.log.warn(
        `ClusterClient: frame-decoder error from a contact point; dropping the connection: `
        + `${e instanceof Error ? e.message : String(e)}`,
      );
      try { sock.end(); } catch { /* already gone */ }
      return;
    }
    for (const frame of frames) {
      const checked = validateWireFrame(frame);
      if ('problem' in checked) {
        this.log.warn(`ClusterClient: ignoring malformed frame — ${checked.problem}`);
        continue;
      }
      if (checked.message.kind === 'hello-ack') {
        const ack = checked.message as HelloAcknowledgmentMessage;
        onHelloAcknowledgment(NodeAddress.fromJSON(ack.self));
        continue;
      }
      // Widened on purpose: `WireMessage` enumerates only the core kinds, and
      // `cluster-client-reply` is one of the extension kinds that ride the same
      // wire (see the note in WireValidation.ts).
      const frameType = (checked.message as { kind: string }).kind;
      if (frameType === 'cluster-client-reply') {
        // Contained on purpose.  `push` returns a *batch* of frames, so a throw
        // from one reply used to abandon the rest of the batch — every later
        // frame in the same chunk was dropped, and the asks they would have
        // settled were left to time out instead.  One malformed reply must not
        // take the others with it.
        try {
          this.handleReply(checked.message as unknown as ClusterClientReplyMessage);
        } catch (e) {
          this.log.warn(`ClusterClient: failed to handle a reply frame: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }
      this.log.debug(`ClusterClient: ignoring unsolicited frame type "${frameType}"`);
    }
  }

  private handleReply(reply: ClusterClientReplyMessage): void {
    const pending = this.pending.get(reply.askId);
    if (!pending) return;
    this.pending.delete(reply.askId);
    clearTimeout(pending.timer);
    if (reply.ok) {
      pending.resolve(reply.body);
    } else {
      // `safeStringify` rather than `JSON.stringify`: this builds the message
      // for an error that already happened, and a throw from here would
      // replace it with an unrelated one raised inside the reporting code.
      // Wire bodies arrive as parsed JSON today, so they cannot be circular —
      // but this is the one place the framework re-stringifies data it
      // received rather than data it authored, and the guarantee should not
      // depend on the frame codec staying JSON-only.
      pending.reject(new Error(
        typeof reply.body === 'string' ? reply.body : safeStringify(reply.body),
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

  private writeFrame(message: WireMessage): void {
    if (!this.socket) {
      throw new Error('ClusterClient: not connected — call send()/ask() which awaits ensureConnected()');
    }
    this.socket.write(encodeFrame(message));
  }
}

