import type { NodeAddress } from '../cluster/NodeAddress.js';
import type { WireMessage } from '../cluster/Protocol.js';
import type { Transport, WireHandler } from '../cluster/Transport.js';
import type { Scheduler } from '../Scheduler.js';
import {
  DEFAULT_TRANSPORT_DROP_PROBABILITY,
  DEFAULT_TRANSPORT_DUPLICATE_PROBABILITY,
  DEFAULT_TRANSPORT_FAULT_SEED,
  DEFAULT_TRANSPORT_LATENCY_MS,
  DEFAULT_TRANSPORT_REORDER_WINDOW,
  FaultyTransportOptionsValidator,
  type FaultyTransportOptions,
  type FaultyTransportOptionsType,
  type TransportFaultProfileType,
} from './FaultyTransportOptions.js';

/**
 * Wrap any {@link Transport} in a lossy, reordering, duplicating, slow link
 * (#1023).
 *
 * ## Why a decorator
 *
 * Every multi-node test in this repository ran on a network that was either
 * perfect or completely severed.  `MultiNodeTransport` offered `blockOutgoing`
 * and a bidirectional partition built from it; `InMemoryTransport` offered
 * nothing.  So the failure modes a gossip protocol is *written* to survive —
 * probabilistic loss, reordering, duplication, a slow-but-alive peer — were
 * structurally untestable, and the suite's failure scenarios were exactly the
 * ones `partition` and `crash` can express.
 *
 * Decorating rather than extending is what makes one implementation serve all
 * of them: `InMemoryTransport`, `MultiNodeTransport` and
 * `MessageChannelTransport` gain the same controls and none of the three grows
 * a line of fault logic.
 *
 * ## Determinism
 *
 * Every decision comes from one seeded generator per instance, drawn in send
 * order.  Under a shared `ManualScheduler` that order is itself deterministic,
 * so a failing run reproduces from the seed alone — which is the difference
 * between a chaos test and a flake generator, and this repository already has
 * a flake catalogue it is trying to shrink (#290).
 *
 * Latency is measured on the scheduler rather than the wall clock for the same
 * reason: a delay taken from `Date.now()` would reintroduce exactly the timing
 * dependence `ManualScheduler` exists to remove.
 *
 * ## What it does not do
 *
 * It does not corrupt frames.  A mutated frame is the wire-validation
 * question, which `validateWireFrame` and the hostile-frame suites already
 * own; this decorator is about *delivery*, and mixing the two would make a
 * failure ambiguous between "the protocol mishandled a legal frame" and "the
 * protocol accepted an illegal one".
 */
export class FaultyTransport implements Transport {
  private readonly settings: FaultyTransportOptionsType;
  private readonly scheduler: Scheduler | undefined;
  private readonly nextRandom: () => number;
  /**
   * Frames held back per peer, waiting to be released out of order.
   *
   * Per peer rather than one queue for the transport: reordering is a property
   * of a link, and a shared buffer would let a frame to `b` delay one to `c`,
   * which no network does and which would make a two-peer test's outcome
   * depend on a third peer's traffic.
   */
  private readonly held = new Map<string, Array<() => void>>();
  /**
   * Per-peer profiles, seeded from the options and mutable afterwards.
   *
   * Mutable because a fault has to be able to *begin* mid-test: the scenarios
   * this exists for are "a partition that starts during a rebalance" and "this
   * link degrades once the cluster is up", and an immutable profile could only
   * express a network that was already broken when the nodes started.
   */
  private readonly overrides = new Map<string, TransportFaultProfileType>();
  private stopped = false;

  /**
   * @param inner the transport that actually moves the frame
   * @param options what this link does to frames crossing it
   */
  constructor(
    private readonly inner: Transport,
    options: FaultyTransportOptions = {},
  ) {
    const settings = { ...(options as Partial<FaultyTransportOptionsType>) };
    new FaultyTransportOptionsValidator().validate(settings);
    this.settings = settings as FaultyTransportOptionsType;
    this.scheduler = this.settings.scheduler;
    this.nextRandom = seededRandom(this.settings.seed ?? DEFAULT_TRANSPORT_FAULT_SEED);
    for (const [peer, profile] of Object.entries(this.settings.perPeer ?? {})) {
      this.overrides.set(peer, profile);
    }
  }

  get self(): NodeAddress { return this.inner.self; }

  get maxFrameBytes(): number | undefined { return this.inner.maxFrameBytes; }

  /**
   * The seed this link is running with, for a failure message to name.
   *
   * Public because a red chaos run is only useful if the number that
   * reproduces it survives into the log — see `MultiNodeSpec`'s `await*`
   * helpers, which put it in the error they throw.
   */
  get seed(): number { return this.settings.seed ?? DEFAULT_TRANSPORT_FAULT_SEED; }

  /** True when any link of this transport is configured to misbehave. */
  get hasFaults(): boolean {
    return isFaulty(this.settings)
      || [...this.overrides.values()].some((profile) => isFaulty(profile));
  }

  setHandler(handler: WireHandler): void { this.inner.setHandler(handler); }

  async start(): Promise<void> { await this.inner.start(); }

  async shutdown(): Promise<void> {
    this.stopped = true;
    // Everything still held is dropped rather than flushed.  A transport that
    // is shutting down is a node that is going away, and delivering its
    // backlog on the way out would be a frame arriving from a dead peer —
    // which is the one thing a crash test asserts cannot happen.
    this.held.clear();
    await this.inner.shutdown();
  }

  /**
   * Apply this link's faults, then hand the survivors to the inner transport.
   *
   * The decision order is drop, then duplicate, then reorder, then delay, and
   * it is the order the events occur in on a real path: a frame that was lost
   * cannot also be duplicated, and a copy made by a retransmitting middlebox
   * is subject to the same queue as the original — so both copies go through
   * the reorder window independently and can arrive in either order.
   */
  send(to: NodeAddress, message: WireMessage): void {
    if (this.stopped) return;
    const profile = this.profileFor(to);
    if (profile === undefined) {
      // The fast path, and the common one: most links in a spec are clean, and
      // a clean link must cost nothing but this lookup.
      this.inner.send(to, message);
      return;
    }
    if (this.nextRandom() < (profile.dropProbability ?? DEFAULT_TRANSPORT_DROP_PROBABILITY)) return;
    const copies = this.nextRandom()
      < (profile.duplicateProbability ?? DEFAULT_TRANSPORT_DUPLICATE_PROBABILITY)
      ? 2
      : 1;
    for (let copy = 0; copy < copies; copy++) {
      this.enqueue(to, profile, () => { this.deliver(to, message, profile); });
    }
  }

  disconnect(peer: NodeAddress): void { this.inner.disconnect(peer); }

  peers(): NodeAddress[] { return this.inner.peers(); }

  /**
   * Release every frame this link is holding, in a permuted order.
   *
   * Needed because a reorder window is a *depth*: the last frames of a burst
   * sit in it until more traffic pushes them out.  Continuous gossip does that
   * on its own, and a test that sends three frames and waits does not — so
   * restoring a link flushes it, and so does a spec that wants to assert on a
   * quiet network.
   */
  flush(): void {
    for (const [peer, queue] of this.held) {
      this.releaseBatch(queue);
      this.held.delete(peer);
    }
  }

  /**
   * Degrade the link to `peer` from now on, replacing any profile it had.
   *
   * Validated here and not only at construction, because this is the door a
   * test drives faults through mid-run and an unchecked `0.2` meant as a
   * percentage would sever the link rather than thin it.
   */
  degradeTo(peer: NodeAddress, profile: TransportFaultProfileType): void {
    const key = peer.toString();
    new FaultyTransportOptionsValidator().validate({
      ...profile,
      // Carried so the "latency needs a scheduler" rule sees the one this
      // transport actually has, rather than reporting every mid-run latency as
      // unmeasurable.
      scheduler: this.scheduler,
    });
    this.overrides.set(key, profile);
  }

  /**
   * Return the link to `peer` to the top-level profile, releasing anything it
   * was holding.
   *
   * The flush is the point: a restored link must not go on delivering the
   * previous profile's backlog out of order, and frames held by a window that
   * no longer exists would otherwise wait for traffic that a settled test is
   * not going to send.
   */
  restoreTo(peer: NodeAddress): void {
    const key = peer.toString();
    this.overrides.delete(key);
    const queue = this.held.get(key);
    if (queue !== undefined) {
      this.releaseBatch(queue);
      this.held.delete(key);
    }
  }

  /* -------------------------------------------------------------- internal --- */

  /**
   * The profile governing frames to `to`, or `undefined` when the link is
   * clean.
   *
   * A peer named in `perPeer` uses its own profile *instead of* the top-level
   * one — including when that profile is clean, which is how "everything is
   * degraded except this one link" is expressed.
   */
  private profileFor(to: NodeAddress): TransportFaultProfileType | undefined {
    const profile = this.overrides.get(to.toString()) ?? this.settings;
    return isFaulty(profile) ? profile : undefined;
  }

  /**
   * Put one delivery into the link's reorder window, releasing the window as a
   * permuted batch once it is full.
   *
   * **A whole batch rather than one frame at a time, and that is the load
   * bearing choice.**  Releasing a single uniformly-chosen frame per arrival
   * is the obvious implementation and gives only a *probabilistic* bound on
   * how far a frame is displaced — an unlucky frame can sit in the buffer for
   * arbitrarily many rounds, and one did: measured displacement of 7 through a
   * window of 4.  Batching makes the guarantee exact.  A frame is released
   * within the batch it arrived in, so it is displaced by **less than
   * `reorderWindow` positions**, which is what lets a test reason about a
   * reordered link at all instead of hoping.
   *
   * A window of `1` therefore reorders nothing — one frame has one
   * permutation — and that is the honest reading of "hold up to one frame"
   * rather than an off-by-one.
   */
  private enqueue(
    to: NodeAddress,
    profile: TransportFaultProfileType,
    delivery: () => void,
  ): void {
    const window = profile.reorderWindow ?? DEFAULT_TRANSPORT_REORDER_WINDOW;
    if (window === 0) {
      delivery();
      return;
    }
    const key = to.toString();
    const queue = this.held.get(key) ?? [];
    queue.push(delivery);
    this.held.set(key, queue);
    if (queue.length >= window) this.releaseBatch(queue);
  }

  /**
   * Let everything in `queue` go, in a seeded permutation, leaving it empty.
   *
   * Fisher-Yates over a copy: the deliveries are drained first so a delivery
   * that sends again — which gossip does — cannot re-enter the array being
   * iterated.
   */
  private releaseBatch(queue: Array<() => void>): void {
    const batch = queue.splice(0, queue.length);
    for (let index = batch.length - 1; index > 0; index--) {
      const swap = Math.floor(this.nextRandom() * (index + 1));
      [batch[index], batch[swap]] = [batch[swap]!, batch[index]!];
    }
    for (const delivery of batch) delivery();
  }

  /** Hand one frame to the inner transport, now or after this link's latency. */
  private deliver(
    to: NodeAddress,
    message: WireMessage,
    profile: TransportFaultProfileType,
  ): void {
    const latencyMs = profile.latencyMs ?? DEFAULT_TRANSPORT_LATENCY_MS;
    if (latencyMs === 0 || this.scheduler === undefined) {
      if (!this.stopped) this.inner.send(to, message);
      return;
    }
    this.scheduler.scheduleOnceFunction(latencyMs, () => {
      // Re-checked at delivery rather than only at send: the frame has been in
      // flight across a scheduler advance, and a node that shut down during it
      // must not still be heard from.
      if (!this.stopped) this.inner.send(to, message);
    });
  }
}

/** Does this profile change anything at all about a frame? */
function isFaulty(profile: TransportFaultProfileType): boolean {
  return (profile.dropProbability ?? 0) > 0
    || (profile.duplicateProbability ?? 0) > 0
    || (profile.reorderWindow ?? 0) > 0
    || (profile.latencyMs ?? 0) > 0;
}

/**
 * `mulberry32` — a small, fast, seedable generator with a 2^32 period.
 *
 * Deliberately written here rather than taken from a dependency: the whole
 * value of the seed is that a run reproduces, which requires the algorithm to
 * be pinned by this file rather than by whatever a package resolved to. The
 * constants are the algorithm and stay with it (`AGENTS.md`'s second constant
 * rule); the period is far beyond what a spec's frame count reaches.
 *
 * `Math.random` would defeat the point entirely — see the seed's own docs.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
