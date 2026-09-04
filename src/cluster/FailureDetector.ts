import { match } from 'ts-pattern';
import { NodeAddress } from './NodeAddress.js';
import { fromNullable, type Option } from '../util/Option.js';
import { stripUndefined } from '../util/OptionsMerge.js';
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from './Constants.js';
import { FailureDetectorOptionsValidator } from './FailureDetectorOptions.js';
import type { FailureDetectorOptions, FailureDetectorOptionsType } from './FailureDetectorOptions.js';
import { PhiAccrualFailureDetector } from './PhiAccrualFailureDetector.js';
import type { PhiAccrualOptionsType } from './PhiAccrualOptions.js';

export const defaultFailureDetectorOptions: FailureDetectorOptionsType = {
  heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
  unreachableAfterMs: 2_000,
  downAfterMs: 5_000,
};

export type FailureDecision = 'healthy' | 'unreachable' | 'down';

/**
 * Which detection algorithm a cluster installs — the value of
 * `actor-ts.cluster.failure-detector.implementation` and of
 * {@link ClusterOptionsType.failureDetectorImplementation}.
 *
 * `implementation` rather than `plugin` because this swaps one *internal*
 * algorithm for another: both members are shipped classes, chosen by name,
 * with no registry of third-party ids behind them.
 */
export type FailureDetectorImplementation = 'simple' | 'phi';

/**
 * What {@link Cluster} needs of a failure detector, and the whole of it.
 *
 * The contract exists so the cluster field can name a *capability* rather
 * than one of the two classes that provide it — before #840 it was typed
 * `FailureDetector`, which made the φ-accrual detector unreachable from
 * `Cluster.join` no matter what an operator configured.  Both shipped
 * detectors already satisfied this shape; only the declaration was missing.
 *
 * `phi()` is deliberately absent: it is {@link PhiAccrualFailureDetector}'s
 * own diagnostic, not something the cluster may assume of a detector.
 */
export interface FailureDetectorLike {
  /** Record that we know about a peer even if we haven't heard from it yet. */
  register(peer: NodeAddress, now?: number): void;
  /** Record that a message was received from `peer` (any message counts). */
  heartbeat(peer: NodeAddress, now?: number): void;
  /** The detector's verdict about `peer` at `now`. */
  decide(peer: NodeAddress, now?: number): FailureDecision;
  /** Drop everything remembered about `peer`. */
  forget(peer: NodeAddress): void;
  /** When `peer` was last heard from, if ever. */
  lastSeen(peer: NodeAddress): Option<number>;
  /** The cadence the cluster schedules its heartbeat and detection ticks from. */
  get interval(): number;
}

type Sample = {
  lastSeen: number;
  everSeen: boolean;
};

/**
 * A simple, deterministic failure detector.  Every heartbeat bumps the
 * last-seen timestamp for a peer; the cluster periodically asks which peers
 * have fallen past the thresholds.  No φ-accrual / variance tracking — just
 * plain elapsed-time limits, which is sufficient for LAN-scale clusters.
 */
export class FailureDetector {
  private samples = new Map<string, Sample>();
  private readonly options: FailureDetectorOptionsType;

  constructor(options: FailureDetectorOptions = {}) {
    // Unset builder fields fall through to the built-in defaults.
    this.options = { ...defaultFailureDetectorOptions, ...(options as Partial<FailureDetectorOptionsType>) };
    new FailureDetectorOptionsValidator().validate(this.options);
  }

  /** Record that a message was received from `peer` (any message counts). */
  heartbeat(peer: NodeAddress, now: number = Date.now()): void {
    const key = peer.toString();
    const prev = this.samples.get(key);
    this.samples.set(key, { lastSeen: now, everSeen: prev?.everSeen ?? true });
  }

  /** Record that we know about a peer even if we haven't heard from it yet. */
  register(peer: NodeAddress, now: number = Date.now()): void {
    const key = peer.toString();
    if (!this.samples.has(key)) this.samples.set(key, { lastSeen: now, everSeen: false });
  }

  forget(peer: NodeAddress): void {
    this.samples.delete(peer.toString());
  }

  decide(peer: NodeAddress, now: number = Date.now()): FailureDecision {
    const sample = this.samples.get(peer.toString());
    if (!sample) return 'healthy';
    const elapsed = now - sample.lastSeen;
    if (elapsed >= this.options.downAfterMs) return 'down';
    if (elapsed >= this.options.unreachableAfterMs) return 'unreachable';
    return 'healthy';
  }

  lastSeen(peer: NodeAddress): Option<number> {
    return fromNullable(this.samples.get(peer.toString())?.lastSeen);
  }

  get interval(): number { return this.options.heartbeatIntervalMs; }
}

/**
 * Build the detector the cluster runs — the selection seam `Cluster.join`
 * never had (#840).
 *
 * `failureDetector` arrives fully resolved (explicit options over HOCON over
 * built-in defaults), and its `heartbeatIntervalMs` is imposed on the φ-accrual
 * detector rather than read from `phiAccrual`.  That is the point of #1142:
 * the cadence belongs to the cluster's heartbeat loop, so swapping the
 * algorithm must not change how often this node talks to its peers.  There is
 * deliberately no `failure-detector.phi.heartbeat-interval` for it to come
 * from, and imposing it here is what keeps it that way.
 *
 * The remaining φ settings stay partial on purpose:
 * `PhiAccrualFailureDetector` spreads `defaultPhiAccrualOptions` under them
 * and validates the result, so the block is validated once, at consume time,
 * on the merged settings — and only when it is actually consumed.
 *
 * A `match` rather than an `if`: `.exhaustive()` turns a third member of
 * {@link FailureDetectorImplementation} into a compile error here instead of
 * a silent fall-through to the simple detector.
 */
export function createFailureDetector(
  implementation: FailureDetectorImplementation,
  failureDetector: FailureDetectorOptionsType,
  phiAccrual: Partial<PhiAccrualOptionsType> = {},
): FailureDetectorLike {
  return match(implementation)
    .with('simple', () => new FailureDetector(failureDetector))
    .with('phi', () => new PhiAccrualFailureDetector({
      ...stripUndefined(phiAccrual),
      heartbeatIntervalMs: failureDetector.heartbeatIntervalMs,
    }))
    .exhaustive();
}
