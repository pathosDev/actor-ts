import { NodeAddress } from './NodeAddress.js';
import { fromNullable, type Option } from '../util/Option.js';
import type { FailureDetectorOptions } from './FailureDetectorOptions.js';

export interface FailureDetectorSettings {
  /** How often the detector samples and decides membership health. */
  readonly heartbeatIntervalMs: number;
  /** Time without heartbeat after which a peer is marked unreachable. */
  readonly unreachableAfterMs: number;
  /** Additional time after which an unreachable peer is declared down. */
  readonly downAfterMs: number;
}

export const defaultFailureDetectorSettings: FailureDetectorSettings = {
  heartbeatIntervalMs: 500,
  unreachableAfterMs: 2_000,
  downAfterMs: 5_000,
};

export type FailureDecision = 'healthy' | 'unreachable' | 'down';

interface Sample {
  lastSeen: number;
  everSeen: boolean;
}

/**
 * A simple, deterministic failure detector.  Every heartbeat bumps the
 * last-seen timestamp for a peer; the cluster periodically asks which peers
 * have fallen past the thresholds.  No φ-accrual / variance tracking — just
 * plain elapsed-time limits, which is sufficient for LAN-scale clusters.
 */
export class FailureDetector {
  private samples = new Map<string, Sample>();
  private readonly settings: FailureDetectorSettings;

  constructor(options: FailureDetectorOptions | Partial<FailureDetectorSettings> = {}) {
    // Unset builder fields fall through to the built-in defaults.
    this.settings = { ...defaultFailureDetectorSettings, ...(options as Partial<FailureDetectorSettings>) };
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
    if (elapsed >= this.settings.downAfterMs) return 'down';
    if (elapsed >= this.settings.unreachableAfterMs) return 'unreachable';
    return 'healthy';
  }

  lastSeen(peer: NodeAddress): Option<number> {
    return fromNullable(this.samples.get(peer.toString())?.lastSeen);
  }

  get interval(): number { return this.settings.heartbeatIntervalMs; }
}
