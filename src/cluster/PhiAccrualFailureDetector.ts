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
};

/**
 * What the detector remembers of one peer.  The three instants are optional
 * rather than `0`-for-never: a `ManualScheduler` starts at 0, and with `0` as
 * the sentinel a heartbeat at that instant was dropped as the origin of the
 * next interval, so every test that started a peer at t = 0 lost its first
 * sample without a word.
 */
type PeerState = {
  /** When the peer became known, if that happened before anything arrived from it. */
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

  /**
   * @param clock Where every `now` default comes from — `system.clock` in a
   *   cluster, so the detector's notion of elapsed time is the same one the
   *   heartbeat ticks are scheduled on (#1424).
   */
  constructor(options: PhiAccrualOptions = {}, private readonly clock: Clock = systemClock) {
    this.options = { ...defaultPhiAccrualOptions, ...(options as Partial<PhiAccrualOptionsType>) };
    new PhiAccrualOptionsValidator().validate(this.options);
  }

  get interval(): number { return this.options.heartbeatIntervalMs; }

  /** Peer is now known.  No sample added until the first heartbeat. */
  register(peer: NodeAddress, now: number = this.clock.now()): void {
    const key = peer.toString();
    if (!this.peers.has(key)) this.peers.set(key, this.freshState(now));
  }

  /**
   * A heartbeat frame arrived: one inter-arrival sample, measured from the
   * previous heartbeat.  The first heartbeat has nothing to be measured from
   * and only becomes the origin of the next sample.
   */
  heartbeat(peer: NodeAddress, now: number = this.clock.now()): void {
    const state = this.stateOf(peer);
    if (state.lastHeartbeatAt !== undefined) this.record(state, now - state.lastHeartbeatAt);
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
    // Nothing has arrived from the peer yet, so there is no silence to judge.
    if (state?.lastHeardAt === undefined) return 0;
    const effectiveElapsed = Math.max(0, now - state.lastHeardAt - this.options.acceptableHeartbeatPauseMs);

    // Before enough samples are collected, fall back to the intended
    // cadence so very new peers don't immediately look unreachable.
    const mean = state.intervalsCount > 0 ? this.mean(state) : this.options.heartbeatIntervalMs;
    const stddev = Math.max(this.options.minStdDeviationMs, this.stddev(state, mean));
    // Use the classic Hayashibara formulation with a normal distribution.
    // phi = -log10(P(delay > elapsed))
    // Where P(delay > x) ≈ 1 - Φ((x - mean) / stddev).
    const zScore = (effectiveElapsed - mean) / stddev;
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
