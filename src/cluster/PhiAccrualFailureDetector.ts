import { NodeAddress } from './NodeAddress.js';
import type { FailureDecision } from './FailureDetector.js';
import { fromNullable, type Option } from '../util/Option.js';

export interface PhiAccrualSettings {
  /** Intended heartbeat cadence.  Used to keep `interval` compatible with FailureDetector. */
  readonly heartbeatIntervalMs: number;
  /** Phi value above which the peer is flagged unreachable.  Typical 8–12. */
  readonly unreachableThreshold: number;
  /** Phi value above which the peer is flagged down.  Must be > unreachableThreshold. */
  readonly downThreshold: number;
  /** How many recent intervals to keep in the sliding window. */
  readonly maxSampleSize: number;
  /** Minimum stddev floor — avoids over-eager flagging for very stable peers. */
  readonly minStdDeviationMs: number;
  /**
   * Grace period added to the most recent heartbeat — heartbeats that
   * arrive up to `acceptableHeartbeatPauseMs` late do not raise phi.
   */
  readonly acceptableHeartbeatPauseMs: number;
}

export const defaultPhiAccrualSettings: PhiAccrualSettings = {
  heartbeatIntervalMs: 500,
  unreachableThreshold: 8,
  downThreshold: 12,
  maxSampleSize: 200,
  minStdDeviationMs: 100,
  acceptableHeartbeatPauseMs: 0,
};

interface PeerState {
  lastHeartbeat: number;
  everSeen: boolean;
  /** Ring-buffer of recent inter-arrival times (ms). */
  readonly intervals: number[];
  intervalsHead: number;
  intervalsCount: number;
}

/**
 * Phi-accrual failure detector (Hayashibara et al, "The Phi Accrual Failure
 * Detector", 2004).  Tracks the distribution of recent inter-arrival times
 * and produces a continuous suspicion value `phi`; the cluster converts
 * `phi` to `unreachable`/`down` by threshold.
 *
 * Compared to the simple time-threshold `FailureDetector`, this adapts to
 * actual network conditions — a chatty LAN peer can be flagged sooner, a
 * jittery mobile peer gets more slack.
 */
export class PhiAccrualFailureDetector {
  private readonly peers = new Map<string, PeerState>();
  private readonly settings: PhiAccrualSettings;

  constructor(settings: Partial<PhiAccrualSettings> = {}) {
    this.settings = { ...defaultPhiAccrualSettings, ...settings };
    if (this.settings.downThreshold <= this.settings.unreachableThreshold) {
      throw new Error('PhiAccrualFailureDetector: downThreshold must exceed unreachableThreshold');
    }
    if (this.settings.maxSampleSize < 1) {
      throw new Error('PhiAccrualFailureDetector: maxSampleSize must be >= 1');
    }
  }

  get interval(): number { return this.settings.heartbeatIntervalMs; }

  /** Peer is now known.  No sample added until the first heartbeat. */
  register(peer: NodeAddress, _now: number = Date.now()): void {
    const key = peer.toString();
    if (!this.peers.has(key)) {
      this.peers.set(key, {
        lastHeartbeat: 0,
        everSeen: false,
        intervals: new Array(this.settings.maxSampleSize).fill(0),
        intervalsHead: 0,
        intervalsCount: 0,
      });
    }
  }

  /** Record a received heartbeat for `peer` at time `now`. */
  heartbeat(peer: NodeAddress, now: number = Date.now()): void {
    const key = peer.toString();
    let s = this.peers.get(key);
    if (!s) {
      s = {
        lastHeartbeat: now, everSeen: true,
        intervals: new Array(this.settings.maxSampleSize).fill(0),
        intervalsHead: 0, intervalsCount: 0,
      };
      this.peers.set(key, s);
      return;
    }
    if (s.lastHeartbeat > 0) {
      const delta = now - s.lastHeartbeat;
      s.intervals[s.intervalsHead] = delta;
      s.intervalsHead = (s.intervalsHead + 1) % this.settings.maxSampleSize;
      if (s.intervalsCount < this.settings.maxSampleSize) s.intervalsCount++;
    }
    s.lastHeartbeat = now;
    s.everSeen = true;
  }

  /** Current phi value for `peer` — the higher, the more suspicious. */
  phi(peer: NodeAddress, now: number = Date.now()): number {
    const s = this.peers.get(peer.toString());
    if (!s || !s.everSeen) return 0;
    const effectiveElapsed = Math.max(0, now - s.lastHeartbeat - this.settings.acceptableHeartbeatPauseMs);

    // Before enough samples are collected, fall back to the intended
    // cadence so very new peers don't immediately look unreachable.
    const mean = s.intervalsCount > 0 ? this.mean(s) : this.settings.heartbeatIntervalMs;
    const stddev = Math.max(this.settings.minStdDeviationMs, this.stddev(s, mean));
    // Use the classic Hayashibara formulation with a normal distribution.
    // phi = -log10(P(delay > elapsed))
    // Where P(delay > x) ≈ 1 - Φ((x - mean) / stddev).
    const y = (effectiveElapsed - mean) / stddev;
    // Use the complementary normal CDF (from upper-tail approximation).
    const prob = 1 - standardNormalCdf(y);
    if (prob <= 0) return Number.POSITIVE_INFINITY;
    return -Math.log10(prob);
  }

  decide(peer: NodeAddress, now: number = Date.now()): FailureDecision {
    const phi = this.phi(peer, now);
    if (phi >= this.settings.downThreshold) return 'down';
    if (phi >= this.settings.unreachableThreshold) return 'unreachable';
    return 'healthy';
  }

  forget(peer: NodeAddress): void { this.peers.delete(peer.toString()); }

  lastSeen(peer: NodeAddress): Option<number> {
    return fromNullable(this.peers.get(peer.toString())?.lastHeartbeat);
  }

  /* ------------------------ helpers ------------------------ */

  private mean(s: PeerState): number {
    let sum = 0;
    for (let i = 0; i < s.intervalsCount; i++) sum += s.intervals[i]!;
    return sum / s.intervalsCount;
  }

  private stddev(s: PeerState, mean: number): number {
    if (s.intervalsCount < 2) return 0;
    let acc = 0;
    for (let i = 0; i < s.intervalsCount; i++) {
      const d = s.intervals[i]! - mean;
      acc += d * d;
    }
    return Math.sqrt(acc / s.intervalsCount);
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
