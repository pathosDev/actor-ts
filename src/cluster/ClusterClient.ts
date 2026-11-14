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

import { CLUSTER_WIRE_VERSION, MIN_CLUSTER_WIRE_VERSION, wireVersionRefusal } from './WireVersion.js';
import { getTcpBackend, type TcpBackend, type TcpSocketLike, type TlsTransportOptionsType } from '../runtime/tcp/index.js';
import type { Config } from '../config/Config.js';
import { ConsoleLogger, LogLevel, type Logger } from '../Logger.js';
import { armChainedTimeout, type Cancellable, type HostTimers } from '../Scheduler.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../util/Constants.js';
import { OptionsError } from '../util/OptionsValidator.js';
import { randomUuid } from '../util/RandomString.js';
import { safeStringify } from '../util/SafeStringify.js';
import { NodeAddress } from './NodeAddress.js';
import { encodeFrame, FrameDecoder, type WireMessage, type HelloMessage, type HelloAcknowledgmentMessage, type HelloRefusedMessage } from './Protocol.js';
import { validateWireFrame } from './WireValidation.js';
import type {
  ClusterClientEnvelopeMessage,
  ClusterClientReplyMessage,
} from './ClusterClientReceptionist.js';
import {
  ClusterClientOptionsValidator,
  DEFAULT_CLUSTER_CLIENT_CONNECT_TIMEOUT_MS,
  DEFAULT_CLUSTER_CLIENT_SYSTEM_NAME,
  withClusterClientConfigDefaults,
} from './ClusterClientOptions.js';
import type { ClusterClientOptions, ClusterClientOptionsType } from './ClusterClientOptions.js';

type PendingAsk = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  /** The ask's deadline; cancelled by whatever settles the ask first. */
  readonly timer: Cancellable;
};

/**
 * One dial of one contact point, from `backend.connect` to the end of the
 * connection it produced — or to the moment it was given up (#1751).
 *
 * An attempt used to be a bare promise, and nothing ended it: when its
 * deadline fired the loop moved on to the next contact point, but the dial
 * went on connecting, an open socket stayed open and its handlers stayed
 * installed.  A `hello-ack` arriving later still made that socket the
 * client's connection, and its `close` tore down whichever connection the
 * client really had.  Everything an attempt started is reachable from here,
 * so the one place it ends ({@link fail}) can end all of it, and every
 * handler checks {@link ended} before it acts.
 */
type ContactPointConnection = {
  readonly target: NodeAddress;
  /**
   * Gives the dial up — handed to `backend.connect` as its `signal`, so a dial
   * still connecting is destroyed rather than left to the operating system.
   */
  readonly dial: AbortController;
  /**
   * This socket's decoder: `FrameDecoder` holds the partial frame, and bytes
   * from two sockets fed through one interleave into garbage (#1751).
   */
  readonly decoder: FrameDecoder;
  /** Set by `onOpen`. */
  socket: TcpSocketLike | null;
  /** Filled by the `hello-ack` that made this the client's connection. */
  peer: NodeAddress | null;
  /**
   * Set once the attempt has failed or been given up, and never cleared.
   * Nothing that happens on an ended attempt changes the client.
   */
  ended: boolean;
  /** End the attempt and reject its promise; a no-op once it has settled. */
  fail: (error: Error) => void;
  /** Make this the client's connection and resolve; a no-op once it has settled. */
  establish: (peer: NodeAddress) => void;
};

/**
 * Close a socket nobody will read from again.  `destroy` where the runtime has
 * it: `end()` only half-closes, and the peer decides when the rest goes.
 */
function abandonSocket(socket: TcpSocketLike): void {
  try {
    if (socket.destroy !== undefined) socket.destroy();
    else socket.end();
  } catch { /* already gone */ }
}

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
 * Refuse a per-call ask deadline that is not a positive finite number (#1763),
 * in the shape `ActorRef.ask` refuses one.
 *
 * The configured `ask-timeout` has been held to that rule by the options
 * validator all along; the per-call argument went straight to the deadline.
 * `0`, a negative value and `NaN` timed the ask out on the next tick under a
 * message quoting the nonsense value, and `Infinity` armed a chain that never
 * runs out — an ask that stayed in the pending map until a reply, `close()` or
 * a dropped connection.  Written out rather than run through a validator: one
 * comparison on a per-call path, and `Number.isFinite` does not coerce, so a
 * non-number from untyped JavaScript is refused too.
 */
function assertAskTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new OptionsError(
      'ClusterClient.ask: timeoutMs must be a positive finite number'
      + ` (got ${OptionsError.renderValue(timeoutMs)})`
      + ' — an ask that arms no deadline can never settle',
      'ClusterClient.ask',
      'timeoutMs',
      timeoutMs,
    );
  }
}

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
  private readonly connectTimeoutMs: number;
  private readonly log: Logger;
  /** The connection a `hello-ack` completed; `null` until then and after it closes. */
  private connection: ContactPointConnection | null = null;
  /** The attempt in flight, so `close()` can end it. */
  private dialing: ContactPointConnection | null = null;
  private connectingPromise: Promise<void> | null = null;
  private nextContactIndex = 0;
  private readonly pending = new Map<string, PendingAsk>();
  private stopped = false;
  /** @internal The runtime's backend unless a test installs its own. */
  private backend: TcpBackend | null = null;
  /** @internal What the deadlines are armed over: the runtime's timers unless a test substitutes virtual ones. */
  private hostTimers: HostTimers | undefined = undefined;

  private readonly options: ClusterClientOptionsType;

  /**
   * @param options  Explicit options — the highest-precedence layer.
   * @param config   The configuration `actor-ts.cluster.client` is read from.
   *   Defaults to {@link Config.load}, the same chain `ActorSystem.create`
   *   uses: a `ClusterClient` holds no `ActorSystem`, so unlike every other
   *   config consumer in the framework there is no `system.config` above it,
   *   and without a self-load `new ClusterClient({})` could not be configured
   *   at all.  `readWorkerClusterOptionsFromConfig` makes the same call for
   *   the same reason.
   *
   *   Pass one explicitly to make a client independent of whatever
   *   `application.conf` sits in the working directory — which is what the
   *   unit tests do, so a stray file cannot decide whether they pass.
   */
  constructor(options: ClusterClientOptions, config?: Config) {
    const resolvedOptions = withClusterClientConfigDefaults(
      options as Partial<ClusterClientOptionsType>,
      config,
    );
    this.options = resolvedOptions;
    new ClusterClientOptionsValidator().validate(resolvedOptions);
    const sysName = resolvedOptions.systemName ?? DEFAULT_CLUSTER_CLIENT_SYSTEM_NAME;
    this.contactPoints = resolvedOptions.contactPoints.map((s) => {
      const withSys = s.includes('@') ? s : `${sysName}@${s}`;
      return NodeAddress.parse(withSys);
    });
    const id = resolvedOptions.clientIdentity ?? {
      host: '127.0.0.1',
      port: syntheticClientPort(),
    };
    // A run of its own, as every node on cluster wire v2 names one (#823).
    this.identity = new NodeAddress(sysName, id.host, id.port, NodeAddress.mintIncarnation());
    this.tls = resolvedOptions.tls ?? null;
    this.askTimeoutMs = resolvedOptions.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
    this.connectTimeoutMs =
      resolvedOptions.connectTimeoutMs ?? DEFAULT_CLUSTER_CLIENT_CONNECT_TIMEOUT_MS;
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
   *
   * A deadline of any length is waited out in full, one past the host timer
   * ceiling (~24.9 days) included — see {@link armChainedTimeout}.  An
   * omitted `timeoutMs` means the configured `ask-timeout`; `0`, a negative
   * value, `NaN` and `Infinity` are refused with an {@link OptionsError}
   * before anything is dialled or sent (#1763).
   */
  async ask<R = unknown>(
    targetPath: string,
    message: unknown,
    timeoutMs?: number,
  ): Promise<R> {
    if (timeoutMs !== undefined) assertAskTimeout(timeoutMs);
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
      // Chained rather than one `setTimeout`: a host timer fires a delay past
      // its ceiling (~24.9 days) at once — after 1 ms on Bun and Node — and
      // `ask-timeout` is refused only when it is not positive, so a 30-day
      // deadline used to reject the ask almost as soon as it was sent.  The
      // chain arms one host timer for anything shorter, so the common case
      // keeps the timer it had; a network round trip dwarfs the one object
      // more it allocates.
      const timer = armChainedTimeout(() => {
        this.pending.delete(askId);
        reject(new Error(`ClusterClient.ask timed out after ${ms}ms (path=${targetPath})`));
      }, ms, this.hostTimers);
      this.pending.set(askId, {
        resolve: (v: unknown) => resolve(v as R),
        reject, timer,
      });
      this.writeFrame(env as unknown as WireMessage);
    });
  }

  /**
   * Close the client.  Idempotent.  Rejects every ask still waiting, ends a
   * connect attempt still in flight — rejecting every call parked on it,
   * which used to stay parked for good (#938) — and closes the connection.
   */
  async close(): Promise<void> {
    this.stopped = true;
    for (const [, p] of this.pending) {
      p.timer.cancel();
      p.reject(new Error('ClusterClient closed'));
    }
    this.pending.clear();
    this.dialing?.fail(new Error('ClusterClient closed'));
    const connection = this.connection;
    if (connection !== null) {
      // Cleared first, so the `close` this provokes is one for a connection the
      // client no longer has.
      this.connection = null;
      if (connection.socket !== null) {
        try { connection.socket.end(); } catch { /* ignore */ }
      }
    }
  }

  /* --------------------------- internals ---------------------------- */

  /**
   * Connect, or join the connect already in flight.
   *
   * The memoised promise is cleared by a continuation attached the moment it
   * is created, so it is gone by the time any caller resumes from it, however
   * it settled and whichever caller started it.  Clearing it is only as good
   * as the promise settling: one that never did stayed memoised and was handed
   * to every later `send` and `ask` (#938).  What guarantees the settling is
   * {@link dialContactPoint}, whose attempts all end through one deadline that
   * nothing cancels without settling them.
   */
  private async ensureConnected(): Promise<void> {
    if (this.stopped) throw new Error('ClusterClient is closed');
    if (this.connection !== null) return;
    if (this.connectingPromise === null) {
      const connecting = this.connect();
      const forget = (): void => {
        if (this.connectingPromise === connecting) this.connectingPromise = null;
      };
      connecting.then(forget, forget);
      this.connectingPromise = connecting;
    }
    return this.connectingPromise;
  }

  private async connect(): Promise<void> {
    const backend = this.backend ?? await getTcpBackend();
    const errors: Error[] = [];
    // Try each contact-point in order, advancing the round-robin index
    // so a future reconnect prefers the next one.
    for (let attempt = 0; attempt < this.contactPoints.length; attempt++) {
      // `close()` ends the attempt in flight; it must not start the next one.
      if (this.stopped) throw new Error('ClusterClient closed');
      const target = this.contactPoints[
        (this.nextContactIndex + attempt) % this.contactPoints.length
      ]!;
      try {
        await this.dialContactPoint(backend, target);
        // Move the round-robin index past the successful contact-point
        // so the next reconnect prefers a different one.
        this.nextContactIndex = (this.nextContactIndex + attempt + 1) % this.contactPoints.length;
        return;
      } catch (e) {
        errors.push(e as Error);
      }
    }
    if (this.stopped) throw new Error('ClusterClient closed');
    throw new Error(
      `ClusterClient: failed to connect to any of ${this.contactPoints.length} `
      + `contact-point(s).  Errors: ${errors.map((e) => e.message).join('; ')}`,
    );
  }

  /**
   * One attempt on one contact point.  Settles exactly once: resolved by the
   * `hello-ack`, rejected by the deadline, a refused dial, a failed write, an
   * error or a close before the `hello-ack`, or `close()` — and every one of
   * the rejections goes through {@link ContactPointConnection.fail}, which
   * ends everything the attempt started.
   *
   * Two defects lived in the shape this replaced.  An error after the socket
   * had opened cancelled the deadline without settling the attempt, and a
   * close never settled it at all, so a contact point that reset before its
   * `hello-ack` left a promise with no way to finish (#938).  And a deadline
   * that fired rejected the promise and left the dial, the socket and the
   * handlers running, so a contact point that answered late took the client's
   * connection over (#1751).
   */
  private dialContactPoint(backend: TcpBackend, target: NodeAddress): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const connection: ContactPointConnection = {
        target,
        dial: new AbortController(),
        decoder: new FrameDecoder(),
        socket: null,
        peer: null,
        ended: false,
        fail: (error) => {
          if (connection.ended || connection.peer !== null) return;
          connection.ended = true;
          deadline.cancel();
          if (this.dialing === connection) this.dialing = null;
          // A dial still connecting is destroyed by the backend; an open
          // socket is the attempt's to close, since aborting a dial that has
          // resolved changes nothing.
          connection.dial.abort(error);
          if (connection.socket !== null) abandonSocket(connection.socket);
          reject(error);
        },
        establish: (peer) => {
          if (connection.ended || connection.peer !== null) return;
          connection.peer = peer;
          deadline.cancel();
          if (this.dialing === connection) this.dialing = null;
          this.connection = connection;
          resolve();
        },
      };
      this.dialing = connection;
      // Chained for the reason `ask` gives: `connect-timeout` is refused only
      // when it is not positive, and one host timer would give up on a contact
      // point a millisecond into a 30-day wait.  It covers the `hello-ack` as
      // well as the dial, so a peer that accepts and then goes quiet is given
      // up on too.
      const deadline = armChainedTimeout(() => connection.fail(new Error(
        `ClusterClient connect to ${target} timed out after ${this.connectTimeoutMs}ms`,
      )), this.connectTimeoutMs, this.hostTimers);

      backend.connect({
        host: target.host,
        port: target.port,
        ...(this.tls ? { tls: this.tls } : {}),
        signal: connection.dial.signal,
        handlers: {
          onOpen: (s) => this.onConnectionOpen(connection, s),
          onData: (s, chunk) => this.onData(connection, s, chunk),
          onClose: () => this.onConnectionClose(connection),
          onError: (_s, err) => this.onConnectionError(connection, err),
        },
      }).then(
        (s) => {
          // A backend that cannot honour the abort — Deno over TLS, a backend
          // of the caller's own — resolves a dial that was given up.
          if (connection.ended) abandonSocket(s);
          else connection.socket ??= s;
        },
        (err: unknown) => connection.fail(err instanceof Error ? err : new Error(String(err))),
      );
    });
  }

  private onConnectionOpen(connection: ContactPointConnection, socket: TcpSocketLike): void {
    if (connection.ended) {
      abandonSocket(socket);
      return;
    }
    connection.socket = socket;
    const hello: HelloMessage = {
      kind: 'hello',
      self: this.identity.toJSON(),
      wireVersion: CLUSTER_WIRE_VERSION,
      minWireVersion: MIN_CLUSTER_WIRE_VERSION,
    };
    try {
      socket.write(encodeFrame(hello));
    } catch (e) {
      connection.fail(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /**
   * Before the `hello-ack` a close fails the attempt at once rather than
   * leaving it to the deadline (#938); after it, it is the end of the client's
   * connection — but only if it still *is* the client's connection.  The close
   * of a socket the client gave up on, or replaced, used to tear down the
   * connection it actually had, failing every ask in flight there (#1751).
   */
  private onConnectionClose(connection: ContactPointConnection): void {
    if (connection.peer === null) {
      connection.fail(new Error(
        `ClusterClient: contact point ${connection.target} closed the connection before its hello-ack`,
      ));
      return;
    }
    if (this.connection === connection) this.onSocketClose();
  }

  /**
   * Before the `hello-ack` an error fails the attempt, whether or not the socket
   * had opened: the branch that only logged it also cancelled the deadline,
   * which left the attempt nothing that could ever settle it (#938).
   */
  private onConnectionError(connection: ContactPointConnection, error: Error): void {
    if (connection.peer === null) {
      connection.fail(error);
      return;
    }
    if (this.connection === connection) this.log.warn(`ClusterClient socket error`, error);
  }

  /**
   * Bytes on one attempt's socket, decoded by that socket's own decoder.  An
   * attempt that has ended takes nothing: a `hello-ack` that arrives after the
   * client gave up on its contact point used to make that socket the client's
   * connection (#1751).
   */
  private onData(connection: ContactPointConnection, sock: TcpSocketLike, chunk: Uint8Array): void {
    if (connection.ended) return;
    // The client trusts its contact points no more than a node trusts a peer.
    // `push` throws on an oversized length-prefix or malformed JSON, and this
    // runs inside the runtime's socket-data callback — so an unguarded call
    // meant one bad frame from one contact point killed the client process
    // (#587).  The transport-side equivalent has been guarded since #563.
    let frames;
    try {
      frames = connection.decoder.push(chunk);
    } catch (e) {
      this.log.warn(
        `ClusterClient: frame-decoder error from a contact point; dropping the connection: `
        + `${e instanceof Error ? e.message : String(e)}`,
      );
      if (connection.peer === null) connection.fail(e instanceof Error ? e : new Error(String(e)));
      else try { sock.end(); } catch { /* already gone */ }
      return;
    }
    for (const frame of frames) {
      const checked = validateWireFrame(frame);
      if ('problem' in checked) {
        this.log.warn(`ClusterClient: ignoring malformed frame — ${checked.problem}`);
        continue;
      }
      if (checked.message.kind === 'hello-refused') {
        const refused = checked.message as HelloRefusedMessage;
        this.log.warn(
          `ClusterClient: contact point ${NodeAddress.fromJSON(refused.self)} refused the handshake `
          + `(it speaks cluster wire v${refused.minWireVersion}..v${refused.wireVersion}): ${refused.reason}`,
        );
        continue;
      }
      if (checked.message.kind === 'hello-ack') {
        const ack = checked.message as HelloAcknowledgmentMessage;
        const refusal = wireVersionRefusal({ wireVersion: ack.wireVersion }, ack.self);
        if (refusal !== null) {
          this.log.warn(`ClusterClient: handshake with ${NodeAddress.fromJSON(ack.self)} refused: ${refusal}`);
          continue;
        }
        connection.establish(NodeAddress.fromJSON(ack.self));
        continue;
      }
      // Widened on purpose: `WireMessage` enumerates only the core kinds, and
      // `cluster-client-reply` is one of the extension kinds that ride the same
      // wire (see the note in WireValidation.ts).
      const frameType = (checked.message as { kind: string }).kind;
      if (frameType === 'cluster-client-reply' && this.connection === connection) {
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
    pending.timer.cancel();
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
    this.connection = null;
    // Pending asks fail — the user can retry, which will reconnect.
    for (const [id, p] of this.pending) {
      p.timer.cancel();
      p.reject(new Error('ClusterClient: connection closed before reply arrived'));
      void id;
    }
    this.pending.clear();
  }

  private writeFrame(message: WireMessage): void {
    const socket = this.connection?.socket ?? null;
    if (socket === null) {
      throw new Error('ClusterClient: not connected — call send()/ask() which awaits ensureConnected()');
    }
    socket.write(encodeFrame(message));
  }
}

