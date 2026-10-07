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

  /**
   * Extend `owner`'s record named `name` to `expiresAt`.  False when the record
   * is gone, belongs to someone else, or has already lapsed at `now`.
   *
   * The lapse check is the half that matters (#937): a lapsed record is free for
   * any other owner to take, so extending it would hand it back to a holder that
   * could not keep it — after a stall longer than the TTL, the one case renewal
   * exists to catch.  `now` is the caller's clock reading, as in {@link tryAcquire}.
   */
  renew(name: string, owner: string, expiresAt: number, now: number): boolean {
    const existing = this.leases.get(name);
    if (!existing || existing.owner !== owner || existing.expiresAt <= now) return false;
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
  /**
   * When the record this holder last wrote runs out, on {@link clock}.
   *
   * `checkAlive()` compares against it rather than trusting {@link held} alone
   * (#937): `held` is only cleared by a renewal that notices the loss, and a
   * stalled event loop is precisely what keeps that renewal from running.
   */
  private expiresAt = 0;
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
    // A third of the TTL with a 100 ms floor, and never more than half of it: a
    // renewal that only comes round after the record lapsed gives the lease up
    // (#937), so the floor alone would lose any TTL of 100 ms or less on its
    // first tick.  An interval set explicitly is taken as given.
    this.renewalIntervalMs = this.options.renewalIntervalMs ?? Math.max(
      1,
      Math.min(Math.max(100, Math.floor(this.options.ttlMs / 3)), Math.floor(this.options.ttlMs / 2)),
    );
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
        this.expiresAt = expiresAt;
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

  /**
   * Held, and the record this holder last wrote has not run out.  Turns false
   * at the deadline itself — the instant the store lets another owner in —
   * whether or not a renewal has run since to notice (#937).
   */
  checkAlive(): boolean { return this.held && this.clock.now() < this.expiresAt; }

  onLost(handler: (reason: string) => void): () => void {
    this.onLostHandlers.add(handler);
    return () => this.onLostHandlers.delete(handler);
  }

  /**
   * Arm the renewal loop — once.  A re-`acquire()` on a lease this instance
   * already holds keeps the loop it has: arming a second would overwrite the
   * handle and leave the first armed for good — past `release()`, where it
   * fires on nothing but keeps a real-timer process alive, and renewing again
   * beside the second loop after the next acquire.  `LeaseMajority`
   * re-acquires exactly like that, since it never releases a lease it won.
   */
  private startRenewalLoop(): void {
    if (this.renewalTimer !== null) return;
    const renew = (): void => {
      if (!this.held) return;
      const now = this.clock.now();
      // A renewal that comes round after the deadline has nothing left to renew:
      // the record lapsed while this holder was not looking, and another owner
      // may already hold it (#937).
      if (now >= this.expiresAt) {
        this.lose(`lease expired before it could be renewed (${now - this.expiresAt} ms past its deadline)`);
        return;
      }
      const expiresAt = now + this.options.ttlMs;
      if (inMemoryLeaseStore.renew(this.options.name, this.options.owner, expiresAt, now)) {
        this.expiresAt = expiresAt;
        return;
      }
      this.lose('lease lost during renewal');
    };
    this.renewalTimer = this.scheduler === null
      ? setInterval(renew, this.renewalIntervalMs)
      : this.scheduler.scheduleAtFixedRateFunction(
        this.renewalIntervalMs, this.renewalIntervalMs, renew,
      );
  }

  /** Give the lease up and tell every `onLost` handler why. */
  private lose(reason: string): void {
    this.held = false;
    this.stopRenewalLoop();
    for (const handler of this.onLostHandlers) {
      try { handler(reason); } catch { /* swallow */ }
    }
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
