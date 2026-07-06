import { NodeAddress } from './NodeAddress.js';
import { fromNullable, type Option } from '../util/Option.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';

export interface FailureDetectorSettings {
  /** How often the detector samples and decides membership health. */
  readonly heartbeatIntervalMs: number;
  /** Time without heartbeat after which a peer is marked unreachable. */
  readonly unreachableAfterMs: number;
  /** Additional time after which an unreachable peer is declared down. */
  readonly downAfterMs: number;
}

/**
 * Fluent builder for {@link FailureDetectorSettings}.  Unset fields fall
 * through to {@link defaultFailureDetectorSettings} in the consumer, so a
 * bare `FailureDetectorOptions.create()` yields the defaults.
 *
 *     new FailureDetector(
 *       FailureDetectorOptions.create().withUnreachableAfterMs(3_000),
 *     )
 */
export class FailureDetectorOptions extends OptionsBuilder<FailureDetectorSettings> {
  /** Start a fresh builder.  Equivalent to `new FailureDetectorOptions()`. */
  static create(): FailureDetectorOptions {
    return new FailureDetectorOptions();
  }

  /** How often the detector samples and decides membership health. */
  withHeartbeatIntervalMs(ms: number): this {
    return this.set('heartbeatIntervalMs', ms);
  }

  /** Time without heartbeat after which a peer is marked unreachable. */
  withUnreachableAfterMs(ms: number): this {
    return this.set('unreachableAfterMs', ms);
  }

  /** Additional time after which an unreachable peer is declared down. */
  withDownAfterMs(ms: number): this {
    return this.set('downAfterMs', ms);
  }
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

  constructor(options: FailureDetectorOptions = FailureDetectorOptions.create()) {
    // Unset builder fields fall through to the built-in defaults.
    this.settings = { ...defaultFailureDetectorSettings, ...options.build() };
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
