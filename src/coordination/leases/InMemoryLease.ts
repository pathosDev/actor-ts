import type { Clock } from '../../Clock.js';
import { systemClock } from '../../Clock.js';
import type { Cancellable, Scheduler } from '../../Scheduler.js';
import type { Lease } from '../Lease.js';
import { LeaseOptionsValidator, withLeaseConfigDefaults } from '../LeaseOptions.js';
import type { LeaseOptions, LeaseOptionsType } from '../LeaseOptions.js';

type LeaseRecord = {
  readonly name: string;
  owner: string;
  expiresAt: number;
  /** Monotonic counter bumped on every (re)acquire — backs the fencing token. */
  version: number;
};

/** Global registry shared by all InMemoryLeases in the process — simulates a remote store. */
class InMemoryLeaseStore {
  private readonly leases = new Map<string, LeaseRecord>();

  /**
   * Try to take the lease named `name` for `owner` until `expiresAt`.
   * Returns the new version number on success, or 0 on failure.
   *
   * `now` is a parameter rather than a clock read because the store is a
   * process-wide singleton every lease competes against, so it has no clock of
   * its own to consult — two leases in one test may legitimately be reading
   * different ones. The caller knows which clock it is holding (#1424).
   */
  tryAcquire(name: string, owner: string, expiresAt: number, now: number): number {
    const existing = this.leases.get(name);
    if (existing && existing.owner !== owner && existing.expiresAt > now) return 0;
    const version = (existing?.version ?? 0) + 1;
    this.leases.set(name, { name, owner, expiresAt, version });
    return version;
  }

  renew(name: string, owner: string, expiresAt: number): boolean {
    const existing = this.leases.get(name);
    if (!existing || existing.owner !== owner) return false;
    existing.expiresAt = expiresAt;
    return true;
  }

  release(name: string, owner: string): void {
    const existing = this.leases.get(name);
    if (existing && existing.owner === owner) this.leases.delete(name);
  }

  /** @param now The caller's clock reading — see {@link tryAcquire}. */
  peek(name: string, now: number = Date.now()): LeaseRecord | undefined {
    const lease = this.leases.get(name);
    if (lease && lease.expiresAt <= now) { this.leases.delete(name); return undefined; }
    return lease;
  }

  /** Reset — only for tests. */
  _clear(): void { this.leases.clear(); }
}

/** Singleton store — all in-process InMemoryLeases compete against it. */
export const inMemoryLeaseStore = new InMemoryLeaseStore();

/**
 * Reference Lease implementation backed by the shared in-memory store.
 * Useful for tests and single-process development.  The store is a plain
 * JS Map, so it is NOT appropriate for multi-process deployments — use
 * `KubernetesLease` for that.
 *
 * `name`, `owner` and `ttlMs` are required: the constructor rejects a
 * missing one with `OptionsError` (#596).  Without an `owner` two leases
 * would compete under the same `undefined` holder and both win; without
 * `ttlMs` the expiry is `NaN`, which compares false against every clock
 * reading and has the same effect.
 */
export class InMemoryLease implements Lease {
  private readonly renewalIntervalMs: number;
  private renewalTimer: Cancellable | ReturnType<typeof setInterval> | null = null;

  /** Where the TTL is measured.  The scheduler when one was given, else the wall clock. */
  private readonly clock: Clock;
  /** The same object when one was given, `null` when none was — see {@link clock}. */
  private readonly scheduler: Scheduler | null;
  private held = false;
  private readonly onLostHandlers = new Set<(reason: string) => void>();

  private readonly options: LeaseOptionsType;

  constructor(options: LeaseOptions = {}) {
    // HOCON layers UNDER the caller's options and ABOVE the built-in defaults,
    // and it is applied before validation so a bad `ttl` in a config file is
    // rejected exactly like a bad one in code (#859).  Neither key it can
    // supply ships a leaf in `reference.conf`, so an unconfigured process
    // still reaches `validateRequired` with `ttlMs` missing (#596).
    this.options = withLeaseConfigDefaults(options as LeaseOptionsType);
    // Required-ness first, domain validity second — a missing field must be
    // reported as missing, not as a domain violation of `undefined`.
    const validator = new LeaseOptionsValidator();
    validator.validateRequired(this.options);
    validator.validate(this.options);
    this.renewalIntervalMs = this.options.renewalIntervalMs ?? Math.max(100, Math.floor(this.options.ttlMs / 3));
    this.scheduler = this.options.scheduler ?? null;
    this.clock = this.scheduler ?? systemClock;
  }

  async acquire(): Promise<boolean> {
    return (await this.acquireWithToken()) !== null;
  }

  /**
   * Fencing-token variant: returns a monotonic version string scoped
   * to this lease name.  The token is `<lease-name>@v<version>` —
   * suitable for use as an opaque identifier and ordered by parsing
   * the trailing `<version>` integer.
   */
  async acquireWithToken(): Promise<{ readonly token: string } | null> {
    const retries = this.options.acquireRetries ?? 1;
    const delay = this.options.acquireRetryDelayMs ?? 50;
    for (let i = 0; i < retries; i++) {
      const now = this.clock.now();
      const expiresAt = now + this.options.ttlMs;
      const version = inMemoryLeaseStore.tryAcquire(
        this.options.name, this.options.owner, expiresAt, now,
      );
      if (version > 0) {
        this.held = true;
        this.startRenewalLoop();
        return { token: `${this.options.name}@v${version}` };
      }
      if (i < retries - 1) await sleep(delay, this.scheduler);
    }
    return null;
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    this.stopRenewalLoop();
    inMemoryLeaseStore.release(this.options.name, this.options.owner);
  }

  checkAlive(): boolean { return this.held; }

  onLost(handler: (reason: string) => void): () => void {
    this.onLostHandlers.add(handler);
    return () => this.onLostHandlers.delete(handler);
  }

  private startRenewalLoop(): void {
    const renew = (): void => {
      if (!this.held) return;
      const ok = inMemoryLeaseStore.renew(
        this.options.name, this.options.owner, this.clock.now() + this.options.ttlMs,
      );
      if (ok) return;
      this.held = false;
      this.stopRenewalLoop();
      for (const handler of this.onLostHandlers) {
        try { handler('lease lost during renewal'); } catch { /* swallow */ }
      }
    };
    this.renewalTimer = this.scheduler === null
      ? setInterval(renew, this.renewalIntervalMs)
      : this.scheduler.scheduleAtFixedRateFunction(
        this.renewalIntervalMs, this.renewalIntervalMs, renew,
      );
  }

  /** Disarm whichever kind of handle {@link startRenewalLoop} produced. */
  private stopRenewalLoop(): void {
    if (this.renewalTimer === null) return;
    if (typeof (this.renewalTimer as Cancellable).cancel === 'function') {
      (this.renewalTimer as Cancellable).cancel();
    } else {
      clearInterval(this.renewalTimer as ReturnType<typeof setInterval>);
    }
    this.renewalTimer = null;
  }
}

function sleep(ms: number, scheduler: Scheduler | null): Promise<void> {
  if (scheduler === null) return new Promise((r) => setTimeout(r, ms));
  return new Promise((r) => { scheduler.scheduleOnceFunction(ms, () => { r(); }); });
}
