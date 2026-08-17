import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * Where captured dead letters are kept.
 *
 * A *storage* vocabulary on purpose, and deliberately not a second copy of
 * the failure vocabulary `ProjectionOptions` introduced
 * (`retry-and-fail` / `retry-and-skip` / `fail` / `skip`).  That one answers
 * "what should happen when handling fails"; this one answers "where does the
 * letter go once it already has".  The two compose — a projection that
 * `skip`s publishes a dead letter, and this decides whether the queue keeps
 * it — so folding them into one enum would have made two independent
 * decisions look like one.
 *
 * There is no `log` arm.  Dead letters are not logged today and never were:
 * `DeadLetterRef` holds no logger, it publishes on the event stream and
 * returns.  Naming the default after a log line the framework does not emit
 * would document a behaviour into existence (#1000 tracks the docs that
 * already claim it).
 */
export type DeadLetterStore = 'off' | 'memory' | 'persistent';

/** Accepted values of {@link DeadLetterQueueOptionsType.store}. */
export const DEAD_LETTER_STORES: ReadonlyArray<DeadLetterStore> = [
  'off',
  'memory',
  'persistent',
];

/**
 * Built-in default for {@link DeadLetterQueueOptionsType.store}.
 *
 * `off` because capture is not free and nothing before this release did it:
 * a queue that switched itself on would start holding references to every
 * undeliverable message in a running system on the strength of an upgrade.
 */
export const DEFAULT_DEAD_LETTER_STORE: DeadLetterStore = 'off';
/** Built-in default for {@link DeadLetterQueueOptionsType.maxEntries}. */
export const DEFAULT_DEAD_LETTER_MAX_ENTRIES = 1_000;
/**
 * Built-in default for {@link DeadLetterQueueOptionsType.retentionMs} — one
 * hour, long enough to still be there when an alert is answered, short
 * enough that an idle process does not accumulate a day of them.
 */
export const DEFAULT_DEAD_LETTER_RETENTION_MS = 60 * 60 * 1_000;
/**
 * Built-in default for {@link DeadLetterQueueOptionsType.maxReplays}.
 *
 * Three, not "unlimited": a letter that dead-letters again on replay is
 * evidence the recipient cannot take it, and the queue's job is to stop
 * that from becoming an unbounded loop between an operator and a poison
 * message.
 */
export const DEFAULT_DEAD_LETTER_MAX_REPLAYS = 3;

/**
 * Persistence id the `persistent` store writes under when none is given.
 *
 * Carries the system name so two systems sharing a journal — a common
 * multi-tenant or test arrangement — do not fold their queues together and
 * replay each other's letters into actors that never existed on the other
 * side.
 */
export function defaultDeadLetterPersistenceId(systemName: string): string {
  return `actor-ts-dead-letters-${systemName}`;
}

/** Plain options-object shape consumed by a {@link DeadLetterQueue}. */
export type DeadLetterQueueOptionsType = {
  /** Where captured letters are kept.  Defaults to {@link DEFAULT_DEAD_LETTER_STORE}. */
  readonly store?: DeadLetterStore;
  /**
   * Most letters the queue holds.  Capturing the oldest one past the cap
   * evicts it — the queue is a diagnostic ring, and an unbounded one turns
   * a delivery outage into an out-of-memory.
   */
  readonly maxEntries?: number;
  /** Drop letters older than this many milliseconds.  `0` disables ageing. */
  readonly retentionMs?: number;
  /** Refuse to replay a letter that has already come back this many times. */
  readonly maxReplays?: number;
  /**
   * Journal stream the `persistent` store writes to.  Defaults to
   * {@link defaultDeadLetterPersistenceId} over the system name.
   */
  readonly persistenceId?: string;
};

/** Fluent builder for {@link DeadLetterQueueOptionsType}. */
export class DeadLetterQueueOptionsBuilder extends OptionsBuilder<DeadLetterQueueOptionsType> {
  /** Start a fresh builder. */
  static create(): DeadLetterQueueOptionsBuilder {
    return new DeadLetterQueueOptionsBuilder();
  }

  /** Where captured letters are kept — `off`, `memory` or `persistent`. */
  withStore(store: DeadLetterStore): this {
    return this.set('store', store);
  }

  /** Cap on the letters the queue holds before it evicts the oldest. */
  withMaxEntries(maxEntries: number): this {
    return this.set('maxEntries', maxEntries);
  }

  /** Age letters out after this many milliseconds.  `0` disables ageing. */
  withRetentionMs(retentionMs: number): this {
    return this.set('retentionMs', retentionMs);
  }

  /** Cap on how often one letter may be replayed before it is quarantined. */
  withMaxReplays(maxReplays: number): this {
    return this.set('maxReplays', maxReplays);
  }

  /** Journal stream the `persistent` store writes to. */
  withPersistenceId(persistenceId: string): this {
    return this.set('persistenceId', persistenceId);
  }
}

/** Validates resolved {@link DeadLetterQueueOptionsType} settings. */
export class DeadLetterQueueOptionsValidator extends OptionsValidator<DeadLetterQueueOptionsType> {
  constructor() {
    super('DeadLetterQueueOptions');
  }

  protected rules(_s: Partial<DeadLetterQueueOptionsType>): void {
    this.oneOf('store', DEAD_LETTER_STORES);
    this.positiveInt('maxEntries');
    // Non-negative rather than positive: 0 is the documented "never age
    // out", which leaves `maxEntries` as the only bound.
    this.nonNegativeInt('retentionMs');
    // Likewise 0 — "captured, never replayable" is a coherent posture for
    // an operator who wants the record without the redelivery button.
    this.nonNegativeInt('maxReplays');
    this.nonEmptyString('persistenceId');
  }
}

/**
 * Accepted input for anything that takes dead-letter-queue options: the
 * fluent builder or the plain object, interchangeably.
 */
export type DeadLetterQueueOptions =
  | DeadLetterQueueOptionsBuilder
  | DeadLetterQueueOptionsType;
/** Value alias so `DeadLetterQueueOptions.create()` resolves to the builder. */
export const DeadLetterQueueOptions = DeadLetterQueueOptionsBuilder;

/**
 * Read `actor-ts.dead-letters.*` into the shape the queue layers under any
 * explicit options.  Only keys actually present are returned, so an absent
 * one falls through to the built-in default rather than landing as an
 * explicit `undefined` that would shadow it.
 */
export function readDeadLetterQueueOptionsFromConfig(
  config: Config,
): Partial<DeadLetterQueueOptionsType> {
  const keys = ConfigKeys.deadLetters;
  const out: {
    -readonly [K in keyof DeadLetterQueueOptionsType]?: DeadLetterQueueOptionsType[K]
  } = {};
  if (config.hasPath(keys.store)) out.store = config.getString(keys.store) as DeadLetterStore;
  if (config.hasPath(keys.maxEntries)) out.maxEntries = config.getInt(keys.maxEntries);
  if (config.hasPath(keys.retention)) out.retentionMs = config.getDuration(keys.retention);
  if (config.hasPath(keys.maxReplays)) out.maxReplays = config.getInt(keys.maxReplays);
  if (config.hasPath(keys.persistenceId)) {
    // `""` is how a HOCON file says "no opinion" for a string with a
    // computed default — the same shape the OTLP sink's `service-name` uses.
    // Left as an empty string it would reach the validator, which rejects it,
    // so an operator who touched nothing would fail to start.
    const persistenceId = config.getString(keys.persistenceId);
    if (persistenceId.length > 0) out.persistenceId = persistenceId;
  }
  return out;
}
