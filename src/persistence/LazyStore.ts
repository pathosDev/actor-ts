import { JournalError } from './JournalTypes.js';

/** Wiring every lazily-opened persistence store needs, whatever it connects to. */
export interface LazyStoreConfig<TResource> {
  /**
   * Concrete store name (`'PostgresJournal'`, `'MongoJournal'`), used to prefix
   * every error message.  Errors name the store the caller actually constructed
   * rather than the shared base, which is what makes a stack-free log line
   * useful.
   */
  readonly storeName: string;
  /**
   * Whether this store opened the resource itself.  An injected pool or client
   * — shared across the journal, snapshot and durable-state stores by the
   * register helpers, or a fake in tests — is owned by the caller, and
   * releasing it here would tear it out from under the siblings.
   */
  readonly ownsResource: boolean;
  /** Open the pool / client / connection.  Called once, lazily, on first use. */
  openResource(): Promise<TResource>;
}

/**
 * Lifecycle shared by every store that talks to an external system: lazy
 * first-use connection, one-shot schema preparation, and ownership-aware
 * teardown.
 *
 * Construction stays synchronous and side-effect-free — `new PostgresJournal(…)`
 * must not connect — so the resource opens on the first operation and the
 * in-flight promise is memoized to keep concurrent first calls to a single
 * init.  Getting that memoization subtly wrong (racing DDL, two pools where one
 * was intended) is the kind of bug that only shows up under load, which is why
 * it lives in one place.
 *
 * `TResource` is whatever the backend family talks to: a `SqlPool` for the
 * relational stores, a database handle plus its client for MongoDB.  The base
 * deliberately knows nothing about it beyond how to prepare and release it.
 */
export abstract class LazyStore<TResource> {
  /** Concrete store name — subclasses prefix their own argument errors with it. */
  protected readonly storeName: string;
  private readonly ownsResource: boolean;
  private readonly openResource: () => Promise<TResource>;

  private resource: TResource | null = null;
  private initPromise: Promise<void> | null = null;
  private closed = false;

  protected constructor(config: LazyStoreConfig<TResource>) {
    this.storeName = config.storeName;
    this.ownsResource = config.ownsResource;
    this.openResource = () => config.openResource();
  }

  /**
   * One-shot schema setup — tables, indexes — run inside the memoized init, so
   * exactly once even under concurrent first calls.  A store whose
   * `autoCreate…` option is off should make this a no-op rather than skip the
   * hook.
   */
  protected abstract prepare(resource: TResource): Promise<void>;

  /** Release the resource: end the pool, close the client.  Only called when owned. */
  protected abstract release(resource: TResource): Promise<void>;

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsResource && this.resource !== null) {
      // Teardown is best-effort: a failure here must not mask whatever the
      // caller was actually shutting down.
      try { await this.release(this.resource); } catch { /* ignore */ }
    }
    this.resource = null;
  }

  protected async ensureOpen(): Promise<TResource> {
    if (this.closed) throw new JournalError(`${this.storeName} is closed`);
    if (this.resource !== null) return this.resource;
    if (!this.initPromise) this.initPromise = this.init();
    await this.initPromise;
    return this.resource!;
  }

  /** Wrap a driver error as `JournalError`, naming the concrete store and method. */
  protected fail(method: string, error: unknown): never {
    throw new JournalError(`${this.storeName}.${method} failed: ${(error as Error).message}`, error);
  }

  private async init(): Promise<void> {
    const resource = await this.openResource();
    await this.prepare(resource);
    this.resource = resource;
  }
}
