import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { PersistentEvent } from '../JournalTypes.js';
import type { LiveQueryOptions, PersistenceQuery } from '../query/PersistenceQuery.js';
import type { OffsetStore } from './OffsetStore.js';

/** Plain options-object shape shared by every projection. */
export interface ProjectionOptionsType<E> {
  /** Logical name — used as the offset-store key prefix. */
  readonly name: string;
  /** The query layer (one of `InMemoryQuery`, `SqliteQuery`, …). */
  readonly query: PersistenceQuery;
  /** Where to persist the cursor.  Default: in-memory (lost on restart). */
  readonly offsetStore?: OffsetStore;
  /** User handler — runs once per event.  Must be idempotent. */
  readonly handle: (event: PersistentEvent<E>) => void | Promise<void>;
  /** Tunables passed to the underlying live query. */
  readonly liveOptions?: LiveQueryOptions;
}

/** Options for a per-persistenceId projection.  One cursor per pid. */
export interface ByPersistenceIdProjectionOptionsType<E> extends ProjectionOptionsType<E> {
  readonly persistenceId: string;
}

/** Options for a per-tag projection.  One cursor per tag. */
export interface ByTagProjectionOptionsType<E> extends ProjectionOptionsType<E> {
  readonly tag: string;
}

/**
 * Fluent builder for the fields shared by every projection.  The
 * concrete {@link ByPersistenceIdProjectionOptions} / {@link ByTagProjectionOptions}
 * subclasses add the discriminating cursor field (`persistenceId` / `tag`)
 * on top of these.
 */
export class ProjectionOptionsBuilder<E> extends OptionsBuilder<ProjectionOptionsType<E>> {
  /** Start a fresh builder.  Equivalent to `new ProjectionOptionsBuilder<E>()`. */
  static create<E>(): ProjectionOptionsBuilder<E> {
    return new ProjectionOptionsBuilder<E>();
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
 * Accepted input for a shared projection: the fluent
 * {@link ProjectionOptionsBuilder} OR a plain {@link ProjectionOptionsType} object.
 */
export type ProjectionOptions<E> = ProjectionOptionsBuilder<E> | Partial<ProjectionOptionsType<E>>;
/** Value alias so `ProjectionOptions.create()` / `new ProjectionOptions()` resolve to the builder. */
export const ProjectionOptions = ProjectionOptionsBuilder;

/**
 * Fluent builder for {@link ByPersistenceIdProjectionOptionsType} — a per-persistenceId
 * projection.  Adds `withPersistenceId` to the shared projection fields.
 */
export class ByPersistenceIdProjectionOptionsBuilder<E> extends OptionsBuilder<ByPersistenceIdProjectionOptionsType<E>> {
  /** Start a fresh builder.  Equivalent to `new ByPersistenceIdProjectionOptionsBuilder<E>()`. */
  static create<E>(): ByPersistenceIdProjectionOptionsBuilder<E> {
    return new ByPersistenceIdProjectionOptionsBuilder<E>();
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
 * Accepted input for a by-persistenceId projection: the fluent
 * {@link ByPersistenceIdProjectionOptionsBuilder} OR a plain
 * {@link ByPersistenceIdProjectionOptionsType} object.
 */
export type ByPersistenceIdProjectionOptions<E> = ByPersistenceIdProjectionOptionsBuilder<E> | Partial<ByPersistenceIdProjectionOptionsType<E>>;
/** Value alias so `ByPersistenceIdProjectionOptions.create()` / `new ByPersistenceIdProjectionOptions()` resolve to the builder. */
export const ByPersistenceIdProjectionOptions = ByPersistenceIdProjectionOptionsBuilder;

/**
 * Fluent builder for {@link ByTagProjectionOptionsType} — a per-tag projection.
 * Adds `withTag` to the shared projection fields.
 */
export class ByTagProjectionOptionsBuilder<E> extends OptionsBuilder<ByTagProjectionOptionsType<E>> {
  /** Start a fresh builder.  Equivalent to `new ByTagProjectionOptionsBuilder<E>()`. */
  static create<E>(): ByTagProjectionOptionsBuilder<E> {
    return new ByTagProjectionOptionsBuilder<E>();
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

/**
 * Accepted input for a by-tag projection: the fluent
 * {@link ByTagProjectionOptionsBuilder} OR a plain
 * {@link ByTagProjectionOptionsType} object.
 */
export type ByTagProjectionOptions<E> = ByTagProjectionOptionsBuilder<E> | Partial<ByTagProjectionOptionsType<E>>;
/** Value alias so `ByTagProjectionOptions.create()` / `new ByTagProjectionOptions()` resolve to the builder. */
export const ByTagProjectionOptions = ByTagProjectionOptionsBuilder;
