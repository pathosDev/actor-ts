import type { ActorSystem } from '../ActorSystem.js';
import { ClusterExtensionId } from '../cluster/ClusterExtension.js';
import { ConfigError, type Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { CoordinatedStartupId } from '../CoordinatedStartup.js';
import { StartupPhases } from '../CoordinatedStartupOptions.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import type { DurableStateStore } from './DurableStateStore.js';
import { InMemoryDurableStateStore } from './durable-state-stores/InMemoryDurableStateStore.js';
import type { Journal } from './Journal.js';
import { InMemoryJournal } from './journals/InMemoryJournal.js';
import { JournalConcurrencyError } from './JournalTypes.js';
import type { Logger } from '../Logger.js';
import type { Counter, Histogram, MetricsRegistry } from '../metrics/Metrics.js';
import { CircuitBreakerTimeoutError, type CircuitBreaker, type CircuitState } from '../pattern/CircuitBreaker.js';
import { CircuitBreakerExtensionId } from '../pattern/CircuitBreakerExtension.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import {
  DEFAULT_JOURNAL_BREAKER_ID,
  DEFAULT_MAX_CONCURRENT_RECOVERIES,
  DEFAULT_PERSISTENCE_AUTO_START,
  DEFAULT_RECOVERY_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_BREAKER_ID,
  DEFAULT_SNAPSHOT_IS_OPTIONAL,
  PersistenceBehaviorOptionsValidator,
  readPersistenceBehaviorOptionsFromConfig,
  type PersistenceBehaviorOptions,
  type PersistenceBehaviorOptionsType,
} from './PersistenceBehaviorOptions.js';
import { RecoveryPermits } from './RecoveryPermits.js';
import { JournalIntegrityError, SnapshotIntegrityError } from './Replay.js';
import {
  PERSISTENCE_SECURITY_CONTROL_FIELDS,
  UnsupportedPersistenceOptionError,
  unhonouredCompressionMessage,
  unhonouredPersistenceOptions,
  unsupportedPersistenceOptionMessage,
  type PersistenceOptionSupport,
} from './PersistenceCapabilities.js';
import type { PersistenceOptions } from './PersistenceOptions.js';
import type { SnapshotStore } from './SnapshotStore.js';
import { InMemorySnapshotStore } from './snapshot-stores/InMemorySnapshotStore.js';
import { readInMemorySnapshotStoreOptionsFromConfig } from './snapshot-stores/InMemorySnapshotStoreOptions.js';
import type { StorageUseKind } from './StorageLocality.js';
import { StorageLocalityAdvisory, type ObservedStore } from './StorageLocalityAdvisory.js';

/**
 * Does this error mean the store is unavailable, as opposed to having
 * answered a question?  The `isFailure` classifier both persistence breakers
 * are *called* with (#874) — for the calls they guard, which
 * {@link journalBreakerClassifiers} lists.
 *
 * Passed per call rather than as a construction option, and that is the whole
 * of it: `CircuitBreakerExtension.breaker(id, options)` returns the instance
 * that already exists rather than reconfiguring it, so a predicate handed over
 * at construction only reached the breaker when persistence happened to be the
 * first caller for that id.  The id is published as a configuration path and
 * {@link PersistenceExtension.journalBreaker} invites a dashboard to read the
 * state, so one earlier `breaker('persistence-journal')` anywhere in the
 * process was enough to lose the carve-out — and then a burst of losing
 * conditional appends fast-failed every healthy entity on the node, which is
 * the exact outage this exists to prevent.  A classifier that belongs to the
 * protected dependency has to travel with the call.
 *
 * Three verdicts are excluded, and each one would otherwise be a way to
 * fast-fail a healthy system:
 *
 *   - `JournalConcurrencyError` — a conditional append lost, so a second live
 *     instance owns that entity (#1166).  Ten losing appends by ten unlucky
 *     entities would open the breaker and refuse every *healthy* entity on
 *     the node, for a condition the journal answered correctly.
 *   - `JournalIntegrityError` / `SnapshotIntegrityError` — the store returned
 *     data that failed a trust check (#100, #122).  That is a durable fact
 *     about the stored bytes; retrying later cannot change it, and a breaker
 *     is a device for waiting out a transient fault.
 *
 * Everything else counts, including a `CircuitBreakerTimeoutError` from the
 * breaker's own `call-timeout` — a stalled backend is the outage this exists
 * for.  An operator who disagrees has the other half of the classifier:
 * `actor-ts.circuit-breaker.<id>.ignored-error-names` is checked first and
 * wins over this predicate.
 *
 * The exclusions are spelled once, as reasons, in {@link failureReasonOf}, so
 * the failure counters (#1496) and the breaker cannot come to disagree about
 * what an outage is.
 */
function isStoreOutage(error: Error): boolean {
  const reason = failureReasonOf(error);
  return reason === 'outage' || reason === 'timeout';
}

/**
 * What a journal call through {@link PersistenceExtension.callThroughJournalBreaker}
 * is doing — the `operation` label of the journal's metric families (#1496).
 *
 * `replay` is the whole journal phase of a recovery rather than one
 * `Journal.read`: the snapshot's claim checked against the journal head, the
 * read, the check on what it returned and the head probe — every journal call
 * a recovery makes, as one call through the breaker.  The fold that follows is
 * user code and runs outside it.
 */
export type JournalOperation = 'append' | 'replay' | 'delete';

/**
 * As {@link JournalOperation}, for the snapshot store.  `load` is the one read a
 * recovery makes; the check of what it loaded is a journal call, under `replay`.
 */
export type SnapshotOperation = 'save' | 'load' | 'delete';

/** The classifier of a call whose failures a breaker does not count — see {@link journalBreakerClassifiers}. */
function countsNoFailure(): boolean {
  return false;
}

/**
 * What a failed journal call counts against the journal breaker, by operation
 * (#1496): an append or a replay through {@link isStoreOutage}, a delete never.
 *
 * The breaker guards the calls an entity cannot do without — its appends and
 * its recovery.  A journal that refuses deletes — append-only grants, a
 * retention policy, a backend that does not implement the operation — still
 * takes every append and serves every replay, and counted, a burst of ten
 * refused compactions opened the breaker, after which every persist and every
 * recovery on the node was refused for `reset-timeout`.  A refused delete fails
 * that compaction and nothing else.
 *
 * Not counted is not unguarded: a delete still runs *through* the breaker, so
 * `call-timeout` still cuts one that never answers, and an open breaker still
 * refuses it — a journal that the guarded calls found down is down for a delete
 * too.  The failure counters still count it, under the reason its error gives:
 * this decides what trips the breaker, they report what the store did.
 *
 * A `Record` over the operations, so a new one does not compile until someone
 * decides whether it counts.
 */
const journalBreakerClassifiers: Readonly<Record<JournalOperation, (error: Error) => boolean>> = {
  append: isStoreOutage,
  replay: isStoreOutage,
  delete: countsNoFailure,
};

/**
 * As {@link journalBreakerClassifiers}, for the snapshot breaker, which guards
 * the load a recovery starts with — the one snapshot-store call an entity
 * cannot do without (#1496).  Saves and deletes are not counted: a store that
 * refuses writes and reads fine — a full disk, a quota, a missing write or
 * delete grant — serves every load, and counted, ten refused saves or
 * compactions opened the breaker and failed every recovery on the node: an
 * entity with `integrity()` or `encryption()` even under `snapshot-is-optional`,
 * which never tolerates a failed load for such an entity.
 */
const snapshotBreakerClassifiers: Readonly<Record<SnapshotOperation, (error: Error) => boolean>> = {
  save: countsNoFailure,
  load: isStoreOutage,
  delete: countsNoFailure,
};

/**
 * Why a call through a persistence seam failed — the `reason` label of the two
 * failure families (#1496).  A closed set, so a dashboard can enumerate it:
 *
 *   - `outage` — anything the store threw that is none of the below; what the
 *     breaker counts, on the calls it guards ({@link journalBreakerClassifiers}).
 *   - `timeout` — the breaker's own `call-timeout` cut the call
 *     (`CircuitBreakerTimeoutError`); counted by the breaker too.
 *   - `breaker-open` — the open breaker refused the call, and the store was
 *     never asked (`CircuitBreakerOpenError`).
 *   - `ownership` — a conditional append lost to a second writer
 *     (`JournalConcurrencyError`).
 *   - `integrity` — the store answered with data that failed a trust check
 *     (`JournalIntegrityError`, `SnapshotIntegrityError`).
 *
 * The last two are the verdicts {@link isStoreOutage} excludes, and they stay
 * apart rather than sharing a "not an outage" value because they page
 * different people: a second writer is a deployment fault, a failed trust
 * check is a data incident.
 */
type PersistenceFailureReason = 'outage' | 'timeout' | 'breaker-open' | 'ownership' | 'integrity';

/**
 * The reason of a call that reached the store and failed.
 *
 * Never `breaker-open`: that one is about the store *not* having been asked, so
 * the seam decides it from whether the call ran rather than from the error's
 * class.  A `CircuitBreakerOpenError` a store throws out of a breaker of its own
 * is an outage of that store — which is also how {@link isStoreOutage} has
 * always counted it.
 */
function failureReasonOf(error: unknown): PersistenceFailureReason {
  if (error instanceof CircuitBreakerTimeoutError) return 'timeout';
  if (error instanceof JournalConcurrencyError) return 'ownership';
  if (error instanceof JournalIntegrityError || error instanceof SnapshotIntegrityError) return 'integrity';
  return 'outage';
}

/**
 * One seam's two instruments.  Written out per store rather than composed from
 * a name prefix, because the stock-metrics inventory reads each family's name
 * and label tuple straight out of the call that mints it
 * (`tests/unit/metrics/StockMetrics.test.ts`), and a composed name is a family
 * it cannot see.
 *
 * Neither family is labelled by persistence id or by store: `operation` and
 * `reason` are closed sets, so the series count is fixed by this file whatever
 * the traffic.  The buckets are the registry's default — persistence calls sit
 * in the 5 ms … 10 s range those were chosen for.
 */
type SeamInstruments = {
  readonly latency: (metrics: MetricsRegistry, operation: string) => Histogram;
  readonly failures: (metrics: MetricsRegistry, operation: string, reason: PersistenceFailureReason) => Counter;
};

const journalInstruments: SeamInstruments = {
  latency: (metrics, operation) => metrics.histogram(
    'persistence_journal_latency_seconds', { operation },
    { help: 'Duration of a journal call through the persistence breaker, seconds; calls the open breaker refused are not observed.' },
  ),
  failures: (metrics, operation, reason) => metrics.counter(
    'persistence_journal_failures_total', { operation, reason },
    { help: 'Journal calls through the persistence breaker that failed, by operation and reason.' },
  ),
};

const snapshotInstruments: SeamInstruments = {
  latency: (metrics, operation) => metrics.histogram(
    'persistence_snapshot_latency_seconds', { operation },
    { help: 'Duration of a snapshot-store call through the persistence breaker, seconds; calls the open breaker refused are not observed.' },
  ),
  failures: (metrics, operation, reason) => metrics.counter(
    'persistence_snapshot_failures_total', { operation, reason },
    { help: 'Snapshot-store calls through the persistence breaker that failed, by operation and reason.' },
  ),
};

/**
 * Which store a persistence breaker guards — the `breaker` label of
 * `persistence_breaker_state` (#1496).  The role and never the configured id:
 * two values whatever `journal-breaker` / `snapshot-breaker` name, so the
 * gauge's width is fixed by this file.
 */
type PersistenceBreakerRole = 'journal' | 'snapshot';

/**
 * How `persistence_breaker_state` encodes a state: ordered by how much of the
 * store's traffic is refused, so `> 0` reads "not fully serving" and `== 2`
 * "refusing everything" without a lookup on the dashboard's side.
 */
const BREAKER_STATE_VALUE: Readonly<Record<CircuitState, number>> = { closed: 0, 'half-open': 1, open: 2 };

/**
 * A persistence plug-in, as `ActorSystemOptions.withPersistence({ plugins })`
 * takes it: a function handed the system's {@link PersistenceExtension} that
 * registers backends on it — typically one `register*Plugins` call, such as
 * `(persistence) => registerPostgresPlugins(persistence)`.
 *
 * Plug-ins run inside `ActorSystem.create`, synchronously and in the order
 * given, so every factory one registers before its first `await` exists when
 * `create` returns.  A plug-in that throws makes `create` throw.  What one
 * returns is ignored unless it is a promise — any thenable — which the
 * `persistence-start` phase of the startup graph waits for: a rejection fails
 * the startup, so `whenReady()` rejects and the system goes down, rather than
 * the first persisted message failing much later.
 *
 * Register a selected backend's factories before the first `await`.  With
 * `autoStart` on — the default — the selected stores are resolved inside
 * `create`, right after the plug-ins ran, so a factory a plug-in registers
 * later is not the one a selected axis is built from; the warm-up does wait
 * for the returned promise before it opens the stores, so work the stores
 * depend on — a probe, a key fetched from a vault — may come after it.
 */
export type PersistencePlugin = (persistence: PersistenceExtension) => unknown;

/** Which store the warm-up is opening, as a failure to open it names it. */
type StoreAxis = 'journal' | 'snapshot store' | 'durable-state store';

/** A store the warm-up opens, and where it came from — `pluginId` is `null` for one set in code. */
type StoreToOpen = {
  readonly axis: StoreAxis;
  readonly store: Journal | SnapshotStore | DurableStateStore;
  readonly pluginId: string | null;
};

/** What the warm-up resolved inside `create`: the stores, and the lookup that failed, if one did. */
type SelectedStores = {
  readonly stores: ReadonlyArray<StoreToOpen>;
  readonly failure: unknown;
};

/**
 * System-wide access point to the currently-configured journal, snapshot store
 * and durable-state store.  Plug-ins register a new factory through
 * `registerJournal` / `registerSnapshotStore` / `registerDurableStateStore`;
 * the active plug-in is chosen by the HOCON config path
 * `actor-ts.persistence.<axis>.plugin`, each defaulting to the in-memory
 * reference implementation.
 *
 * **Where plug-ins are wired (#1473).**  Through
 * `ActorSystemOptions.withPersistence({ plugins })`: the system runs each
 * {@link PersistencePlugin} against this extension inside `ActorSystem.create`,
 * so the factory a selector names is registered before `create` returns, and
 * the startup graph awaits a promise the plug-in returns — a registration
 * that fails late fails the startup.  A `register*Plugins` call made on the
 * extension after `create` reaches the same registry, but outside the
 * startup: nothing awaits what it returns, and the graph, sealed when
 * `create` returned, takes no task from it.
 *
 * **The selected stores open at startup (#1473).**  With the behaviour's
 * `autoStart` on — the default — a system that wires persistence in code, or
 * whose configuration selects a plug-in other than the in-memory one, builds
 * this extension inside `create`, resolves the three selected stores there
 * and opens them in the `persistence-start` phase; see
 * {@link _prepareWarmUp}.  A selected plug-in registered after `create`
 * therefore fails the startup, and a store that cannot open takes the system
 * down before it serves anything.
 *
 * **Three axes, not two (#872).**  Durable state was the one persistence
 * contract with no registry: every `register*Plugins` helper built its store
 * eagerly and handed it back as a return value, so a `DurableStateActor` could
 * only be wired by threading that instance through application code, and
 * `actor-ts.persistence.durable-state.<backend>` named a plugin id nothing
 * could select.  The nine `*_DURABLE_STATE_PLUGIN_ID` constants the backends
 * already exported were dead exports for precisely that reason.
 */
export class PersistenceExtension implements Extension {
  private readonly journalFactories = new Map<string, (system: ActorSystem) => Journal>();
  private readonly snapshotFactories = new Map<string, (system: ActorSystem) => SnapshotStore>();
  private readonly durableStateFactories = new Map<string, (system: ActorSystem) => DurableStateStore>();

  private _journal: Journal | null = null;
  private _snapshotStore: SnapshotStore | null = null;
  private _durableStateStore: DurableStateStore | null = null;
  /**
   * The plugin id each store above was built from, or `null` when the store
   * was set in code (or nothing is resolved yet).  What a registration under
   * that id drops — see {@link registerJournal}.
   */
  private journalBuiltFrom: string | null = null;
  private snapshotStoreBuiltFrom: string | null = null;
  private durableStateStoreBuiltFrom: string | null = null;
  private readonly storageAdvisory: StorageLocalityAdvisory;
  private readonly log: Logger;
  /**
   * One compression warning per system, per store kind and store class — the
   * "say it once, loudly" shape the storage-locality advisory uses, because a
   * per-actor warning over a sharded entity type is a log flood, not a
   * diagnostic (#960).
   */
  private readonly reportedUnhonouredCompression = new Set<string>();
  /** Resolved on first read of {@link behavior}; see there for why not eagerly. */
  private _behavior: PersistenceBehaviorOptionsType | null = null;
  /** The behaviour set in code — the explicit layer {@link behavior} merges over HOCON. */
  private readonly explicitBehavior: Partial<PersistenceBehaviorOptionsType>;
  private _recoveryPermits: RecoveryPermits | null = null;
  /** `undefined` = not resolved yet, `null` = deliberately no breaker. */
  private _journalBreaker: CircuitBreaker | null | undefined;
  private _snapshotBreaker: CircuitBreaker | null | undefined;
  /**
   * The registry whose `persistence_breaker_state` holds every resolved
   * breaker's current state — see {@link publishBreakerStates}.  `null` when no
   * registry is known to: until metrics are first seen on, and after a change
   * the one named here missed ({@link publishBreakerChange}).
   */
  private breakerStatesPublishedTo: MetricsRegistry | null = null;
  /** The registries {@link onRegistryRefusal} has reported, so each is reported once. */
  private readonly registriesReportedRefusing = new WeakSet<MetricsRegistry>();
  /**
   * The promises the plug-ins returned, as {@link _runPlugins} collected them
   * — what the warm-up waits for before it opens anything.
   */
  private pluginRegistrations: ReadonlyArray<Promise<unknown>> = [];

  /**
   * @param explicitBehavior The behaviour set in code — what
   *   `ActorSystemOptions.withPersistence({ behavior })` carries, which the
   *   system's factory for this extension hands over.  Snapshotted here, so a
   *   builder changed after `create` changes nothing.
   */
  constructor(
    private readonly system: ActorSystem,
    explicitBehavior: PersistenceBehaviorOptions = {},
  ) {
    this.explicitBehavior = { ...(explicitBehavior as Partial<PersistenceBehaviorOptionsType>) };
    // Ship the in-memory reference plug-in out of the box.
    this.registerJournal('actor-ts.persistence.journal.in-memory', () => new InMemoryJournal());
    this.registerSnapshotStore(
      'actor-ts.persistence.snapshot-store.in-memory',
      (resolvingSystem: ActorSystem) => new InMemorySnapshotStore(
        readInMemorySnapshotStoreOptionsFromConfig(resolvingSystem.config),
      ),
    );
    this.registerDurableStateStore('actor-ts.persistence.durable-state.in-memory', () => new InMemoryDurableStateStore());
    const clusterExtension = system.extension(ClusterExtensionId);
    this.log = system.log.withSource('persistence');
    this.storageAdvisory = new StorageLocalityAdvisory(
      {
        current: () => clusterExtension.get().toNullable(),
        onRegister: (listener) => clusterExtension._onRegister(listener),
      },
      this.log,
    );
  }

  /**
   * Record that a store instance is actually in use for `kind`, feeding the
   * storage-locality advisory (#1356).  Called from the seams where
   * cluster-relevant persistent state is wired — `PersistentActor` /
   * `DurableStateActor` `preStart`, the remember-entities auto-wiring — and
   * deliberately NOT from the lazy {@link journal} / {@link snapshotStore}
   * getters: resolving the default in-memory stores for a system that never
   * spawns a persistent actor must not warn.
   */
  noteStoreUse(
    kind: StorageUseKind,
    store: ObservedStore,
    level: 'warn' | 'error' = 'warn',
  ): void {
    this.storageAdvisory.noteStoreUse(kind, store, level);
  }

  /**
   * Refuse an actor that asked for a persistence control the store it is
   * wired to does not implement (#960).  Called from the same seams as
   * {@link noteStoreUse} and immediately after it — `PersistentActor` /
   * `DurableStateActor` `preStart` — for two reasons:
   *
   *   - **It is the earliest point at which the pairing is real.**  The
   *     actor's hooks and the resolved store are both known, and nothing has
   *     touched storage yet.
   *   - **`DurableStateActor.preStart` reads before it ever writes.**  A
   *     check that only guarded `save`/`upsert` would still let that load
   *     hand the actor a plaintext record it believes was ciphertext, which
   *     is the same failure one layer earlier.
   *
   * The split between refusing and warning is
   * {@link PERSISTENCE_SECURITY_CONTROL_FIELDS}: `encryption` and
   * `integrity` throw, `compression` warns once and lets the actor run.  A
   * store that declares nothing is unknown and does neither.
   *
   * Security first, deliberately: when both halves are unhonoured the throw
   * wins and no compression warning is logged, because an actor that is
   * about to be refused has no compression problem worth reading about.
   *
   * @throws UnsupportedPersistenceOptionError
   */
  assertPersistenceOptionsSupported(
    kind: StorageUseKind,
    store: { readonly persistenceOptionSupport?: PersistenceOptionSupport },
    options: PersistenceOptions | undefined,
  ): void {
    const unhonoured = unhonouredPersistenceOptions(options, store.persistenceOptionSupport);
    if (unhonoured.length === 0) return;
    const storeName = store.constructor.name;
    for (const field of unhonoured) {
      if (!PERSISTENCE_SECURITY_CONTROL_FIELDS.has(field)) continue;
      throw new UnsupportedPersistenceOptionError(
        storeName, field, unsupportedPersistenceOptionMessage(kind, storeName, field),
      );
    }
    if (!unhonoured.includes('compression')) return;
    const reportKey = `${kind}:${storeName}`;
    if (this.reportedUnhonouredCompression.has(reportKey)) return;
    this.reportedUnhonouredCompression.add(reportKey);
    this.log.warn(unhonouredCompressionMessage(kind, storeName));
  }

  /**
   * The system's resolved configuration — reference.conf, `application.conf`
   * and the explicit overrides, already layered.
   *
   * Exists so a `register*Plugins` helper can read its own HOCON block
   * (#873).  Those helpers take a `PersistenceExtension` and no
   * `ActorSystem`, and `system` here is private, so before this accessor the
   * object-storage plugin had no way to reach config at all — which is why
   * every one of its fields was constructor-only.
   *
   * An accessor rather than a second positional parameter on each helper,
   * deliberately: adding one would have broken every documented call site
   * (four docs pages and a runnable example) for a value the extension
   * already holds, and every other `register*Plugins` helper needs the same
   * seam as its block lands.  Read-only — the extension does not own the
   * config and must not appear to.
   */
  get config(): Config { return this.system.config; }

  /**
   * The merged persistence behaviour settings (#874), resolved and validated
   * once on first read: `withPersistence({ behavior })` over
   * `actor-ts.persistence` over the built-in defaults, field by field (#1473).
   *
   * Lazily rather than in the constructor because the extension is built the
   * first time *anything* touches persistence — including a system that only
   * registers a plugin and never spawns a persistent actor — and a validation
   * throw there would surface as a failure to construct the extension rather
   * than as a configuration error naming the field.  A system that builds the
   * extension inside `create` reads it there too, for `autoStart` (see
   * {@link _prepareWarmUp}), so a mistake in the block fails `create` with
   * that error.
   */
  get behavior(): PersistenceBehaviorOptionsType {
    if (this._behavior) return this._behavior;
    const settings = mergeOptions<PersistenceBehaviorOptionsType>(
      {
        maxConcurrentRecoveries: DEFAULT_MAX_CONCURRENT_RECOVERIES,
        recoveryTimeoutMs: DEFAULT_RECOVERY_TIMEOUT_MS,
        snapshotIsOptional: DEFAULT_SNAPSHOT_IS_OPTIONAL,
        journalBreaker: DEFAULT_JOURNAL_BREAKER_ID,
        snapshotBreaker: DEFAULT_SNAPSHOT_BREAKER_ID,
        autoStart: DEFAULT_PERSISTENCE_AUTO_START,
      },
      readPersistenceBehaviorOptionsFromConfig(this.system.config),
      this.explicitBehavior,
    );
    new PersistenceBehaviorOptionsValidator().validate(settings);
    this._behavior = settings;
    return settings;
  }

  /**
   * The breaker in front of the journal, or `null` when
   * `actor-ts.persistence.journal-breaker` is `""`.
   *
   * Resolved through `CircuitBreakerExtension`, so its numbers come from
   * `actor-ts.circuit-breaker.<id>` over `…default` over the built-in floor —
   * one home for a breaker's settings rather than a second copy of
   * `max-failures` under `actor-ts.persistence` (#864, #874).
   *
   * Public so a test can watch the state without reaching into a private
   * field, and so an operator dashboard can report it.  The store getters
   * above deliberately still return the raw store: wrapping them would defeat
   * the `instanceof` assertions every backend suite makes, and would define
   * `Journal`'s four optional methods whose *absence* is meaningful — a
   * migration refuses a target with no `raiseCompactionMark`, and a wrapper
   * that always had one would wave through a copy that renumbers a compacted
   * stream.
   */
  get journalBreaker(): CircuitBreaker | null {
    if (this._journalBreaker === undefined) {
      this._journalBreaker = this.resolveBreaker('journal', this.behavior.journalBreaker);
    }
    return this._journalBreaker;
  }

  /** As {@link journalBreaker}, for the snapshot store. */
  get snapshotBreaker(): CircuitBreaker | null {
    if (this._snapshotBreaker === undefined) {
      this._snapshotBreaker = this.resolveBreaker('snapshot', this.behavior.snapshotBreaker);
    }
    return this._snapshotBreaker;
  }

  /**
   * Run `call` under {@link journalBreaker}, or plainly when there is none.
   *
   * {@link isStoreOutage} travels with the call rather than with the instance
   * — see there for why, and for what went wrong when it did not.
   *
   * `operation` names the call for the journal's two metric families (#1496),
   * `persistence_journal_latency_seconds{operation}` and
   * `persistence_journal_failures_total{operation, reason}`.  It is a
   * parameter rather than something the seam could infer because the seam
   * only ever sees a closure, and the families are only worth having if every
   * journal call a `PersistentActor` makes comes through here under its own
   * name — `deleteHistory` included.
   *
   * It also decides what the call's failure counts against the breaker: an
   * append or a replay through {@link isStoreOutage}, a delete not at all —
   * {@link journalBreakerClassifiers} says why.
   */
  callThroughJournalBreaker<T>(operation: JournalOperation, call: () => Promise<T>): Promise<T> {
    return this.callThrough(
      this.journalBreaker, journalInstruments, operation, journalBreakerClassifiers[operation], call,
    );
  }

  /**
   * As {@link callThroughJournalBreaker}, for the snapshot store and its
   * `persistence_snapshot_*` twins.  Only a `load` counts against the snapshot
   * breaker; see {@link snapshotBreakerClassifiers}.
   */
  callThroughSnapshotBreaker<T>(operation: SnapshotOperation, call: () => Promise<T>): Promise<T> {
    return this.callThrough(
      this.snapshotBreaker, snapshotInstruments, operation, snapshotBreakerClassifiers[operation], call,
    );
  }

  /**
   * Run `work` holding one of `max-concurrent-recoveries` permits.
   *
   * `0` permits means uncapped, and then this is `work()` with no queue and
   * no allocation at all — the pre-#874 behaviour, reachable by configuration
   * rather than only by reading the source.
   */
  withRecoveryPermit<T>(work: () => Promise<T>): Promise<T> {
    return this.recoveryPermits?.run(work) ?? work();
  }

  /**
   * The recovery gate, or `null` when uncapped.  Exposed for the same reason
   * {@link journalBreaker} is: `peakInFlight` is the only way to assert the
   * cap held without sampling the very interleaving under test.
   */
  get recoveryPermits(): RecoveryPermits | null {
    if (!this._recoveryPermits && this.behavior.maxConcurrentRecoveries > 0) {
      this._recoveryPermits = new RecoveryPermits(this.behavior.maxConcurrentRecoveries);
    }
    return this._recoveryPermits;
  }

  /**
   * Register a journal factory under `pluginId`.
   *
   * A journal the replaced factory already built is dropped, so the next read
   * builds one from this factory.  A journal set in code is not: it is the
   * explicit layer over whatever plug-in the config selects (#1473), and
   * dropping it made the order of two calls decide which journal a system
   * wrote to — a `register*Plugins` call after `withPersistence({ journal })`
   * swapped it out without a word whenever its backend was the selected one,
   * and a registration that arrives late does so under running actors.
   */
  registerJournal(pluginId: string, factory: (system: ActorSystem) => Journal): void {
    this.journalFactories.set(pluginId, factory);
    if (this.journalBuiltFrom === pluginId) {
      this._journal = null;
      this.journalBuiltFrom = null;
    }
  }

  /** Register a snapshot-store factory under `pluginId` — the rules of {@link registerJournal}. */
  registerSnapshotStore(pluginId: string, factory: (system: ActorSystem) => SnapshotStore): void {
    this.snapshotFactories.set(pluginId, factory);
    if (this.snapshotStoreBuiltFrom === pluginId) {
      this._snapshotStore = null;
      this.snapshotStoreBuiltFrom = null;
    }
  }

  /**
   * Register a durable-state store factory under `pluginId` (#872).
   *
   * The factory is invoked at most once, on first resolution, and is handed
   * the `ActorSystem`.  A plug-in can read its backend's block there or at
   * registration through {@link config} — the same configuration either way,
   * since nothing layers over `system.config` once `ActorSystem.create` has
   * built it — and reading it in the factory leaves the block of a store
   * nobody resolves unread.  What a registration drops follows the rules of
   * {@link registerJournal}.
   */
  registerDurableStateStore(pluginId: string, factory: (system: ActorSystem) => DurableStateStore): void {
    this.durableStateFactories.set(pluginId, factory);
    if (this.durableStateStoreBuiltFrom === pluginId) {
      this._durableStateStore = null;
      this.durableStateStoreBuiltFrom = null;
    }
  }

  /** Resolve the active journal, instantiating it on first use. */
  get journal(): Journal {
    if (!this._journal) {
      const pluginId = this.currentJournalPluginId();
      const factory = this.journalFactories.get(pluginId);
      if (!factory) {
        throw new Error(
          `Unknown journal plugin '${pluginId}': no factory is registered under that id. `
            + `Register its backend through ActorSystemOptions.withPersistence({ plugins }) — e.g. `
            + `plugins: [(persistence) => registerPostgresPlugins(persistence)] — or correct `
            + `actor-ts.persistence.journal.plugin.`,
        );
      }
      this._journal = factory(this.system);
      this.journalBuiltFrom = pluginId;
    }
    return this._journal;
  }

  /** Resolve the active snapshot store, instantiating it on first use. */
  get snapshotStore(): SnapshotStore {
    if (!this._snapshotStore) {
      const pluginId = this.currentSnapshotPluginId();
      const factory = this.snapshotFactories.get(pluginId);
      if (!factory) {
        throw new Error(
          `Unknown snapshot-store plugin '${pluginId}': no factory is registered under that id. `
            + `Register its backend through ActorSystemOptions.withPersistence({ plugins }) — e.g. `
            + `plugins: [(persistence) => registerPostgresPlugins(persistence)] — or correct `
            + `actor-ts.persistence.snapshot-store.plugin.`,
        );
      }
      this._snapshotStore = factory(this.system);
      this.snapshotStoreBuiltFrom = pluginId;
    }
    return this._snapshotStore;
  }

  /** Resolve the active durable-state store, instantiating it on first use. */
  get durableStateStore(): DurableStateStore {
    if (!this._durableStateStore) {
      const pluginId = this.currentDurableStatePluginId();
      const factory = this.durableStateFactories.get(pluginId);
      if (!factory) {
        throw new Error(
          `Unknown durable-state plugin '${pluginId}': no factory is registered under that id. `
            + `Register its backend through ActorSystemOptions.withPersistence({ plugins }) — e.g. `
            + `plugins: [(persistence) => registerSqlitePlugins(persistence)] — or correct `
            + `actor-ts.persistence.durable-state.plugin.`,
        );
      }
      this._durableStateStore = factory(this.system);
      this.durableStateStoreBuiltFrom = pluginId;
    }
    return this._durableStateStore;
  }

  /**
   * Replace the active journal in code — useful for tests that need a spy.
   * A later registration of the selected plug-in does not replace it again.
   */
  setJournal(journal: Journal): void {
    this._journal = journal;
    this.journalBuiltFrom = null;
  }

  /** As {@link setJournal}, for the snapshot store. */
  setSnapshotStore(snapshotStore: SnapshotStore): void {
    this._snapshotStore = snapshotStore;
    this.snapshotStoreBuiltFrom = null;
  }

  /** As {@link setJournal}, for the durable-state store. */
  setDurableStateStore(durableStateStore: DurableStateStore): void {
    this._durableStateStore = durableStateStore;
    this.durableStateStoreBuiltFrom = null;
  }

  /**
   * Set any of the active journal, snapshot store and durable-state store in
   * one call — a thin convenience over {@link setJournal},
   * {@link setSnapshotStore} and {@link setDurableStateStore} for tests and
   * simple, single-backend apps that wire persistence directly in code rather
   * than through the config-selected `registerXxxPlugins` helpers.
   */
  configure(stores: {
    journal?: Journal;
    snapshotStore?: SnapshotStore;
    durableStateStore?: DurableStateStore;
  }): void {
    if (stores.journal !== undefined) this.setJournal(stores.journal);
    if (stores.snapshotStore !== undefined) this.setSnapshotStore(stores.snapshotStore);
    if (stores.durableStateStore !== undefined) this.setDurableStateStore(stores.durableStateStore);
  }

  /**
   * @internal Run the plug-ins `ActorSystemOptions.withPersistence({ plugins })`
   * names — called once, by the `ActorSystem` constructor, before it seals the
   * startup graph.
   *
   * In the order given and synchronously, which is what puts every factory in
   * the registry before `create` returns; a plug-in that throws propagates out
   * of `create`.  The promises the plug-ins return are awaited together by one
   * `persistence-plugins` task in the `persistence-start` phase, so a
   * registration that fails late — a peer-dependency probe, a key ring that
   * has to be fetched — fails the startup and takes the system down, where it
   * is reported once, rather than surfacing at the first persisted message.
   * Plug-ins that return no promise add no task, so a system wired only with
   * those is ready at once.
   */
  _runPlugins(plugins: ReadonlyArray<PersistencePlugin>): void {
    const registrations: Promise<unknown>[] = [];
    for (const plugin of plugins) {
      const returned = plugin(this);
      if (!isThenable(returned)) continue;
      const registration = Promise.resolve(returned);
      // Handled from the moment it is collected: a later plug-in that throws
      // fails `create`, and then nothing ever awaits this one — its rejection
      // must not come back as an unhandled one on top of the error `create`
      // already threw.  The task below still sees it.
      registration.catch(() => {});
      registrations.push(registration);
    }
    this.pluginRegistrations = registrations;
    if (registrations.length === 0) return;
    this.system.extension(CoordinatedStartupId).addTask(
      StartupPhases.PersistenceStart,
      'persistence-plugins',
      async () => { await Promise.all(registrations); },
    );
  }

  /**
   * @internal Resolve the selected journal, snapshot store and durable-state
   * store now and, unless the behaviour's `autoStart` is off, add the startup
   * task that opens them — called once, by the `ActorSystem` constructor,
   * after the plug-ins have run and the instances set in code are in place,
   * and before it seals the startup graph.
   *
   * **Resolved here, not in the task.**  The task runs a microtask after
   * `create` returns, by when the statement after `create` has run — so a
   * `register*Plugins` call there would be seen or not depending on where the
   * caller happened to put it.  Resolving inside `create` gives one answer
   * whatever the timing: the registry as the plug-ins left it.  A selection
   * that does not resolve becomes the task's failure, so it fails the startup
   * with the lookup's own `Unknown … plugin` message rather than making
   * `create` throw.
   *
   * **Opened in the task, once the plug-ins' promises settle.**  A plug-in may
   * register its factories and then finish something the stores depend on —
   * a peer-dependency probe, a key it fetches — so nothing opens before those
   * promises do.  One of them rejecting is the `persistence-plugins` task's
   * failure to report; the warm-up then opens nothing, which keeps one cause
   * per failed startup.  The stores open in parallel through `start?()`,
   * which is single-flight with their first operation, so an actor spawned on
   * the line after `create` shares the open rather than racing it.  The first
   * store that cannot open fails the startup, named.
   *
   * No task at all when nothing has anything to open — the in-memory stores
   * have no `start()` — so such a system is ready the moment the graph starts.
   */
  _prepareWarmUp(): void {
    if (!this.behavior.autoStart) return;
    const resolution = this.resolveSelectedStores();
    const opening = resolution.stores.filter((entry) => entry.store.start !== undefined);
    if (resolution.failure === undefined && opening.length === 0) return;
    const registrations = this.pluginRegistrations;
    this.system.extension(CoordinatedStartupId).addTask(
      StartupPhases.PersistenceStart,
      'persistence-warm-up',
      async () => {
        const settled = await Promise.allSettled(registrations);
        if (settled.some((outcome) => outcome.status === 'rejected')) return;
        if (resolution.failure !== undefined) throw resolution.failure;
        await Promise.all(opening.map((entry) => openAtStartup(entry)));
      },
    );
  }

  /**
   * The stores the three axes resolve to now, journal first, and the first
   * lookup that failed — after which nothing more is built, because the
   * startup is going down anyway.  Through the getters, so the warm-up opens
   * the very instances every later caller is handed.
   */
  private resolveSelectedStores(): SelectedStores {
    const stores: StoreToOpen[] = [];
    const axes: ReadonlyArray<() => StoreToOpen> = [
      () => ({ axis: 'journal', store: this.journal, pluginId: this.journalBuiltFrom }),
      () => ({ axis: 'snapshot store', store: this.snapshotStore, pluginId: this.snapshotStoreBuiltFrom }),
      () => ({ axis: 'durable-state store', store: this.durableStateStore, pluginId: this.durableStateStoreBuiltFrom }),
    ];
    for (const resolve of axes) {
      try {
        stores.push(resolve());
      } catch (error) {
        return { stores, failure: error };
      }
    }
    return { stores, failure: undefined };
  }

  /**
   * The two seams' shared body.
   *
   * The registry is read on every call, off `system._metricsRegistry` rather
   * than through `metricsOf` (#411): this runs once per append, and `null`
   * there means "metrics are off — build nothing", so a system that never
   * enabled them makes the breaker call it always made, with no clock read,
   * label object or closure besides.  Read fresh rather than cached, because
   * the registry is swapped at runtime — DevTools does it whenever a panel
   * opens or closes.
   */
  private callThrough<T>(
    breaker: CircuitBreaker | null,
    instruments: SeamInstruments,
    operation: string,
    isFailure: (error: Error) => boolean,
    call: () => Promise<T>,
  ): Promise<T> {
    const metrics = this.system._metricsRegistry;
    if (metrics === null) return breaker ? breaker.call(call, isFailure) : call();
    if (metrics !== this.breakerStatesPublishedTo) this.publishBreakerStates(metrics);
    return this.callObserved(metrics, breaker, instruments, operation, isFailure, call);
  }

  /**
   * {@link callThrough} with metrics on: how long the store took and, when it
   * failed, why.
   *
   * The clock starts inside the breaker, at the moment the call is let
   * through, so `startedAt` doubles as "the store was asked".  A call the open
   * breaker refused never sets it: it counts as `breaker-open` and is not
   * observed, because a stream of near-zero refusals would drag every quantile
   * toward zero exactly while the store is down.  Every call that did reach
   * the store is observed, a failed one included — a store that fails slowly
   * is the latency this exists to show, and a timed-out call is observed at the
   * `call-timeout` it waited out.
   *
   * An error the breaker excused through `ignored-error-names` is counted like
   * any other, under the reason its class gives.  The list decides what trips
   * the breaker; the counter reports what the store did, and an operator who
   * silenced a class for the breaker still wants to see how often it happens.
   *
   * `performance.now()` for the duration, as `Clock` asks of anything that
   * must not run backwards.
   *
   * The `try` holds the store call and nothing else (#1496).  How the call
   * ended is settled before the registry is touched, and every write after it
   * goes through {@link observeLatency} / {@link countFailure}, which cannot
   * throw — so the value returned and the error rethrown are always the
   * store's.
   */
  private async callObserved<T>(
    metrics: MetricsRegistry,
    breaker: CircuitBreaker | null,
    instruments: SeamInstruments,
    operation: string,
    isFailure: (error: Error) => boolean,
    call: () => Promise<T>,
  ): Promise<T> {
    // -1 until the store is asked, which is what tells a refusal from a failure.
    let startedAt = -1;
    const reach = (): Promise<T> => {
      startedAt = performance.now();
      return call();
    };
    let value: T;
    try {
      value = await (breaker ? breaker.call(reach, isFailure) : reach());
    } catch (error) {
      if (startedAt < 0) {
        this.countFailure(metrics, instruments, operation, 'breaker-open');
      } else {
        this.observeLatency(metrics, instruments, operation, startedAt);
        this.countFailure(metrics, instruments, operation, failureReasonOf(error));
      }
      throw error;
    }
    this.observeLatency(metrics, instruments, operation, startedAt);
    return value;
  }

  /** Observe a call that reached the store at `startedAt`, in seconds — never throwing; see {@link onRegistryRefusal}. */
  private observeLatency(
    metrics: MetricsRegistry,
    instruments: SeamInstruments,
    operation: string,
    startedAt: number,
  ): void {
    try {
      instruments.latency(metrics, operation).observe((performance.now() - startedAt) / 1_000);
    } catch (error) {
      this.onRegistryRefusal(metrics, error);
    }
  }

  /** Count one failed call under `reason` — never throwing; see {@link onRegistryRefusal}. */
  private countFailure(
    metrics: MetricsRegistry,
    instruments: SeamInstruments,
    operation: string,
    reason: PersistenceFailureReason,
  ): void {
    try {
      instruments.failures(metrics, operation, reason).inc();
    } catch (error) {
      this.onRegistryRefusal(metrics, error);
    }
  }

  /**
   * Resolve one breaker id, or `null` for the empty id.
   *
   * Deliberately with **no** explicit options: everything a breaker needs is
   * either in HOCON under its own id, where an operator can change it, or —
   * for {@link isStoreOutage}, which a config file cannot express — supplied
   * per call.  That leaves the shared instance identical however it is
   * reached, so `breaker(id)`'s documented first-caller-wins contract has
   * nothing left to drop here.
   *
   * Resolution is also where `persistence_breaker_state{breaker}` is wired
   * (#1496): a listener on the instance for every transition, and the state it
   * is in now, so a scrape sees a closed breaker as `0` rather than as no
   * series.  Persistence-only on purpose — a gauge for every breaker resolved by
   * id would belong to `CircuitBreakerExtension`, and is left to the issue that
   * gives the broker's hand-rolled breaker the same single home (#1478).
   */
  private resolveBreaker(role: PersistenceBreakerRole, id: string): CircuitBreaker | null {
    if (id === '') return null;
    const breaker = this.system.extension(CircuitBreakerExtensionId).breaker(id);
    breaker.onStateChange((state) => this.onBreakerStateChange(role, state));
    this.publishBreakerChange(role, breaker.state);
    return breaker;
  }

  /**
   * A persistence breaker moved.  Read the registry now rather than when the
   * listener was attached: the breaker outlives any one registry, and metrics
   * may have been switched on or off since.
   */
  private onBreakerStateChange(role: PersistenceBreakerRole, state: CircuitState): void {
    this.publishBreakerChange(role, state);
  }

  /**
   * A breaker was resolved or moved: tell the registry installed now, and stop
   * vouching for any other (#1496).
   *
   * {@link breakerStatesPublishedTo} names the registry known to hold every
   * resolved breaker's current state.  A change made while a different one is
   * installed — or none, metrics off — never reaches it, and the same instance
   * can be installed again: an application that switches its own registry off
   * and on.  Vouched for by identity alone, it went on reading the state from
   * before the change, `0` for an open breaker, or had no series for a breaker
   * resolved in between, until that breaker next moved.  Forgotten instead, it
   * is brought up to date by the next call through either seam, which is how
   * any registry installed late is.
   */
  private publishBreakerChange(role: PersistenceBreakerRole, state: CircuitState): void {
    const metrics = this.system._metricsRegistry;
    if (metrics !== null) this.publishBreakerState(metrics, role, state);
    if (metrics !== this.breakerStatesPublishedTo) this.breakerStatesPublishedTo = null;
  }

  /**
   * Bring `metrics` up to date with every breaker resolved so far, from the
   * first call through a seam that finds it is not the registry already up to
   * date — a new one, or one that missed a change (see
   * {@link publishBreakerChange}).
   *
   * The listeners keep the gauge current from there; this covers the registry
   * installed *after* the breakers were resolved — `enable()` late, or DevTools
   * opening a panel — which no transition has reached yet and which would
   * otherwise show no series for a breaker until it next moved.  Only resolved
   * breakers: resolving one here would build it from its HOCON block, and a
   * mistake in the snapshot breaker's block must not fail an append.
   */
  private publishBreakerStates(metrics: MetricsRegistry): void {
    this.breakerStatesPublishedTo = metrics;
    if (this._journalBreaker) this.publishBreakerState(metrics, 'journal', this._journalBreaker.state);
    if (this._snapshotBreaker) this.publishBreakerState(metrics, 'snapshot', this._snapshotBreaker.state);
  }

  private publishBreakerState(metrics: MetricsRegistry, role: PersistenceBreakerRole, state: CircuitState): void {
    try {
      metrics.gauge(
        'persistence_breaker_state', { breaker: role },
        { help: 'State of the circuit breaker in front of a persistence store: 0 closed, 1 half-open, 2 open.' },
      ).set(BREAKER_STATE_VALUE[state]);
    } catch (error) {
      this.onRegistryRefusal(metrics, error);
    }
  }

  /**
   * A registry write threw.  Reported once per registry and otherwise
   * swallowed (#1496): every write here happens beside a store call — before it
   * is made, or after it has ended — and how that call ended is the store's to
   * say.  Thrown from where it was, a refused write turned an append that
   * landed into a failure, replaced a store's own error with the registry's,
   * and failed recoveries whose journal held the data.
   *
   * A registry refuses for reasons of its own, most plausibly an application
   * family that already holds one of the stock names, written by code that
   * measured persistence before those families existed.  It then refuses every
   * later write under that name the same way, so a line per call would be a
   * flood with one fact in it; once per registry, because the next registry
   * installed — DevTools mints one per panel — has to earn its own line.
   *
   * The report is contained as well: a `Logger` is the caller's to supply,
   * and one that throws here would carry the throw back into the outcome this
   * method exists to keep it out of.
   */
  private onRegistryRefusal(metrics: MetricsRegistry, error: unknown): void {
    if (this.registriesReportedRefusing.has(metrics)) return;
    this.registriesReportedRefusing.add(metrics);
    try {
      this.log.warn(
        `[persistence] the metrics registry refused a persistence metric (${messageOf(error)}) — `
          + 'store calls are unaffected, and go unmeasured wherever the registry refuses; '
          + 'reported once for this registry',
        error,
      );
    } catch {
      // A sink that cannot take the line either: the outcome still stands.
    }
  }

  private currentJournalPluginId(): string {
    return readPersistencePluginIdsFromConfig(this.system.config).journal;
  }

  private currentSnapshotPluginId(): string {
    return readPersistencePluginIdsFromConfig(this.system.config).snapshotStore;
  }

  private currentDurableStatePluginId(): string {
    return readPersistencePluginIdsFromConfig(this.system.config).durableState;
  }
}

/** The plugin id each persistence axis resolves through. */
export type PersistencePluginIds = {
  readonly journal: string;
  readonly snapshotStore: string;
  readonly durableState: string;
};

/**
 * The three plugin selectors — `actor-ts.persistence.journal.plugin`,
 * `….snapshot-store.plugin` and `….durable-state.plugin` — each falling back to
 * the id the extension registers its in-memory reference store under when
 * nothing was written where it belongs.
 *
 * Exported, and the only place the extension reads them, so that the read a
 * per-block test asserts is the read the runtime makes: what binds a selector
 * is a test of what this returns, not the dead-key guard (#1425).
 *
 * Unlike the options readers it applies its own fallback instead of omitting
 * an absent key.  A selector has no explicit layer to fall through to — code
 * that picks a store calls `setJournal` / `configure`, which never consult it —
 * so what this returns is exactly the id the extension looks up.  The id is
 * not checked here: which ids exist depends on what was registered by the time
 * a store is resolved, so the lookup refuses an unknown one.  That includes
 * `""`, kept as a value rather than read as unset, because reading it as the
 * in-memory default would quietly keep a journal in memory.
 *
 * The id is handed on as written — not trimmed, not case-folded.  A plug-in
 * registered under a mixed-case id is selected by exactly that id, and
 * `" actor-ts.persistence.journal.postgres "` is an unknown id the lookup
 * refuses, not a near miss quietly corrected into a selection.
 *
 * **Only an empty place falls back.**  `Config.load` lays reference.conf
 * underneath every runtime config, so there a selector goes missing only when
 * a value has been written where its block belongs, or a block above it —
 * `actor-ts.persistence.durable-state = "actor-ts.persistence.durable-state.sqlite"`,
 * `actor-ts.persistence = "postgres"`.  Read as unset, that selected the
 * in-memory store with no error and the startup reported ready, and a
 * deployment that wrote its plug-in id onto the block lost its journal or its
 * state on the next restart.  Such a value is refused, naming the key and
 * saying it must be a block; an axis left as reference.conf ships it keeps the
 * in-memory default, as does a config with nothing at all under that path.
 *
 * The three are read together, so a selector holding no id at all — `null`, a
 * block, a list — or a value in place of a block is refused by whichever axis
 * resolves first rather than only by its own: it is a mistake in the file
 * whichever store the application uses.
 */
export function readPersistencePluginIdsFromConfig(config: Config): PersistencePluginIds {
  const keys = ConfigKeys.persistence;
  return {
    journal: readPluginId(config, keys.journal.plugin, keys.journal.inMemory, 'journal'),
    snapshotStore: readPluginId(config, keys.snapshotStore.plugin, keys.snapshotStore.inMemory.root, 'snapshot store'),
    durableState: readPluginId(config, keys.durableState.plugin, keys.durableState.inMemory, 'durable-state store'),
  };
}

/**
 * One selector: the id it holds, or `fallback` when nothing was written where
 * it belongs — refused when a value stands where its block, or a block above
 * it, belongs (see {@link readPersistencePluginIdsFromConfig}).
 */
function readPluginId(config: Config, selector: string, fallback: string, axis: StoreAxis): string {
  if (config.hasPath(selector)) return config.getString(selector);
  refuseValueWhereABlockBelongs(config, selector, axis);
  return fallback;
}

/**
 * Walk the blocks `selector` lives in, outermost first, and refuse the first
 * that holds a value instead.  Stops at the first that is not there at all —
 * nothing written, so nothing to refuse.
 */
function refuseValueWhereABlockBelongs(config: Config, selector: string, axis: StoreAxis): void {
  const segments = selector.split('.');
  for (let depth = 1; depth < segments.length; depth++) {
    const path = segments.slice(0, depth).join('.');
    if (!config.hasPath(path)) return;
    if (holdsBlock(config, path)) continue;
    const mustBe = depth === segments.length - 1 ? 'must be a block with a plugin field' : 'must be a block';
    throw new ConfigError(
      `Config at "${path}" ${mustBe}, not a value — select the ${axis} with `
        + `${selector} = "<plugin id>". Read as unset, it would quietly keep the ${axis} in memory.`,
    );
  }
}

/** Whether `path` holds a block, as opposed to a string, a number, a list or `null`. */
function holdsBlock(config: Config, path: string): boolean {
  try {
    config.getObject(path);
    return true;
  } catch (error) {
    if (error instanceof ConfigError) return false;
    throw error;
  }
}

/**
 * @internal Whether `config` selects, on any of the three axes, a plug-in
 * other than the in-memory one the extension registers itself — what the
 * `ActorSystem` constructor asks to decide whether to build the extension
 * inside `create`, so that a selection made in configuration alone is
 * resolved, and its stores opened, as part of the startup (#1473).
 *
 * A selector that holds no id at all, or a value where a block belongs,
 * answers yes: it is a mistake the resolution names, and naming it at startup
 * is the point.
 */
export function selectsPersistencePlugin(config: Config): boolean {
  let selected: PersistencePluginIds;
  try {
    selected = readPersistencePluginIdsFromConfig(config);
  } catch {
    return true;
  }
  const keys = ConfigKeys.persistence;
  return selected.journal !== keys.journal.inMemory
    || selected.snapshotStore !== keys.snapshotStore.inMemory.root
    || selected.durableState !== keys.durableState.inMemory;
}

/**
 * Open one store for the warm-up, and say which it was when it cannot be
 * opened.  The store's own error says what went wrong — a refused connection,
 * a missing driver — but not which of the three stores hit it, and with up to
 * three backends behind them that is an operator's first question.  The
 * store's error stays the `cause`.
 */
async function openAtStartup(entry: StoreToOpen): Promise<void> {
  try {
    await entry.store.start?.();
  } catch (error) {
    const source = entry.pluginId === null ? 'set in code' : `plugin '${entry.pluginId}'`;
    throw new Error(
      `the ${entry.axis} (${entry.store.constructor.name}, ${source}) could not be opened: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A returned promise, or anything else `await` would treat as one. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function';
}

export const PersistenceExtensionId: ExtensionId<PersistenceExtension> = extensionId(
  'PersistenceExtension',
  (system) => new PersistenceExtension(system, system._explicitPersistenceBehavior),
);
