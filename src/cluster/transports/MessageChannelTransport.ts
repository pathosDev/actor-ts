import type { Clock } from '../../Clock.js';
import { systemClock } from '../../Clock.js';
import { ConsoleLogger, LogLevel, type Logger } from '../../Logger.js';
import { DEFAULT_DROP_REPORT_INTERVAL_MS } from '../../util/Constants.js';
import { MAX_KNOWN_CHANNEL_PEERS } from '../Constants.js';
import { NodeAddress, type NodeAddressData } from '../NodeAddress.js';
import type { WireMessage } from '../Protocol.js';
import type { Transport, WireHandler } from '../Transport.js';
import { isNodeAddressData, sanitizeWireKindForLog, validateWireFrame } from '../WireValidation.js';

/**
 * Message shape carried over the underlying MessageChannel.  The broker
 * pattern means every outbound frame from a worker includes the sender
 * address (so the receiver can put it in `WireHandler`) and the intended
 * recipient (so the broker can route it).
 */
export type BrokeredMessage = {
  readonly from: ReturnType<NodeAddress['toJSON']>;
  readonly to: ReturnType<NodeAddress['toJSON']>;
  readonly payload: WireMessage;
};

/**
 * The floor a brokered envelope must clear before anything reads it.
 *
 * Only the two address fields are checked: `to` is what a broker dereferences
 * to route the frame, and `from` is what the receiving
 * {@link MessageChannelTransport} dereferences the moment the frame is
 * re-posted.  The `payload` is not validated here: `onFrame` runs
 * `validateWireFrame` over it one step later (#945), and doing it in both
 * places would mean two guards to keep in step.
 *
 * It lives beside {@link BrokeredMessage} rather than inside a broker because
 * there are two brokers — `WorkerBroker` in production and the testkit's
 * `MultiNodeBroker` — and a guard copied into both is a guard that drifts.  That
 * is not hypothetical: the testkit fork kept the unguarded shape right through
 * #701's first fix, and nothing noticed because until then no suite named it.
 * `src/worker/` is not an option for the shared home the way `withChannelSource`
 * is: the third caller is {@link MessageChannelTransport.onFrame} itself, and
 * `src/cluster/` importing from `src/worker/` would invert the layering both
 * brokers already depend on.
 */
export function isBrokeredMessage(value: unknown): value is BrokeredMessage {
  if (typeof value !== 'object' || value === null) return false;
  const { to, from } = value as Partial<BrokeredMessage>;
  return isNodeAddressData(to) && isNodeAddressData(from);
}

/**
 * Why this transport refused a frame (#1515).
 *
 * - `malformed-envelope` — the posted value failed {@link isBrokeredMessage},
 *   or its `from` answered `NodeAddress.fromJSON` differently than it answered
 *   the guard.  Nothing past the two address fields was read.
 * - `malformed-frame` — the envelope was fine and the `payload` was not: the
 *   same `validateWireFrame` the socket transports run, refusing the same
 *   corpus.  The reason it gives rides on the line, which is what separates a
 *   version skew from a hostile peer.
 * - `handler-threw` — the frame was delivered and the handler threw.  The
 *   frame is lost and the port stays open; there is no socket to close.
 *
 * A union of string literals rather than an enum, the shape
 * `WorkerBrokerDropReason` already has one hop away, so a member can be added
 * without touching the tally at every read site.  Shutdown is deliberately not
 * a reason: `shutdown()` nulls `onmessage`, so a frame arriving after it is a
 * race the transport absorbs, not a refusal it reports.
 */
export type MessageChannelDropReason = 'malformed-envelope' | 'malformed-frame' | 'handler-threw';

/**
 * MessagePort-like minimal surface — we only use these three members so
 * the transport works equally well with browser `MessagePort`,
 * Node/Bun `worker_threads.MessagePort`, or any in-process shim used by
 * tests.
 */
export interface PortLike {
  postMessage(value: unknown, transfer?: unknown[]): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  close?(): void;
  start?(): void;
}

/**
 * Transport that talks to the rest of the cluster through a single pair of
 * `MessagePort`s — this node holds one end; a broker (typically the
 * main-thread `WorkerCluster`) holds the other end of every worker and
 * forwards traffic based on the envelope's `to` address.  Use this to
 * build a multi-core cluster inside one process without paying the TCP
 * overhead.
 *
 * What it will not deliver it **drops, counts and reports**: each refusal
 * bumps a per-reason tally ({@link MessageChannelTransport.dropped}) and
 * reaches the logger as one folded `WARN` per reason per
 * {@link DEFAULT_DROP_REPORT_INTERVAL_MS}.  That is the half `TcpTransport`
 * always had and this class never did, and the asymmetry was the whole of the
 * defect: a version-skewed or shape-drifted worker had its frames black-holed
 * on the multi-core path with no operator-visible signal at all, where a peer
 * on a socket got a `WARN` naming it and the offending field (#1515).
 */
export class MessageChannelTransport implements Transport {
  readonly self: NodeAddress;
  private readonly port: PortLike;
  private handler: WireHandler = () => {};
  private running = false;
  private readonly log: Logger;
  private readonly clock: Clock;
  /** Cumulative drops per reason, for this transport's lifetime — what {@link dropped} snapshots. */
  private readonly dropCounts: Record<MessageChannelDropReason, number> =
    { 'malformed-envelope': 0, 'malformed-frame': 0, 'handler-threw': 0 };
  /** Drops counted per reason since that reason last reached the log. */
  private readonly suppressed: Record<MessageChannelDropReason, number> =
    { 'malformed-envelope': 0, 'malformed-frame': 0, 'handler-threw': 0 };
  /**
   * When each reason last reached the log.  `-Infinity` rather than `0` so the
   * first drop of a reason reports whatever the clock reads — an injected test
   * clock may well start at zero.
   */
  private readonly lastReportedAt: Record<MessageChannelDropReason, number> =
    { 'malformed-envelope': -Infinity, 'malformed-frame': -Infinity, 'handler-threw': -Infinity };
  /**
   * The senders {@link peers} reports, keyed on the string form because that is
   * what identity is here — and holding the {@link NodeAddress} itself because
   * that is what {@link peers} owes its caller.
   *
   * A `Set<string>` re-parsed in `peers()`, which is what this was, made the
   * round trip through `toString`/`parse` part of the transport's contract, and
   * that round trip is lossy for anything `parse` reads differently from what
   * `toString` wrote (#1515).  `NodeAddress.isPort` closes the wire side of
   * that; keeping the recorded object closes the parse side, and it is what
   * `TcpTransport.byPeer` already does.
   */
  private readonly knownPeers = new Map<string, NodeAddress>();

  /**
   * `self` and `port` keep their places — every construction site has an
   * opinion about both and neither has a default to fall through to.  `log`
   * follows them positionally rather than arriving in an options object,
   * the `TcpTransport(self, log, options)` precedent: it is this class's one
   * knob, and the triad comes with the second.
   *
   * The default is a `ConsoleLogger` at `Info` and not a `NoopLogger`, for the
   * reason `WorkerBroker`'s constructor gives: a transport built without one
   * must not be silent, because silence is the defect.  It matters most on the
   * path with no logger to hand — two of these wired port-to-port, which is
   * what `worker-mesh.mdx` documents for manual wiring, and the one shape that
   * has no broker in front of it to report instead.  `WorkerMesh` passes
   * `system.log`, so in a mesh every drop reaches the sinks that system
   * configures; `WorkerNode` cannot, and the JSDoc there says why.
   *
   * `clock` exists so the fold can be exercised without a thirty-second wait.
   */
  constructor(
    self: NodeAddress,
    port: PortLike,
    log: Logger = new ConsoleLogger(LogLevel.Info),
    clock: Clock = systemClock,
  ) {
    this.self = self;
    this.port = port;
    this.log = log;
    this.clock = clock;
  }

  setHandler(handler: WireHandler): void { this.handler = handler; }

  async start(): Promise<void> {
    this.running = true;
    this.port.onmessage = (evt) => this.onFrame(evt.data);
    this.port.start?.();
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.port.onmessage = null;
    try { this.port.close?.(); } catch { /* ignore */ }
  }

  send(to: NodeAddress, message: WireMessage): void {
    if (!this.running) return;
    const envelope: BrokeredMessage = {
      from: this.self.toJSON(),
      to: to.toJSON(),
      payload: message,
    };
    this.port.postMessage(envelope);
  }

  disconnect(_peer: NodeAddress): void {
    // In the broker model we don't own per-peer connections.  Nothing to do.
  }

  peers(): NodeAddress[] {
    return Array.from(this.knownPeers.values());
  }

  /**
   * How many frames this transport has refused, per reason, since it was
   * built — a diagnostic snapshot like {@link peers}, and the number the
   * folded log line is a sample of.
   *
   * A copy, so a caller cannot reset the tally by writing to it.  It is the
   * half that does not rate-limit: the log is throttled because a peer can
   * post at will, and the counter is what an operator reads when the throttle
   * has hidden the volume.
   */
  dropped(): Readonly<Record<MessageChannelDropReason, number>> {
    return { ...this.dropCounts };
  }

  /* -------------------------------- Internal ------------------------------- */

  /**
   * The inbound edge, and the reason it is the same three steps `TcpTransport`
   * and `InMemoryTransport` take: the guarantee belongs to the {@link Transport}
   * contract, not to one implementation of it, and this was the implementation
   * that had none of it (#945).
   *
   * `env` is `unknown` rather than {@link BrokeredMessage} for the reason
   * `WorkerBroker.onMessage` states one hop away — it is whatever somebody
   * posted on the port, and the cast this signature used to carry was the
   * defect itself.  A `MessagePort`'s `onmessage` callback has no caller to
   * unwind into on any runtime this framework targets, so an escaping throw is
   * an uncaught top-level error: the host thread, the main-thread actor system
   * and every sibling worker die with it.  That is the whole of the exploit,
   * and it costs one `postMessage`.
   *
   * Three steps, each closing a different route out:
   *
   * 1. {@link isBrokeredMessage} — the envelope's own shape, which is what
   *    `NodeAddress.fromJSON` throws on.  It is the same guard both brokers
   *    spend (#701), and running it here is what makes the transport safe when
   *    there is no broker in between: two of these can be wired port-to-port,
   *    which is exactly how the manual mesh in `worker-mesh.mdx` does it.  Once
   *    it passes, `fromJSON` agrees with it on every *value* — both spend
   *    `NodeAddress.isPort` and `NodeAddress.isIncarnation`, which is where the
   *    two field rules with any substance to them live, so there is one rule
   *    rather than two that agree.  They *were* two: the port half was written
   *    out on both sides and drifted from what `toString` can carry, which is
   *    what #1515 closed.
   *
   *    Agreeing on every value is still not "cannot throw", which is what this
   *    read used to claim, and the gap is that the guard and `fromJSON` are two
   *    *reads* of the same field.  A `from` whose `port` is an accessor
   *    answering `2552` to the first and `1e21` to the second passes the guard
   *    and throws out of `fromJSON` — outside the `try` below, which only ever
   *    wrapped the handler, so straight out of the `onmessage` callback.  A
   *    real `MessagePort` structured-clones the envelope and strips accessors,
   *    but this class takes any {@link PortLike} and is exported package
   *    surface; the testkit's broker and every port-to-port wiring pass the
   *    object itself.  So `fromJSON` gets a `try` of its own, and the refusal
   *    is the same one step 1 would have made.  Keeping it separate from the
   *    handler's `try` is deliberate: a refused envelope and a handler nobody
   *    understands are different failures, and one `catch` over both would say
   *    so nowhere.
   * 2. {@link validateWireFrame} — the payload, which is what every handler
   *    below `Cluster.handleWire` reads as if its declared type were true.  A
   *    gossip frame carrying a member `status` outside the legal set is
   *    refused by the other two transports and used to arrive here intact
   *    (#563), so the guarantees #563, #705 and #711 established for the wire
   *    simply did not hold on the multi-core path.
   * 3. the `try`/`catch` — a handler that throws for a reason nobody
   *    anticipated.  Dropping mirrors closing the connection; there is no
   *    socket to close.
   */
  private onFrame(env: unknown): void {
    if (!this.running) return;
    if (!isBrokeredMessage(env)) {
      this.onDropped('malformed-envelope', null);
      return;
    }
    const checked = validateWireFrame(env.payload);
    if ('problem' in checked) {
      this.onDropped('malformed-frame', addressForLog(env.from), checked.problem);
      return;
    }
    let from: NodeAddress;
    try {
      from = NodeAddress.fromJSON(env.from);
    } catch {
      /* Step 1a — see the JSDoc: the guard's read and this one are two reads. */
      this.onDropped('malformed-envelope', null);
      return;
    }
    this.rememberPeer(from);
    try {
      this.handler(from, checked.message);
    } catch {
      /* Mirrors dropping the connection; there is no socket to close. */
      this.onDropped('handler-threw', addressForLog(env.from));
    }
  }

  /**
   * Count one drop, and fold it into at most one line per reason per
   * {@link DEFAULT_DROP_REPORT_INTERVAL_MS}.
   *
   * The throttle is keyed on the reason and nothing else — the closed union
   * above — never on the sender: a per-sender map is the map a misbehaving
   * peer grows, and three counters is the whole of the state here.  Which is
   * why the line says *most recently from* and not *from*: the count covers
   * every sender since that reason last reached the log.  `EnvelopeTrust.report`
   * and `WorkerBroker.onDropped` had both already chosen that wording, for the
   * same reason.
   *
   * **The line never carries the payload.**  Not the frame, not a string
   * lifted from it: an unvalidated payload string in a log line is the shape
   * that forged whole log lines in #573.  The one variable part besides the
   * address is `validateWireFrame`'s own reason, which is a fixed string per
   * failure — `TcpTransport` puts the same value on the same kind of line.
   *
   * **The address is escaped, because here it is not host-minted.**  Through a
   * broker `from` is rewritten to the port the frame arrived on (#774), so it
   * is as trustworthy as the broker's own `source`.  Wired port-to-port there
   * is no broker to do that, and `systemName` and `host` are then whatever the
   * peer wrote — `isNodeAddressData` asks for non-empty strings and nothing
   * else, so a `host` containing a newline is a well-formed address that
   * forges log lines. {@link sanitizeWireKindForLog} is the project's escaper
   * for exactly that: a wire-supplied string clipped and control-escaped for
   * one log line.  Its name says `kind` because the kind was its first caller.
   *
   * All three reasons go out at `warn`.  The broker has one that does not —
   * an unknown destination, which is what every healthy sibling produces for a
   * moment after a crash — and this transport has no equivalent: each of these
   * three is a defect somewhere, and a version skew being visible is the whole
   * point of the change.
   *
   * This runs inside the port's `onmessage` callback, where nothing catches,
   * so the report cannot be allowed to throw.  `Logger` is a documented
   * extension point, and a sink that throws would otherwise reopen the exact
   * hole #945 closed — with the line that reports a dropped frame.
   * `WorkerBroker.reportThrough` is the same guard one subsystem over and
   * cannot be shared: `src/cluster/` importing `src/worker/` would invert the
   * layering both brokers depend on.
   */
  private onDropped(reason: MessageChannelDropReason, source: string | null, detail = ''): void {
    this.dropCounts[reason] += 1;
    this.suppressed[reason] += 1;
    const now = this.clock.now();
    if (now - this.lastReportedAt[reason] < DEFAULT_DROP_REPORT_INTERVAL_MS) return;
    this.lastReportedAt[reason] = now;
    const count = this.suppressed[reason];
    this.suppressed[reason] = 0;
    const origin = source === null ? '' : `, most recently from ${source}`;
    const line = `message-channel transport dropped ${count} frame(s)${origin} — ${dropDetail(reason, detail)}`;
    try {
      this.log.warn(line);
    } catch (loggerError) {
      console.error(`${line} (the configured logger threw while reporting this: ${describeLoggerFailure(loggerError)})`);
    }
  }

  /**
   * Record a peer for {@link peers}, unless {@link MAX_KNOWN_CHANNEL_PEERS} is
   * already full — see that constant for why the newest is refused rather than
   * the oldest evicted.
   *
   * That the cap can never turn an established peer into an unknown one — which
   * matters, because the readiness check reads this map — is a property of the
   * map and not of anything written here: `set` on a key already present leaves
   * the size alone, so the only thing the cap can refuse is a key the map does
   * not have.  This used to open with a `has` short-circuit stating the
   * invariant as though it enforced it; nothing could observe its removal,
   * because there was nothing there to observe.
   *
   * {@link onFrame} validates the payload before it gets here, so a sender that
   * never posts a legal frame never takes a slot.  That keeps *garbage* out of
   * the map and nothing more: one schema-valid heartbeat under an invented
   * `from` is all a slot costs, so the ordering does not decide who gets in
   * first and does not bound who can fill it.  What the cap costs when it is
   * full — a legitimate peer that arrives late is never listed, and the
   * readiness check says so for the life of the process — is the mirror failure
   * {@link MAX_KNOWN_CHANNEL_PEERS} spells out, together with the two reasons
   * the shipped wirings do not reach it.  Both sides are asserted in
   * `tests/unit/cluster/TransportFrameGuardContract.test.ts`.
   */
  private rememberPeer(from: NodeAddress): void {
    if (this.knownPeers.size >= MAX_KNOWN_CHANNEL_PEERS) return;
    this.knownPeers.set(from.toString(), from);
  }
}

/**
 * One sender, rendered for a log line and made safe for it — see
 * {@link MessageChannelTransport.onDropped} for why the escape is not
 * optional here the way it is on a host-minted address.
 *
 * Built from the fields rather than from a {@link NodeAddress}, because the
 * `malformed-frame` case reports a sender whose envelope was fine and whose
 * payload was not: there is no reason to construct an address object to
 * throw away, and one of the two call sites has none to hand.
 */
function addressForLog(from: NodeAddressData): string {
  return sanitizeWireKindForLog(`${from.systemName}@${from.host}:${from.port}`);
}

/** The operator-facing half of one {@link MessageChannelDropReason}. */
function dropDetail(reason: MessageChannelDropReason, detail: string): string {
  // Inline arms on purpose: this computes a string rather than dispatching an
  // incoming message, which is the exemption the delegation rule carves out —
  // the same shape as `WorkerBroker.dropDetail` and `EnvelopeTrust.refusalDetail`.
  if (reason === 'malformed-envelope') {
    return 'the envelope is not a BrokeredMessage — its address fields failed the shape check, '
      + 'and nothing past them was read';
  }
  if (reason === 'malformed-frame') {
    return `the payload is not a frame this node accepts: ${detail}`;
  }
  return 'the wire handler threw on a frame that passed both guards — the frame is lost and the '
    + 'port stays open, because there is no connection to drop';
}

/**
 * One line for the console when the configured logger itself threw.
 *
 * It never throws: `String()` runs the value's `toString`, and a
 * null-prototype object has none.  This runs inside the `catch` of a report
 * made from a `MessagePort` callback, where a second throw has nothing left to
 * catch it.  `WorkerBroker.describeFailure` is the same function one subsystem
 * over, and unreachable from here for the same layering reason.
 */
function describeLoggerFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return `a non-Error ${typeof error}`;
  }
}
