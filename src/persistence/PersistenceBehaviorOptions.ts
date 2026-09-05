import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * Built-in default for
 * {@link PersistenceBehaviorOptionsType.maxConcurrentRecoveries}, published as
 * `actor-ts.persistence.max-concurrent-recoveries`.
 *
 * 50 is chosen against the thing it actually protects, which is the journal
 * rather than this process: a shard hand-off or a rolling restart re-creates
 * every entity it owns at once, and each one's recovery is one `read` (plus a
 * `loadLatest` and, on a fully compacted stream, a `highestSeq`).  A region
 * holding a few thousand remembered entities therefore opens a few thousand
 * concurrent reads against a pool sized for tens, and the backend answers by
 * queueing — so every entity's recovery slows down together and
 * `recovery-timeout` fires across the whole wave rather than for the one
 * entity that was actually unlucky.
 *
 * Deliberately above the pool size every relational backend defaults to and
 * well below the entity counts sharding routinely re-creates, so the cap
 * binds during a restart storm and is invisible the rest of the time.  `0`
 * disables it and restores the pre-#874 behaviour exactly.
 */
export const DEFAULT_MAX_CONCURRENT_RECOVERIES = 50;

/**
 * Built-in default for
 * {@link PersistenceBehaviorOptionsType.recoveryTimeoutMs}, published as
 * `actor-ts.persistence.recovery-timeout`.
 *
 * It bounds the *whole* replay — snapshot load, journal read, fold, and the
 * `highestSeq` probe a fully compacted stream needs — not a per-event step,
 * because `Journal.read` returns the slice in one call and there is no
 * per-event step to bound.
 *
 * 30 s is long enough that no healthy replay reaches it (the cap above keeps
 * the queue in front of a slow backend short) and short enough that a backend
 * which accepts a connection and then stalls surfaces as a failed actor
 * rather than as an actor that never finishes starting.  `0` disables the
 * deadline.
 */
export const DEFAULT_RECOVERY_TIMEOUT_MS = 30_000;

/**
 * Built-in default for
 * {@link PersistenceBehaviorOptionsType.snapshotIsOptional}, published as
 * `actor-ts.persistence.snapshot-is-optional`.
 *
 * `false` — a snapshot store that cannot answer fails the recovery.  Turning
 * it on trades a longer replay for staying available while the snapshot
 * store is down, and is safe only where the journal alone reconstructs the
 * state; see the field for the case it deliberately does **not** cover.
 */
export const DEFAULT_SNAPSHOT_IS_OPTIONAL = false;

/**
 * Built-in default for {@link PersistenceBehaviorOptionsType.journalBreaker},
 * published as `actor-ts.persistence.journal-breaker`.
 *
 * A `CircuitBreakerExtension` id rather than a nested block of numbers: #864
 * had already made `actor-ts.circuit-breaker.<id>` the one home for a
 * breaker's settings, and a second copy of `max-failures` / `reset-timeout` /
 * `call-timeout` under `actor-ts.persistence` would be two homes for one
 * mechanism — the outcome #874's triage names as the failure mode to avoid.
 */
export const DEFAULT_JOURNAL_BREAKER_ID = 'persistence-journal';

/**
 * Built-in default for {@link PersistenceBehaviorOptionsType.snapshotBreaker},
 * published as `actor-ts.persistence.snapshot-breaker`.  A separate id from
 * {@link DEFAULT_JOURNAL_BREAKER_ID} on purpose: a snapshot store that is
 * down must not fast-fail the journal that is fine, which is the whole of the
 * one-breaker-per-dependency rule applied to the two stores an event-sourced
 * actor talks to.
 */
export const DEFAULT_SNAPSHOT_BREAKER_ID = 'persistence-snapshot';

/**
 * Process-wide persistence *behaviour* — as opposed to
 * `PersistenceOptions.ts`, which is the per-call store directive
 * (compression / encryption / integrity) and a completely different thing.
 *
 * Everything here is read once from `actor-ts.persistence` by
 * {@link PersistenceExtension} and applies to every `PersistentActor` in the
 * system.  It is system-wide rather than per journal plugin because the
 * extension resolves exactly one journal per system: `registerXxxPlugins`
 * makes several plugin ids *registerable*, but `journal.plugin` selects one
 * of them and a second store is reached by constructing it directly, which
 * never passes through here at all.
 */
export type PersistenceBehaviorOptionsType = {
  /**
   * Journal replays allowed to run at once, system-wide.  `0` is uncapped.
   *
   * The cap sits around the replay itself, not around actor creation: an
   * entity waiting for a permit is already started and its commands queue in
   * its mailbox as they would while it replayed.  `actor-ts.sharding
   * .entity-recovery` paces the *starts* one layer up and the two compose —
   * that block decides how fast entities are created, this one how many of
   * their replays are in flight once they are.
   */
  readonly maxConcurrentRecoveries: number;
  /**
   * Ceiling on one actor's whole recovery, in milliseconds.  `0` is no
   * deadline.
   *
   * Past it the replay rejects with a `RecoveryTimeoutError`, which reaches
   * `onRecoveryFailure` like any other recovery failure.  The read it gave up
   * on is *not* cancelled — nothing in the `Journal` contract can be — so the
   * deadline buys attribution, not resources: the actor fails naming the
   * stall instead of hanging in `preStart` forever.
   */
  readonly recoveryTimeoutMs: number;
  /**
   * Fall back to a full journal replay when the snapshot store cannot answer,
   * instead of failing the recovery.
   *
   * **It deliberately does not cover a snapshot that failed to verify.**  An
   * actor that set `integrity()` or `encryption()` gets no fallback at all,
   * because a store rejecting a tampered body and a store that is simply down
   * both surface as a rejected `loadLatest`, and swallowing the first would
   * turn the integrity check (#100) into a retry.  The fallback is for
   * availability against an unverified store; where a snapshot is a trust
   * boundary, a load failure stays fatal.
   */
  readonly snapshotIsOptional: boolean;
  /**
   * `CircuitBreakerExtension` id the journal is called through, or `""` for
   * no breaker at all.
   *
   * The breaker's own numbers live under `actor-ts.circuit-breaker.<id>`,
   * layered over `actor-ts.circuit-breaker.default` — including
   * `call-timeout`, which is the ceiling on a single `append` and the answer
   * to a backend that accepts the connection and then stalls.
   *
   * Pointing two subsystems at one id shares one breaker between them, which
   * is a real choice and not a mistake: a journal and a read model behind the
   * same database go down together.
   */
  readonly journalBreaker: string;
  /** As {@link journalBreaker}, for the snapshot store.  `""` disables it. */
  readonly snapshotBreaker: string;
};

/**
 * Fluent builder for {@link PersistenceBehaviorOptionsType}.
 *
 *     const persistenceOptions = PersistenceBehaviorOptions.create()
 *       .withMaxConcurrentRecoveries(10)
 *       .withRecoveryTimeoutMs(5_000);
 */
export class PersistenceBehaviorOptionsBuilder extends OptionsBuilder<PersistenceBehaviorOptionsType> {
  /** Start a fresh builder.  Equivalent to `new PersistenceBehaviorOptionsBuilder()`. */
  static create(): PersistenceBehaviorOptionsBuilder {
    return new PersistenceBehaviorOptionsBuilder();
  }

  /** Journal replays allowed to run at once, system-wide.  `0` is uncapped. */
  withMaxConcurrentRecoveries(maxConcurrentRecoveries: number): this {
    return this.set('maxConcurrentRecoveries', maxConcurrentRecoveries);
  }

  /** Ceiling on one actor's whole recovery in milliseconds.  `0` is no deadline. */
  withRecoveryTimeoutMs(recoveryTimeoutMs: number): this {
    return this.set('recoveryTimeoutMs', recoveryTimeoutMs);
  }

  /** Fall back to a full journal replay when the snapshot store cannot answer. */
  withSnapshotIsOptional(snapshotIsOptional: boolean): this {
    return this.set('snapshotIsOptional', snapshotIsOptional);
  }

  /** Circuit-breaker id the journal is called through; `""` disables it. */
  withJournalBreaker(journalBreaker: string): this {
    return this.set('journalBreaker', journalBreaker);
  }

  /** Circuit-breaker id the snapshot store is called through; `""` disables it. */
  withSnapshotBreaker(snapshotBreaker: string): this {
    return this.set('snapshotBreaker', snapshotBreaker);
  }
}

/**
 * Validates resolved {@link PersistenceBehaviorOptionsType} settings.
 *
 * Both numbers are `>= 0` rather than `> 0`: `0` is the documented "off" for
 * each, and `positiveInt` would refuse the value the reference config offers
 * as the way to switch the mechanism off.  The two breaker ids are
 * deliberately unchecked — `""` is "no breaker" and any other string is an id
 * whose block may or may not exist, which is `CircuitBreakerExtension`'s
 * question and not this one's.
 */
export class PersistenceBehaviorOptionsValidator extends OptionsValidator<PersistenceBehaviorOptionsType> {
  constructor() {
    super('PersistenceBehaviorOptions');
  }

  protected rules(_settings: Partial<PersistenceBehaviorOptionsType>): void {
    this.nonNegativeInt('maxConcurrentRecoveries');
    this.nonNegativeNumber('recoveryTimeoutMs');
  }
}

/**
 * Read the `actor-ts.persistence` behaviour leaves, omitting absent ones so
 * an unset leaf falls through to the built-in default below it instead of
 * shadowing it as an explicit `undefined` — the rule `mergeOptions` encodes.
 *
 * Leaf names are the kebab-case of the field with any unit suffix dropped
 * (#1405), so `recoveryTimeoutMs` is read from `recovery-timeout`;
 * `getDuration` takes `30s` and a bare millisecond count alike.
 *
 * The plugin sub-blocks of the same HOCON block (`journal`, `snapshot-store`,
 * `durable-state`) are not touched here — a plugin block is read by the
 * backend that owns it, and these five leaves sit *directly* under
 * `actor-ts.persistence` where no plugin id can be, so the "that block is
 * exclusively plugin-id namespaces" reading of the path stays true one level
 * down.
 */
export function readPersistenceBehaviorOptionsFromConfig(
  config: Config,
): Partial<PersistenceBehaviorOptionsType> {
  const keys = ConfigKeys.persistence;
  const out: {
    -readonly [K in keyof PersistenceBehaviorOptionsType]?: PersistenceBehaviorOptionsType[K]
  } = {};
  if (config.hasPath(keys.maxConcurrentRecoveries)) {
    out.maxConcurrentRecoveries = config.getInt(keys.maxConcurrentRecoveries);
  }
  if (config.hasPath(keys.recoveryTimeout)) {
    out.recoveryTimeoutMs = config.getDuration(keys.recoveryTimeout);
  }
  if (config.hasPath(keys.snapshotIsOptional)) {
    out.snapshotIsOptional = config.getBoolean(keys.snapshotIsOptional);
  }
  if (config.hasPath(keys.journalBreaker)) {
    out.journalBreaker = config.getString(keys.journalBreaker);
  }
  if (config.hasPath(keys.snapshotBreaker)) {
    out.snapshotBreaker = config.getString(keys.snapshotBreaker);
  }
  return out;
}

/**
 * Accepted input wherever persistence behaviour is configured in code: the
 * fluent {@link PersistenceBehaviorOptionsBuilder} OR a plain
 * {@link PersistenceBehaviorOptionsType} object.
 */
export type PersistenceBehaviorOptions =
  | PersistenceBehaviorOptionsBuilder
  | Partial<PersistenceBehaviorOptionsType>;
/** Value alias so `PersistenceBehaviorOptions.create()` resolves to the builder. */
export const PersistenceBehaviorOptions = PersistenceBehaviorOptionsBuilder;
