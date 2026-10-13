import type { Clock } from '../Clock.js';
import { systemClock } from '../Clock.js';
import { NodeAddress } from './NodeAddress.js';
import type { FailureDecision, FailureDetectorLike } from './FailureDetector.js';
import { fromNullable, type Option } from '../util/Option.js';
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from './Constants.js';
import { PhiAccrualOptionsValidator } from './PhiAccrualOptions.js';
import type { PhiAccrualOptions, PhiAccrualOptionsType } from './PhiAccrualOptions.js';

export const defaultPhiAccrualOptions: PhiAccrualOptionsType = {
  heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
  unreachableThreshold: 8,
  downThreshold: 12,
  maxSampleSize: 200,
  minStdDeviationMs: 100,
  acceptableHeartbeatPauseMs: 0,
  expectedResponseAfterMs: 'auto',
};

/**
 * What the detector remembers of one peer.  The three instants are optional
 * rather than `0`-for-never: a `ManualScheduler` starts at 0, and with `0` as
 * the sentinel a heartbeat at that instant was dropped as the origin of the
 * next interval, so every test that started a peer at t = 0 lost its first
 * sample without a word.
 */
type PeerState = {
  /**
   * When the peer became known, if that happened before anything arrived from
   * it — the origin silence is measured from until something does.
   */
  readonly registeredAt: number | undefined;
  /** The last frame of any kind — the instant silence is measured from. */
  lastHeardAt: number | undefined;
  /** The last heartbeat frame — the origin of the next inter-arrival sample. */
  lastHeartbeatAt: number | undefined;
  /** Ring-buffer of recent heartbeat inter-arrival times (ms). */
  readonly intervals: number[];
  intervalsHead: number;
  intervalsCount: number;
};

/**
 * Phi-accrual failure detector (Hayashibara et al, "The Phi Accrual Failure
 * Detector", 2004).  Tracks the distribution of a peer's recent heartbeat
 * inter-arrival times and produces a continuous suspicion value `phi`; the
 * cluster converts `phi` to `unreachable`/`down` by threshold.
 *
 * Compared to the simple time-threshold `FailureDetector`, this adapts to
 * actual network conditions — a peer whose heartbeats arrive like clockwork
 * can be flagged sooner, one behind a jittery link gets more slack.
 *
 * The two inputs of {@link FailureDetectorLike} map onto the model's two
 * halves: {@link heartbeat} adds a sample, measured heartbeat to heartbeat;
 * {@link heardFrom} only moves the instant silence is measured from.  Only the
 * first is a statement about the peer's schedule — every other frame arrives
 * when the application or the other half of the protocol happens to send it.
 */
export class PhiAccrualFailureDetector implements FailureDetectorLike {
  private readonly peers = new Map<string, PeerState>();
  private readonly options: PhiAccrualOptionsType;
  /** `expectedResponseAfterMs` resolved: `'auto'` is the cadence this detector was given. */
  private readonly expectedResponseMs: number;

  /**
   * @param clock Where every `now` default comes from — `system.clock` in a
   *   cluster, so the detector's notion of elapsed time is the same one the
   *   heartbeat ticks are scheduled on (#1424).
   */
  constructor(options: PhiAccrualOptions = {}, private readonly clock: Clock = systemClock) {
    this.options = { ...defaultPhiAccrualOptions, ...(options as Partial<PhiAccrualOptionsType>) };
    new PhiAccrualOptionsValidator().validate(this.options);
    const estimate = this.options.expectedResponseAfterMs;
    this.expectedResponseMs = estimate === 'auto' ? this.options.heartbeatIntervalMs : estimate;
  }

  get interval(): number { return this.options.heartbeatIntervalMs; }

  /**
   * Peer is now known.  No sample added until the first heartbeat, but the
   * silence is measured from `now` until something arrives.  A no-op for a
   * peer already known, so a late registration never moves an origin.
   */
  register(peer: NodeAddress, now: number = this.clock.now()): void {
    const key = peer.toString();
    if (!this.peers.has(key)) this.peers.set(key, this.freshState(now));
  }

  /**
   * A heartbeat frame arrived: one inter-arrival sample, measured from the
   * previous heartbeat.
   *
   * The first heartbeat has nothing to be measured from, so it seeds the
   * history with the configured estimate instead: E − E/4 and E + E/4, whose
   * mean is E and whose deviation is E/4.  Seeded rather than kept as a
   * separate prior, so real intervals wash the estimate out at the rate the
   * window turns over instead of replacing it outright at the first one — a
   * single real sample has no deviation at all, and judging a peer by the
   * floor alone after one interval is the over-eager first contact the
   * estimate is there to prevent (#1451).
   */
  heartbeat(peer: NodeAddress, now: number = this.clock.now()): void {
    const state = this.stateOf(peer);
    if (state.lastHeartbeatAt !== undefined) {
      this.record(state, now - state.lastHeartbeatAt);
    } else {
      const spread = this.expectedResponseMs / 4;
      this.record(state, this.expectedResponseMs - spread);
      this.record(state, this.expectedResponseMs + spread);
    }
    state.lastHeartbeatAt = now;
    state.lastHeardAt = now;
  }

  /** A frame of any kind arrived: silence is measured from `now`, and nothing is sampled. */
  heardFrom(peer: NodeAddress, now: number = this.clock.now()): void {
    this.stateOf(peer).lastHeardAt = now;
  }

  /** Current phi value for `peer` — the higher, the more suspicious. */
  phi(peer: NodeAddress, now: number = this.clock.now()): number {
    const state = this.peers.get(peer.toString());
    // Silence runs from the last frame — or, for a member registered before
    // anything arrived from it, from the registration, judged with the same
    // first-contact estimate.  Answering 0 there instead kept a member this
    // node learned of through gossip and never heard from healthy for good,
    // where the simple detector has always downed it five seconds in (#1451).
    const origin = state?.lastHeardAt ?? state?.registeredAt;
    if (state === undefined || origin === undefined) return 0;
    const effectiveElapsed = Math.max(0, now - origin - this.options.acceptableHeartbeatPauseMs);

    const { mean, deviation } = this.distributionOf(state);
    // Use the classic Hayashibara formulation with a normal distribution.
    // phi = -log10(P(delay > elapsed))
    // Where P(delay > x) ≈ 1 - Φ((x - mean) / stddev).
    const zScore = (effectiveElapsed - mean) / deviation;
    // Use the complementary normal CDF (from upper-tail approximation).
    const prob = 1 - standardNormalCdf(zScore);
    if (prob <= 0) return Number.POSITIVE_INFINITY;
    return -Math.log10(prob);
  }

  decide(peer: NodeAddress, now: number = this.clock.now()): FailureDecision {
    const phi = this.phi(peer, now);
    if (phi >= this.options.downThreshold) return 'down';
    if (phi >= this.options.unreachableThreshold) return 'unreachable';
    return 'healthy';
  }

  forget(peer: NodeAddress): void { this.peers.delete(peer.toString()); }

  lastSeen(peer: NodeAddress): Option<number> {
    return fromNullable(this.peers.get(peer.toString())?.lastHeardAt);
  }

  /* ------------------------ helpers ------------------------ */

  /**
   * What the silence is judged against: the history once there is one, and
   * before the first heartbeat the same estimate the history is seeded with —
   * mean E, deviation E/4 — so the verdict does not jump when it arrives.
   * The floor applies to both — it is what keeps a very steady peer from
   * being flagged on noise, and at a short cadence a quarter of the estimate
   * falls below it.
   */
  private distributionOf(state: PeerState): { readonly mean: number; readonly deviation: number } {
    const floor = this.options.minStdDeviationMs;
    if (state.intervalsCount === 0) {
      return { mean: this.expectedResponseMs, deviation: Math.max(floor, this.expectedResponseMs / 4) };
    }
    const mean = this.mean(state);
    return { mean, deviation: Math.max(floor, this.stddev(state, mean)) };
  }

  private freshState(registeredAt: number | undefined): PeerState {
    return {
      registeredAt,
      lastHeardAt: undefined,
      lastHeartbeatAt: undefined,
      intervals: new Array(this.options.maxSampleSize).fill(0),
      intervalsHead: 0,
      intervalsCount: 0,
    };
  }

  /** The peer's state, created on first contact for a peer nobody registered. */
  private stateOf(peer: NodeAddress): PeerState {
    const key = peer.toString();
    const known = this.peers.get(key);
    if (known) return known;
    const created = this.freshState(undefined);
    this.peers.set(key, created);
    return created;
  }

  private record(state: PeerState, interval: number): void {
    state.intervals[state.intervalsHead] = interval;
    state.intervalsHead = (state.intervalsHead + 1) % this.options.maxSampleSize;
    if (state.intervalsCount < this.options.maxSampleSize) state.intervalsCount++;
  }

  private mean(state: PeerState): number {
    let sum = 0;
    for (let i = 0; i < state.intervalsCount; i++) sum += state.intervals[i]!;
    return sum / state.intervalsCount;
  }

  private stddev(state: PeerState, mean: number): number {
    if (state.intervalsCount < 2) return 0;
    let acc = 0;
    for (let i = 0; i < state.intervalsCount; i++) {
      const deviation = state.intervals[i]! - mean;
      acc += deviation * deviation;
    }
    return Math.sqrt(acc / state.intervalsCount);
  }
}

/** Standard-normal CDF via Abramowitz & Stegun 26.2.17 (good to ~7e-4). */
function standardNormalCdf(x: number): number {
  // Handle tails explicitly for numerical stability.
  if (x < -8) return 0;
  if (x >  8) return 1;
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p  = 0.2316419;
  const c  = 0.39894228;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  const cdf = 1 - c * Math.exp(-x * x / 2) * y;
  return x >= 0 ? cdf : 1 - cdf;
}
