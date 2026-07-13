import type { Lease } from '../Lease.js';
import type { LeaseOptions, LeaseOptionsType } from '../LeaseOptions.js';

interface LeaseRecord {
  readonly name: string;
  owner: string;
  expiresAt: number;
  /** Monotonic counter bumped on every (re)acquire — backs the fencing token. */
  version: number;
}

/** Global registry shared by all InMemoryLeases in the process — simulates a remote store. */
class InMemoryLeaseStore {
  private readonly leases = new Map<string, LeaseRecord>();

  /** Try to take the lease named `name` for `owner` until `expiresAt`.
   *  Returns the new version number on success, or 0 on failure. */
  tryAcquire(name: string, owner: string, expiresAt: number): number {
    const now = Date.now();
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

  peek(name: string): LeaseRecord | undefined {
    const lease = this.leases.get(name);
    if (lease && lease.expiresAt <= Date.now()) { this.leases.delete(name); return undefined; }
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
 */
export class InMemoryLease implements Lease {
  private readonly renewalIntervalMs: number;
  private renewalTimer: ReturnType<typeof setInterval> | null = null;
  private held = false;
  private readonly onLostHandlers = new Set<(reason: string) => void>();

  private readonly options: LeaseOptionsType;

  constructor(options: LeaseOptions = {}) {
    this.options = options as LeaseOptionsType;
    this.renewalIntervalMs = this.options.renewalIntervalMs ?? Math.max(100, Math.floor(this.options.ttlMs / 3));
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
      const expiresAt = Date.now() + this.options.ttlMs;
      const version = inMemoryLeaseStore.tryAcquire(this.options.name, this.options.owner, expiresAt);
      if (version > 0) {
        this.held = true;
        this.startRenewalLoop();
        return { token: `${this.options.name}@v${version}` };
      }
      if (i < retries - 1) await sleep(delay);
    }
    return null;
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    if (this.renewalTimer) { clearInterval(this.renewalTimer); this.renewalTimer = null; }
    inMemoryLeaseStore.release(this.options.name, this.options.owner);
  }

  checkAlive(): boolean { return this.held; }

  onLost(handler: (reason: string) => void): () => void {
    this.onLostHandlers.add(handler);
    return () => this.onLostHandlers.delete(handler);
  }

  private startRenewalLoop(): void {
    this.renewalTimer = setInterval(() => {
      if (!this.held) return;
      const expiresAt = Date.now() + this.options.ttlMs;
      const ok = inMemoryLeaseStore.renew(this.options.name, this.options.owner, expiresAt);
      if (!ok) {
        this.held = false;
        if (this.renewalTimer) { clearInterval(this.renewalTimer); this.renewalTimer = null; }
        for (const handler of this.onLostHandlers) {
          try { handler('lease lost during renewal'); } catch { /* swallow */ }
        }
      }
    }, this.renewalIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
