import type { Clock } from '../Clock.js';
import { systemClock } from '../Clock.js';
import { NodeAddress } from '../cluster/NodeAddress.js';
import {
  isBrokeredMessage,
  type BrokeredMessage,
  type PortLike,
} from '../cluster/transports/MessageChannelTransport.js';
import { ConsoleLogger, LogLevel, type Logger } from '../Logger.js';

/**
 * Why the broker refused to forward a frame.
 *
 * - `malformed` — the envelope failed {@link isBrokeredMessage}; nothing past
 *   its two address fields was read.
 * - `unknown-destination` — `to` names an address no port is registered under.
 *   By design, and the normal shape after a crash: every sibling keeps
 *   gossiping to the dead address until the failure detector converges.
 * - `unroutable` — the destination port refused the frame: a closed
 *   `MessagePort`'s `InvalidStateError`, a `DataCloneError`, or an in-process
 *   `PortLike` whose far side threw.
 *
 * A union of string literals rather than an enum so a member can be added
 * (#1415's per-worker budget would be `'budget-exceeded'`) without touching
 * the tally's shape at every read site.  Shutdown is deliberately **not** a
 * reason: `close()` nulls every `onmessage`, so a frame arriving after it is
 * a race the broker absorbs, not a refusal it reports.
 */
export type WorkerBrokerDropReason = 'malformed' | 'unknown-destination' | 'unroutable';

/**
 * How often each {@link WorkerBrokerDropReason} may reach the log, whatever
 * the drop rate (#1276).
 *
 * The `EnvelopeTrust.report` shape one layer up: a counter carries the
 * signal, the log is rate-limited.  A line per dropped frame would let a
 * worker write the host's log at `postMessage` rate — the amplification
 * `ENVELOPE_REFUSAL_REPORT_INTERVAL_MS` refuses to hand out on the wire, and a
 * thread is a cheaper place to post from than a socket.  The first drop of
 * each reason is reported at once, so an operator sees a wiring mistake
 * immediately; what this spaces out is the second thousand, folded into one
 * line carrying the count.
 *
 * A constant and not an option for the same reason as its cluster sibling:
 * there is no deployment in which the useful value differs, and a knob for it
 * would be a knob for how loud a worker may make the host's log.  It lives here
 * and not in a `src/worker/Constants.ts` because it is the subsystem's only
 * tuned constant and only this file reads it; a second one moves both.
 */
export const WORKER_BROKER_DROP_REPORT_INTERVAL_MS = 30_000;

/**
 * Main-thread piece of the multi-core cluster.  Collects one `MessagePort`
 * per worker and forwards `BrokeredMessage`s based on their `to` address,
 * re-addressing each to the port it arrived on ({@link withChannelSource}).
 *
 * What it will not forward it **drops, counts and reports**: a malformed
 * envelope, an unknown destination and a port that refuses the frame each
 * bump a per-reason tally ({@link WorkerBroker.dropped}) and reach the logger
 * as one folded line per reason per
 * {@link WORKER_BROKER_DROP_REPORT_INTERVAL_MS}.  The rest of the cluster
 * still deals with an unknown destination through the normal dead-letters /
 * failure-detection paths — that reason is reported at `debug`, because after
 * a crash it is what every healthy sibling does until the detector catches up.
 *
 * The broker itself does not speak the cluster gossip protocol; it is
 * purely a routing layer between worker transports.
 */
export class WorkerBroker {
  private readonly ports = new Map<string, PortLike>();
  private stopped = false;
  private readonly log: Logger;
  private readonly clock: Clock;
  /** Cumulative drops per reason, for the process lifetime — what {@link dropped} snapshots. */
  private readonly dropCounts: Record<WorkerBrokerDropReason, number> =
    { malformed: 0, 'unknown-destination': 0, unroutable: 0 };
  /** Drops counted per reason since that reason last reached the log. */
  private readonly suppressed: Record<WorkerBrokerDropReason, number> =
    { malformed: 0, 'unknown-destination': 0, unroutable: 0 };
  /**
   * When each reason last reached the log.  `-Infinity` rather than `0` so
   * the first drop of a reason reports whatever the clock reads — an injected
   * test clock may well start at zero.
   */
  private readonly lastReportedAt: Record<WorkerBrokerDropReason, number> =
    { malformed: -Infinity, 'unknown-destination': -Infinity, unroutable: -Infinity };

  /**
   * `log` is where the drops are reported.  A positional optional parameter
   * rather than an options triad — the `TcpTransport(self, log, options)`
   * precedent — because it is the broker's one knob; #1415's per-worker budget
   * would be the second, and the triad comes with it.  The default is the same
   * sink `WorkerCluster` falls back to, so a bare broker is never silent;
   * `WorkerCluster.spawn` hands its own logger in and `WorkerMesh` hands in
   * `system.log`, so in a mesh every report reaches the configured sinks.
   *
   * `clock` exists so the fold can be exercised without a thirty-second wait.
   */
  constructor(log: Logger = new ConsoleLogger(LogLevel.Info), clock: Clock = systemClock) {
    this.log = log;
    this.clock = clock;
  }

  /**
   * Register a worker's port — the broker will forward to its peers from
   * now on and accept inbound traffic from it.
   */
  register(address: NodeAddress, port: PortLike): void {
    const key = address.toString();
    // A closed broker must stay empty.  Without this a respawn that raced
    // shutdown re-populated `ports` after `close()` with a port whose traffic
    // `onMessage` then drops — inert, permanently retained, and keeping its
    // worker reachable-but-dead for the process lifetime (#735).
    if (this.stopped) {
      try { port.close?.(); } catch { /* ignore */ }
      return;
    }
    if (this.ports.has(key)) throw new Error(`WorkerBroker: address ${key} already registered`);
    this.ports.set(key, port);
    // The `NodeAddress` and not `key`: `onMessage` stamps this address into
    // every frame the port sends (#774), and parsing it back out of the string
    // form per frame would redo work the registration already did.
    port.onmessage = (evt) => this.onMessage(address, evt.data);
    port.start?.();
  }

  /** Drop a worker's port (typically on worker shutdown). */
  unregister(address: NodeAddress): void {
    const key = address.toString();
    const port = this.ports.get(key);
    if (!port) return;
    try { port.onmessage = null; } catch { /* ignore */ }
    try { port.close?.(); } catch { /* ignore */ }
    this.ports.delete(key);
  }

  /** Close every port; further messages are dropped. */
  close(): void {
    this.stopped = true;
    for (const [, port] of this.ports) {
      try { port.onmessage = null; } catch { /* ignore */ }
      try { port.close?.(); } catch { /* ignore */ }
    }
    this.ports.clear();
  }

  /** Snapshot of currently-registered addresses — diagnostic only. */
  registered(): NodeAddress[] {
    return Array.from(this.ports.keys()).map(k => NodeAddress.parse(k));
  }

  /**
   * How many frames this broker has refused to forward, per reason, since it
   * was built — a diagnostic snapshot like {@link registered}, and the number
   * the folded log line is a sample of.  A copy, so a caller cannot reset the
   * tally by writing to it.
   */
  dropped(): Readonly<Record<WorkerBrokerDropReason, number>> {
    return { ...this.dropCounts };
  }

  /* -------------------------------- Internal ------------------------------- */

  /**
   * `frame` is `unknown` and not `BrokeredMessage` deliberately — it is
   * whatever a worker put on its port, and the cast this signature used to
   * carry was the whole defect.  `NodeAddress.fromJSON` validates and
   * *throws* by design (#571), on the premise that a frame guard rejected
   * malformed addresses before it ran; that premise never held here, so the
   * hardening turned a class of malformed frame that used to be routed or
   * silently dropped into a host-killing throw inside the worker's `message`
   * listener (#701).
   *
   * Malformed frames are dropped, not rejected loudly — the same policy the
   * unknown-destination case has always had — but since #1276 every drop is
   * counted and reported through {@link onDropped}.  The try/catch around the
   * forward is a backstop for the same reason the guard exists: a throw from
   * the destination port must not escape into an event callback the host
   * cannot catch.  Once the guard has passed, `fromJSON` cannot throw —
   * `isNodeAddressData` and `fromJSON` check one rule, stated in
   * `WireValidation` — so the only thing left to catch is the port.  The guard
   * itself lives beside `BrokeredMessage`, shared with the testkit's broker
   * fork for the reason stated there.
   *
   * `source` is the address this port was registered under — the one identity
   * on this path a worker cannot choose for itself, because the host minted it
   * (`WorkerCluster.spawnOne`) and handed it to {@link WorkerBroker.register}.
   * {@link withChannelSource} is what spends it (#774), and the report names
   * it for the same reason: it is the only string on this path that did not
   * come from the frame.
   */
  private onMessage(source: NodeAddress, frame: unknown): void {
    if (this.stopped) return;
    if (!isBrokeredMessage(frame)) {
      this.onDropped(source, 'malformed');
      return;
    }
    let target: PortLike | undefined;
    try {
      target = this.ports.get(NodeAddress.fromJSON(frame.to).toString());
    } catch {
      // Unreachable while the guard and `fromJSON` share their rule; kept so a
      // drift between the two is a dropped frame and not a host-killing throw.
      this.onDropped(source, 'malformed');
      return;
    }
    if (target === undefined) {
      this.onDropped(source, 'unknown-destination');
      return;
    }
    try {
      target.postMessage(withChannelSource(frame, source));
    } catch (error) {
      this.onDropped(source, 'unroutable', error);
    }
  }

  /**
   * Count one drop, and fold it into at most one line per reason per
   * {@link WORKER_BROKER_DROP_REPORT_INTERVAL_MS}.
   *
   * The throttle is keyed on the reason and nothing else — the closed union
   * above — never on the source: a per-source map is the map a misbehaving
   * worker grows, and three counters is the whole of the state here.
   *
   * The line never carries the frame.  Not `to`, not `payload`, not any
   * string lifted from it: an unvalidated payload string in a log line is the
   * shape that forged whole log lines in #573.  The source address is
   * host-minted and the detail is a fixed string per reason; the one variable
   * part, the `unroutable` cause, is the *port's* error, not the frame's.
   *
   * `unknown-destination` goes out at `debug`, the other two at `warn`
   * (#1276): a malformed frame or a refusing port is a defect somewhere, while
   * gossip to a just-dead worker is what a healthy mesh does after every crash
   * and would otherwise put a WARN over every ordinary respawn.
   */
  private onDropped(source: NodeAddress, reason: WorkerBrokerDropReason, error?: unknown): void {
    this.dropCounts[reason] += 1;
    this.suppressed[reason] += 1;
    const now = this.clock.now();
    if (now - this.lastReportedAt[reason] < WORKER_BROKER_DROP_REPORT_INTERVAL_MS) return;
    this.lastReportedAt[reason] = now;
    const count = this.suppressed[reason];
    this.suppressed[reason] = 0;
    const line = `[worker] broker dropped ${count} frame(s) from ${source} — ${dropDetail(reason, error)}`;
    if (reason === 'unknown-destination') {
      this.log.debug(line);
      return;
    }
    this.log.warn(line);
  }
}

/** The operator-facing half of one {@link WorkerBrokerDropReason}. */
function dropDetail(reason: WorkerBrokerDropReason, error: unknown): string {
  // Inline arms on purpose: this computes a string rather than dispatching an
  // incoming message, which is the exemption the delegation rule carves out —
  // the same shape as `EnvelopeTrust.refusalDetail`.
  if (reason === 'malformed') {
    return 'the envelope is not a BrokeredMessage — its address fields failed the shape check, '
      + 'and nothing past them was read';
  }
  if (reason === 'unknown-destination') {
    return 'no worker is registered at the destination address — expected briefly after a worker dies, '
      + 'while its siblings\' gossip catches up with the failure detector';
  }
  return `the destination port refused the frame: ${describeFailure(error)}`;
}

/**
 * One line for a logger: an `Error`'s message, or whatever the value renders
 * as.  Exported for `WorkerCluster`, which reports through the same logger and
 * must render a failure the same way — it is not in `src/worker/index.ts`, so
 * it is not package surface.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === undefined || error === null) return '';
  return String(error);
}

/**
 * Re-address a frame to the port it actually arrived on (#774).
 *
 * The broker holds a binding no worker can forge, and used to throw it away:
 * it re-posted whatever `from` the sender wrote, and the receiving
 * `MessageChannelTransport` hands that value straight to `Cluster.handleWire`
 * as the peer identity.  So one worker could refresh a sibling's
 * failure-detector timer — keeping a dead node looking alive — and have its
 * envelopes attributed to that sibling.  Every other identity fix in the
 * cluster (#562, #564, #572, #574, #582) takes the peer from the connection
 * rather than from the payload; this is that same rule one layer down, where
 * the connection is a `MessagePort`.
 *
 * Rewriting rather than dropping the mismatch is deliberate.  It makes the
 * receiver's peer identity channel-derived *by construction*, so no later
 * caller can forget a check, and it concedes nothing: the sender is a live
 * registered peer that could have sent the same payload under its own name.
 * It also leaves nothing to report — a dropped frame would be a refusal that
 * has to be counted and explained, where a re-addressed one is simply correct.
 *
 * The equality test is a fast path rather than an optimisation detail.
 * Measured on the broker's own forward loop (2M honest frames, 5 interleaved
 * rounds, 3 repetitions, Bun; `benchmarks/` has no arm over this path): against
 * a ~210 ns baseline, returning the frame unchanged costs nothing measurable —
 * its delta lands at or below zero, inside a run-to-run band of about ±30 ns —
 * while allocating a replacement unconditionally costs ~35-55 ns, and the drop
 * variant the issue also proposed —
 * `NodeAddress.fromJSON(frame.from).toString() !== source.toString()` — costs
 * ~210-240 ns, i.e. it roughly doubles the cost of forwarding a frame.
 *
 * Only the *slot* is compared, because the slot is the identity: `toString`,
 * `equals` and `compareTo` all exclude {@link NodeAddress.incarnation} by
 * design, so the failure detector, every member map and every authority rule
 * key on `systemName@host:port` alone.  A sender may therefore still choose
 * the `incarnation` it writes into `from`, which is harmless only for as long
 * as that field stays carried-but-not-acted-on (#940); the merge rule that
 * first keys on it has to bring this comparison with it.
 *
 * Exported for the testkit's broker fork alone — `src/testkit/internal/
 * MultiNodeBroker.ts` routes `ParallelMultiNodeSpec`'s worker mesh and has to
 * apply the identical rule, and a copied six-liner is a copy that drifts.  It
 * is not in `src/worker/index.ts`, so it is not package surface.
 */
export function withChannelSource(frame: BrokeredMessage, source: NodeAddress): BrokeredMessage {
  const { from } = frame;
  if (from.systemName === source.systemName
    && from.host === source.host
    && from.port === source.port) {
    return frame;
  }
  return { ...frame, from: source.toJSON() };
}
