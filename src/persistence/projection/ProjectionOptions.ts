import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { PersistentEvent } from '../JournalTypes.js';
import type { LiveQueryOptions, PersistenceQuery, TagFilter } from '../query/PersistenceQuery.js';
import type { OffsetStore } from './OffsetStore.js';

/* ---------------------- handler-failure recovery ---------------------- */

/**
 * What a projection does when the user `handle` callback throws.
 *
 * The four values are the cross product of the only two decisions there
 * are: whether to try the same event again, and what to do once trying is
 * over.  Everything a projection can sensibly do about a bad event is one
 * of them — which is the point, because what the framework shipped with was
 * an unnamed fifth: retry forever.  The cursor only advances after a
 * successful `handle`, so one poison event blocked every event behind it
 * indefinitely while the failure was re-logged once per poll (#650).
 *
 *   - `fail` — stop the projection at the offending event.  The cursor
 *     stays put, so a restart resumes exactly there once the cause is
 *     fixed.  Nothing is silently dropped and nothing is silently stale.
 *   - `skip` — step over the offending event, publish it as a dead letter,
 *     and carry on.  Trades a hole in the read model for liveness.
 *   - `retry-and-fail` — retry with exponential backoff, then `fail`.
 *   - `retry-and-skip` — retry with exponential backoff, then `skip`.
 */
export type ProjectionRecoveryStrategy =
  | 'fail'
  | 'skip'
  | 'retry-and-fail'
  | 'retry-and-skip';

/** Every accepted {@link ProjectionRecoveryStrategy} — the set the validator checks against. */
export const PROJECTION_RECOVERY_STRATEGIES: readonly ProjectionRecoveryStrategy[] = [
  'fail',
  'skip',
  'retry-and-fail',
  'retry-and-skip',
];

/** What a projection actually did about one handler failure. */
export type ProjectionFailureAction = 'retry' | 'skip' | 'stop';

/**
 * Everything an application needs to act on a projection handler failure,
 * handed to {@link ProjectionOptionsType.onFailure}.
 *
 * Carries the offending event and not just the error, because the event is
 * the part the application cannot recover for itself: by the time the hook
 * runs the projection may already have stepped past it, and nothing else in
 * the process still names which one it was.
 */
export type ProjectionFailure<E> = {
  /** The projection's `name`. */
  readonly projection: string;
  /** The event whose handler threw. */
  readonly event: PersistentEvent<E>;
  /** Whatever `handle` threw — not necessarily an `Error`. */
  readonly error: unknown;
  /** 1 on the first failure for this event, 2 on the first retry, and so on. */
  readonly attempt: number;
  /** What the configured strategy did about it. */
  readonly action: ProjectionFailureAction;
};

/**
 * Default {@link ProjectionRecoveryStrategy}.
 *
 * Deliberately not `fail`.  A projection is a background pull loop feeding a
 * read model, and the overwhelmingly common failure is transient — the read
 * model is restarting, a pooled connection was reset.  Stopping on the first
 * blip would make every read-model deploy a dead projection that nobody
 * notices until the view is visibly stale.  Retrying and *then* stopping
 * keeps transient faults invisible while still refusing to spin forever on a
 * genuine poison event.
 */
export const DEFAULT_PROJECTION_RECOVERY_STRATEGY: ProjectionRecoveryStrategy = 'retry-and-fail';

/** Default retry budget for the two `retry-*` strategies — attempts *after* the first. */
export const DEFAULT_PROJECTION_MAX_RETRIES = 3;

/** First retry delay in milliseconds; doubles per attempt up to {@link DEFAULT_PROJECTION_MAX_RETRY_BACKOFF_MS}. */
export const DEFAULT_PROJECTION_RETRY_BACKOFF_MS = 1_000;

/**
 * Ceiling on the retry delay, in milliseconds.
 *
 * The delay doubles, so an uncapped `retry-and-skip` with a generous budget
 * would eventually schedule its next attempt hours out — at which point the
 * projection is indistinguishable from a stopped one for anybody watching.
 */
export const DEFAULT_PROJECTION_MAX_RETRY_BACKOFF_MS = 60_000;

/** The handler-failure half of a projection's settings, with every field resolved. */
export type ProjectionRecoveryOptionsType = {
  readonly recoveryStrategy: ProjectionRecoveryStrategy;
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly maxRetryBackoffMs: number;
};

/** Built-in defaults for {@link ProjectionRecoveryOptionsType}. */
export const defaultProjectionRecoveryOptions: ProjectionRecoveryOptionsType = {
  recoveryStrategy: DEFAULT_PROJECTION_RECOVERY_STRATEGY,
  maxRetries: DEFAULT_PROJECTION_MAX_RETRIES,
  retryBackoffMs: DEFAULT_PROJECTION_RETRY_BACKOFF_MS,
  maxRetryBackoffMs: DEFAULT_PROJECTION_MAX_RETRY_BACKOFF_MS,
};

/* ---------------------------- options shapes -------------------------- */

/** Plain options-object shape shared by every projection. */
export type ProjectionOptionsType<E> = {
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
  /** What to do when `handle` throws.  Default: {@link DEFAULT_PROJECTION_RECOVERY_STRATEGY}. */
  readonly recoveryStrategy?: ProjectionRecoveryStrategy;
  /** Retries after the first attempt, for the `retry-*` strategies.  Default: 3. */
  readonly maxRetries?: number;
  /** First retry delay in ms; doubles per attempt.  Default: 1000. */
  readonly retryBackoffMs?: number;
  /** Ceiling on the doubling retry delay, in ms.  Default: 60000. */
  readonly maxRetryBackoffMs?: number;
  /**
   * Called for every handler failure, with the offending event and what the
   * strategy did about it.  The structured counterpart to the log line —
   * this is what an application wires to its own alerting or dead-letter
   * table.  Exceptions out of the hook are logged and swallowed: a broken
   * reporter must not be able to take the projection down with it.
   */
  readonly onFailure?: (failure: ProjectionFailure<E>) => void;
};

/** Options for a per-persistenceId projection.  One cursor per pid. */
export interface ByPersistenceIdProjectionOptionsType<E> extends ProjectionOptionsType<E> {
  readonly persistenceId: string;
}

/**
 * Options for a per-tag projection.  One cursor per filter.
 *
 * `tag` takes the full {@link TagFilter}, not just a single tag string — the
 * query layer has supported `all` / `any` / `not` since it was written, and a
 * projection was the one consumer still restricted to one tag, which meant
 * "every order that is not cancelled" needed a hand-rolled projection instead
 * of a filter.  A bare string still works and keeps its existing cursor.
 */
export interface ByTagProjectionOptionsType<E> extends ProjectionOptionsType<E> {
  readonly tag: TagFilter;
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

  /** What to do when `handle` throws.  Default: `retry-and-fail`. */
  withRecoveryStrategy(recoveryStrategy: ProjectionRecoveryStrategy): this {
    return this.set('recoveryStrategy', recoveryStrategy);
  }

  /** Retries after the first attempt, for the `retry-*` strategies.  Default: 3. */
  withMaxRetries(maxRetries: number): this {
    return this.set('maxRetries', maxRetries);
  }

  /** First retry delay in ms; doubles per attempt.  Default: 1000. */
  withRetryBackoffMs(retryBackoffMs: number): this {
    return this.set('retryBackoffMs', retryBackoffMs);
  }

  /** Ceiling on the doubling retry delay, in ms.  Default: 60000. */
  withMaxRetryBackoffMs(maxRetryBackoffMs: number): this {
    return this.set('maxRetryBackoffMs', maxRetryBackoffMs);
  }

  /** Structured report for every handler failure — see {@link ProjectionFailure}. */
  withOnFailure(onFailure: (failure: ProjectionFailure<E>) => void): this {
    return this.set('onFailure', onFailure);
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

  /** What to do when `handle` throws.  Default: `retry-and-fail`. */
  withRecoveryStrategy(recoveryStrategy: ProjectionRecoveryStrategy): this {
    return this.set('recoveryStrategy', recoveryStrategy);
  }

  /** Retries after the first attempt, for the `retry-*` strategies.  Default: 3. */
  withMaxRetries(maxRetries: number): this {
    return this.set('maxRetries', maxRetries);
  }

  /** First retry delay in ms; doubles per attempt.  Default: 1000. */
  withRetryBackoffMs(retryBackoffMs: number): this {
    return this.set('retryBackoffMs', retryBackoffMs);
  }

  /** Ceiling on the doubling retry delay, in ms.  Default: 60000. */
  withMaxRetryBackoffMs(maxRetryBackoffMs: number): this {
    return this.set('maxRetryBackoffMs', maxRetryBackoffMs);
  }

  /** Structured report for every handler failure — see {@link ProjectionFailure}. */
  withOnFailure(onFailure: (failure: ProjectionFailure<E>) => void): this {
    return this.set('onFailure', onFailure);
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

  /** What to do when `handle` throws.  Default: `retry-and-fail`. */
  withRecoveryStrategy(recoveryStrategy: ProjectionRecoveryStrategy): this {
    return this.set('recoveryStrategy', recoveryStrategy);
  }

  /** Retries after the first attempt, for the `retry-*` strategies.  Default: 3. */
  withMaxRetries(maxRetries: number): this {
    return this.set('maxRetries', maxRetries);
  }

  /** First retry delay in ms; doubles per attempt.  Default: 1000. */
  withRetryBackoffMs(retryBackoffMs: number): this {
    return this.set('retryBackoffMs', retryBackoffMs);
  }

  /** Ceiling on the doubling retry delay, in ms.  Default: 60000. */
  withMaxRetryBackoffMs(maxRetryBackoffMs: number): this {
    return this.set('maxRetryBackoffMs', maxRetryBackoffMs);
  }

  /** Structured report for every handler failure — see {@link ProjectionFailure}. */
  withOnFailure(onFailure: (failure: ProjectionFailure<E>) => void): this {
    return this.set('onFailure', onFailure);
  }

  /**
   * The tag — or {@link TagFilter} — this projection follows across the whole
   * journal.  One cursor per filter.
   *
   *     .withTag('orders')
   *     .withTag({ all: ['orders'], not: ['cancelled'] })
   */
  withTag(tag: TagFilter): this {
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

/**
 * Bounds on the handler-failure fields, shared by both projection shapes.
 *
 * Run by `ProjectionActor.byPersistenceId` / `byTag` on the merged settings
 * — see the note there for why the static factory rather than the actor's
 * constructor is the consume point for a projection.
 */
export class ProjectionOptionsValidator<E> extends OptionsValidator<ProjectionOptionsType<E>> {
  constructor() { super('ProjectionOptions'); }

  protected rules(s: Partial<ProjectionOptionsType<E>>): void {
    this.oneOf('recoveryStrategy', PROJECTION_RECOVERY_STRATEGIES);
    // 0 is meaningful: `retry-and-skip` with no retries is a `skip` that
    // still reports every attempt through `onFailure`.
    this.nonNegativeInt('maxRetries');
    this.positiveNumber('retryBackoffMs');
    this.positiveNumber('maxRetryBackoffMs');
    // The delay doubles *up to* the cap, so a cap below the first delay does
    // not shorten the backoff curve — it flattens it to a constant at the
    // cap, which is the opposite of what someone lowering it intends.
    if (s.retryBackoffMs !== undefined && s.maxRetryBackoffMs !== undefined
      && s.maxRetryBackoffMs < s.retryBackoffMs) {
      this.fail(
        'maxRetryBackoffMs',
        `must be >= retryBackoffMs (${s.retryBackoffMs})`,
        s.maxRetryBackoffMs,
      );
    }
  }
}

/* ---------------------------- HOCON defaults --------------------------- */

/**
 * The slice of a projection's settings HOCON can supply —
 * `actor-ts.projection.*`, the process-wide defaults under whatever a single
 * projection sets explicitly.
 *
 * `name`, `query`, `offsetStore`, `handle` and `onFailure` are absent because
 * they identify one projection or are objects HOCON cannot express; what
 * remains is failure policy and cadence, which is exactly what an operator
 * retunes per environment without touching code.
 *
 * `pollIntervalMs` is spelled out rather than picked, because on
 * {@link ProjectionOptionsType} it lives one level down inside
 * {@link ProjectionOptionsType.liveOptions} — flat here, because a projection
 * has exactly one poll cadence and the HOCON leaf that sets it is flat too.
 */
export type ProjectionConfigDefaults = Partial<ProjectionRecoveryOptionsType> & {
  /** Gap between polls, in milliseconds — merged into `liveOptions.pollIntervalMs`. */
  readonly pollIntervalMs?: number;
};

/**
 * Read `actor-ts.projection.*` into the shape the two `ProjectionActor`
 * static factories merge under the caller's own options.
 *
 * Only keys actually present are returned, so an absent one falls through to
 * the built-in default instead of landing as an explicit `undefined` that
 * would shadow it.
 *
 * Deliberately **not** validated here.  `ProjectionOptionsValidator` already
 * checks these fields on the merged settings inside the factory, which is the
 * project's validate-once-at-consume-time rule and the only place a
 * cross-field bound (`maxRetryBackoffMs >= retryBackoffMs`) can be judged at
 * all — half of such a pair routinely comes from HOCON and half from code.
 * Rejecting a bad `recovery-strategy` here as well would produce two error
 * messages for one mistake, differing only in which layer it came from.
 */
export function readProjectionOptionsFromConfig(config: Config): ProjectionConfigDefaults {
  const keys = ConfigKeys.projection;
  // Mutable while being filled; consumers see the readonly shape.
  const out: {
    -readonly [K in keyof ProjectionConfigDefaults]: ProjectionConfigDefaults[K]
  } = {};
  if (config.hasPath(keys.recoveryStrategy)) {
    out.recoveryStrategy = config.getString(keys.recoveryStrategy) as ProjectionRecoveryStrategy;
  }
  if (config.hasPath(keys.maxRetries)) out.maxRetries = config.getInt(keys.maxRetries);
  if (config.hasPath(keys.retryBackoff)) {
    out.retryBackoffMs = config.getDuration(keys.retryBackoff);
  }
  if (config.hasPath(keys.maxRetryBackoff)) {
    out.maxRetryBackoffMs = config.getDuration(keys.maxRetryBackoff);
  }
  if (config.hasPath(keys.pollInterval)) {
    out.pollIntervalMs = config.getDuration(keys.pollInterval);
  }
  return out;
}
