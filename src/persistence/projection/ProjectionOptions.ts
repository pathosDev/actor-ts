import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { PersistentEvent } from '../JournalTypes.js';
import type { LiveQueryOptions, PersistenceQuery } from '../query/PersistenceQuery.js';
import type { OffsetStore } from './OffsetStore.js';
import type { ProjectionSettings, ByPidSettings, ByTagSettings } from './ProjectionActor.js';

/**
 * Fluent builder for the fields shared by every projection.  The
 * concrete {@link ByPidProjectionOptions} / {@link ByTagProjectionOptions}
 * subclasses add the discriminating cursor field (`persistenceId` / `tag`)
 * on top of these.
 */
export class ProjectionOptions<E> extends OptionsBuilder<ProjectionSettings<E>> {
  /** Start a fresh builder.  Equivalent to `new ProjectionOptions<E>()`. */
  static create<E>(): ProjectionOptions<E> {
    return new ProjectionOptions<E>();
  }

  /** Logical name — used as the offset-store key prefix. */
  withName(name: string): this {
    return this.set('name', name);
  }

  /** The query layer (one of `InMemoryQuery`, `SqliteQuery`, …). */
  withQuery(query: PersistenceQuery): this {
    return this.set('query', query);
  }

  /** Where to persist the cursor.  Default: in-memory (lost on restart). */
  withOffsetStore(offsetStore: OffsetStore): this {
    return this.set('offsetStore', offsetStore);
  }

  /** User handler — runs once per event.  Must be idempotent. */
  withHandle(handle: (event: PersistentEvent<E>) => void | Promise<void>): this {
    return this.set('handle', handle);
  }

  /** Tunables passed to the underlying live query. */
  withLiveOptions(liveOptions: LiveQueryOptions): this {
    return this.set('liveOptions', liveOptions);
  }
}

/**
 * Fluent builder for {@link ByPidSettings} — a per-persistenceId
 * projection.  Adds `withPersistenceId` to the shared projection fields.
 */
export class ByPidProjectionOptions<E> extends OptionsBuilder<ByPidSettings<E>> {
  /** Start a fresh builder.  Equivalent to `new ByPidProjectionOptions<E>()`. */
  static create<E>(): ByPidProjectionOptions<E> {
    return new ByPidProjectionOptions<E>();
  }

  /** Logical name — used as the offset-store key prefix. */
  withName(name: string): this {
    return this.set('name', name);
  }

  /** The query layer (one of `InMemoryQuery`, `SqliteQuery`, …). */
  withQuery(query: PersistenceQuery): this {
    return this.set('query', query);
  }

  /** Where to persist the cursor.  Default: in-memory (lost on restart). */
  withOffsetStore(offsetStore: OffsetStore): this {
    return this.set('offsetStore', offsetStore);
  }

  /** User handler — runs once per event.  Must be idempotent. */
  withHandle(handle: (event: PersistentEvent<E>) => void | Promise<void>): this {
    return this.set('handle', handle);
  }

  /** Tunables passed to the underlying live query. */
  withLiveOptions(liveOptions: LiveQueryOptions): this {
    return this.set('liveOptions', liveOptions);
  }

  /** The entity whose event log this projection follows.  One cursor per pid. */
  withPersistenceId(persistenceId: string): this {
    return this.set('persistenceId', persistenceId);
  }
}

/**
 * Fluent builder for {@link ByTagSettings} — a per-tag projection.  Adds
 * `withTag` to the shared projection fields.
 */
export class ByTagProjectionOptions<E> extends OptionsBuilder<ByTagSettings<E>> {
  /** Start a fresh builder.  Equivalent to `new ByTagProjectionOptions<E>()`. */
  static create<E>(): ByTagProjectionOptions<E> {
    return new ByTagProjectionOptions<E>();
  }

  /** Logical name — used as the offset-store key prefix. */
  withName(name: string): this {
    return this.set('name', name);
  }

  /** The query layer (one of `InMemoryQuery`, `SqliteQuery`, …). */
  withQuery(query: PersistenceQuery): this {
    return this.set('query', query);
  }

  /** Where to persist the cursor.  Default: in-memory (lost on restart). */
  withOffsetStore(offsetStore: OffsetStore): this {
    return this.set('offsetStore', offsetStore);
  }

  /** User handler — runs once per event.  Must be idempotent. */
  withHandle(handle: (event: PersistentEvent<E>) => void | Promise<void>): this {
    return this.set('handle', handle);
  }

  /** Tunables passed to the underlying live query. */
  withLiveOptions(liveOptions: LiveQueryOptions): this {
    return this.set('liveOptions', liveOptions);
  }

  /** The tag this projection follows across the whole journal.  One cursor per tag. */
  withTag(tag: string): this {
    return this.set('tag', tag);
  }
}
