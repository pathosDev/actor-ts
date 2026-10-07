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
  /**
   * Open the pool / client / connection.  Called lazily on first use, and
   * again only after an attempt failed — a successful open is kept until
   * `close()`.
   */
  openResource(): Promise<TResource>;
}

/**
 * Lifecycle shared by every store that talks to an external system: lazy
 * first-use connection, one-shot schema preparation, and ownership-aware
 * teardown.
 *
 * Construction stays synchronous and side-effect-free — `new PostgresJournal(…)`
 * must not connect — so the resource opens on the first operation, or on
 * {@link LazyStore.start}, its eager twin, and the in-flight promise is
 * memoized to keep concurrent first calls to a single init.  Getting that memoization subtly wrong (racing DDL, two pools where one
 * was intended) is the kind of bug that only shows up under load, which is why
 * it lives in one place.
 *
 * The memo covers an open **while it runs**, and a successful one after that —
 * never a failed one (#1473).  A rejected open used to stay memoized, so one
 * database blip at a store's first use failed every persist and every recovery
 * on that node for the life of the process; now the callers that shared the
 * failing attempt see its rejection and the next call opens afresh.  A failed
 * attempt holds nothing: a resource whose `prepare` failed is released (when
 * owned) before the rejection surfaces.
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
  /** The open in flight (or the one that succeeded); cleared again when an attempt fails. */
  private initPromise: Promise<void> | null = null;
  private closed = false;

  protected constructor(config: LazyStoreConfig<TResource>) {
    this.storeName = config.storeName;
    this.ownsResource = config.ownsResource;
    this.openResource = () => config.openResource();
  }

  /**
   * One-shot schema setup — tables, indexes — run inside the memoized init, so
   * exactly once per successful open even under concurrent first calls.  A
   * store whose `autoCreate…` option is off should make this a no-op rather
   * than skip the hook.  A failure here releases an owned resource before the
   * open rejects, and the next call runs the whole open again.
   */
  protected abstract prepare(resource: TResource): Promise<void>;

  /** Release the resource: end the pool, close the client.  Only called when owned. */
  protected abstract release(resource: TResource): Promise<void>;

  /**
   * Open the resource now instead of on the first operation — the eager half
   * of the lazy open, for a boot-time warm-up that should fail at startup on a
   * bad connection string rather than at the first persisted message (#1473).
   *
   * It is the same single-flight open the first operation runs: a `start()`
   * racing an operation, or another `start()`, shares one open, and once open
   * a further call touches nothing.  A failed start holds nothing and is not
   * remembered, so calling it again retries; after `close()` it rejects with
   * the "is closed" `JournalError` every operation does.
   */
  async start(): Promise<void> {
    await this.ensureOpen();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // An open still in flight either notices the close and releases what it
    // opened itself (see `init`), or finishes and leaves its resource to the
    // release below.  Waiting for it is what makes a resolved `close()` mean
    // that nothing is left open behind the store.
    const pending = this.initPromise;
    if (pending !== null) {
      try { await pending; } catch { /* that failure belongs to the caller that started the open */ }
    }
    const resource = this.resource;
    this.resource = null;
    if (resource !== null) await this.releaseIfOwned(resource);
  }

  protected async ensureOpen(): Promise<TResource> {
    if (this.closed) throw this.closedError();
    if (this.resource !== null) return this.resource;
    if (this.initPromise === null) {
      this.initPromise = this.init().catch((e: unknown) => {
        // Not remembered: the callers that shared this attempt get its
        // rejection, and the next call opens afresh.
        this.initPromise = null;
        throw e;
      });
    }
    await this.initPromise;
    // A close() that ran while this caller waited has released the resource,
    // or is about to — handing it out now would hand out a dead pool.
    const resource = this.resource;
    if (this.closed || resource === null) throw this.closedError();
    return resource;
  }

  /** Wrap a driver error as `JournalError`, naming the concrete store and method. */
  protected fail(method: string, error: unknown): never {
    throw new JournalError(`${this.storeName}.${method} failed: ${(error as Error).message}`, error);
  }

  private async init(): Promise<void> {
    const resource = await this.openResource();
    try {
      // No DDL against a store that was closed while it connected.  A close()
      // that arrives during `prepare` needs no check here: it waits for this
      // open and releases whatever it assigned.
      if (this.closed) throw this.closedError();
      await this.prepare(resource);
    } catch (e) {
      // Half-opened: release it here, because nothing else holds a reference
      // to it — `this.resource` is only assigned to a prepared resource.
      await this.releaseIfOwned(resource);
      throw e;
    }
    this.resource = resource;
  }

  private async releaseIfOwned(resource: TResource): Promise<void> {
    if (!this.ownsResource) return;
    // Teardown is best-effort: a failure here must not mask whatever the
    // caller was actually doing — shutting down, or reporting why the open
    // failed.
    try { await this.release(resource); } catch { /* ignore */ }
  }

  private closedError(): JournalError {
    return new JournalError(`${this.storeName} is closed`);
  }
}
