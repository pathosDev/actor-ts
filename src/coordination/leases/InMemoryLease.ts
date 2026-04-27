import type { Lease, LeaseSettings } from '../Lease.js';

interface LeaseRecord {
  readonly name: string;
  owner: string;
  expiresAt: number;
}

/** Global registry shared by all InMemoryLeases in the process — simulates a remote store. */
class InMemoryLeaseStore {
  private readonly leases = new Map<string, LeaseRecord>();

  /** Try to take the lease named `name` for `owner` until `expiresAt`. */
  tryAcquire(name: string, owner: string, expiresAt: number): boolean {
    const now = Date.now();
    const existing = this.leases.get(name);
    if (existing && existing.owner !== owner && existing.expiresAt > now) return false;
    this.leases.set(name, { name, owner, expiresAt });
    return true;
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
    const r = this.leases.get(name);
    if (r && r.expiresAt <= Date.now()) { this.leases.delete(name); return undefined; }
    return r;
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

  constructor(private readonly settings: LeaseSettings) {
    this.renewalIntervalMs = settings.renewalIntervalMs ?? Math.max(100, Math.floor(settings.ttlMs / 3));
  }

  async acquire(): Promise<boolean> {
    const retries = this.settings.acquireRetries ?? 1;
    const delay = this.settings.acquireRetryDelayMs ?? 50;
    for (let i = 0; i < retries; i++) {
      const expiresAt = Date.now() + this.settings.ttlMs;
      if (inMemoryLeaseStore.tryAcquire(this.settings.name, this.settings.owner, expiresAt)) {
        this.held = true;
        this.startRenewalLoop();
        return true;
      }
      if (i < retries - 1) await sleep(delay);
    }
    return false;
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    if (this.renewalTimer) { clearInterval(this.renewalTimer); this.renewalTimer = null; }
    inMemoryLeaseStore.release(this.settings.name, this.settings.owner);
  }

  checkAlive(): boolean { return this.held; }

  onLost(handler: (reason: string) => void): () => void {
    this.onLostHandlers.add(handler);
    return () => this.onLostHandlers.delete(handler);
  }

  private startRenewalLoop(): void {
    this.renewalTimer = setInterval(() => {
      if (!this.held) return;
      const expiresAt = Date.now() + this.settings.ttlMs;
      const ok = inMemoryLeaseStore.renew(this.settings.name, this.settings.owner, expiresAt);
      if (!ok) {
        this.held = false;
        if (this.renewalTimer) { clearInterval(this.renewalTimer); this.renewalTimer = null; }
        for (const h of this.onLostHandlers) {
          try { h('lease lost during renewal'); } catch { /* swallow */ }
        }
      }
    }, this.renewalIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
