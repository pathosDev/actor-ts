import type { ActorSystem } from '../ActorSystem.js';
import { ClusterExtensionId } from '../cluster/ClusterExtension.js';
import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import type { DurableStateStore } from './DurableStateStore.js';
import { InMemoryDurableStateStore } from './durable-state-stores/InMemoryDurableStateStore.js';
import type { Journal } from './Journal.js';
import { InMemoryJournal } from './journals/InMemoryJournal.js';
import { JournalConcurrencyError } from './JournalTypes.js';
import type { Logger } from '../Logger.js';
import type { Counter, Histogram, MetricsRegistry } from '../metrics/Metrics.js';
import { CircuitBreakerTimeoutError, type CircuitBreaker } from '../pattern/CircuitBreaker.js';
import { CircuitBreakerExtensionId } from '../pattern/CircuitBreakerExtension.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import {
  DEFAULT_JOURNAL_BREAKER_ID,
  DEFAULT_MAX_CONCURRENT_RECOVERIES,
  DEFAULT_RECOVERY_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_BREAKER_ID,
  DEFAULT_SNAPSHOT_IS_OPTIONAL,
  PersistenceBehaviorOptionsValidator,
  readPersistenceBehaviorOptionsFromConfig,
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
 * System-wide access point to the currently-configured journal, snapshot store
 * and durable-state store.  Plug-ins register a new factory through
 * `registerJournal` / `registerSnapshotStore` / `registerDurableStateStore`;
 * the active plug-in is chosen by the HOCON config path
 * `actor-ts.persistence.<axis>.plugin`, each defaulting to the in-memory
 * reference implementation.
 *
 * **Three axes, not two (#872).**  Durable state was the one persistence
 * contract with no registry: every `register*Plugins` helper built its store
 * eagerly and handed it back as a return value, so a `DurableStateActor` could
 * only be wired by threading that instance through application code, and
 * `actor-ts.persistence.durable-state.<backend>` named a plugin id nothing
 * could select.  The nine `*_DURABLE_STATE_PLUGIN_ID` constants the backends
 * already exported were dead exports for precisely that reason.
 */
/**
 * Does this error mean the store is unavailable, as opposed to having
 * answered a question?  The `isFailure` classifier both persistence breakers
 * are *called* with (#874).
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

/**
 * Why a call through a persistence seam failed — the `reason` label of the two
 * failure families (#1496).  A closed set, so a dashboard can enumerate it:
 *
 *   - `outage` — anything the store threw that is none of the below; what the
 *     breaker counts.
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

export class PersistenceExtension implements Extension {
  private readonly journalFactories = new Map<string, (system: ActorSystem) => Journal>();
  private readonly snapshotFactories = new Map<string, (system: ActorSystem) => SnapshotStore>();
  private readonly durableStateFactories = new Map<string, (system: ActorSystem) => DurableStateStore>();

  private _journal: Journal | null = null;
  private _snapshotStore: SnapshotStore | null = null;
  private _durableStateStore: DurableStateStore | null = null;
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
  private _recoveryPermits: RecoveryPermits | null = null;
  /** `undefined` = not resolved yet, `null` = deliberately no breaker. */
  private _journalBreaker: CircuitBreaker | null | undefined;
  private _snapshotBreaker: CircuitBreaker | null | undefined;

  constructor(private readonly system: ActorSystem) {
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
   * The merged `actor-ts.persistence` behaviour settings (#874), resolved and
   * validated once on first read.
   *
   * Lazily rather than in the constructor because the extension is built the
   * first time *anything* touches persistence — including a system that only
   * registers a plugin and never spawns a persistent actor — and a validation
   * throw there would surface as a failure to construct the extension rather
   * than as a configuration error naming the field.
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
      },
      readPersistenceBehaviorOptionsFromConfig(this.system.config),
      {},
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
      this._journalBreaker = this.resolveBreaker(this.behavior.journalBreaker);
    }
    return this._journalBreaker;
  }

  /** As {@link journalBreaker}, for the snapshot store. */
  get snapshotBreaker(): CircuitBreaker | null {
    if (this._snapshotBreaker === undefined) {
      this._snapshotBreaker = this.resolveBreaker(this.behavior.snapshotBreaker);
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
   */
  callThroughJournalBreaker<T>(operation: JournalOperation, call: () => Promise<T>): Promise<T> {
    return this.callThrough(this.journalBreaker, journalInstruments, operation, call);
  }

  /**
   * As {@link callThroughJournalBreaker}, for the snapshot store and its
   * `persistence_snapshot_*` twins.
   */
  callThroughSnapshotBreaker<T>(operation: SnapshotOperation, call: () => Promise<T>): Promise<T> {
    return this.callThrough(this.snapshotBreaker, snapshotInstruments, operation, call);
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

  registerJournal(pluginId: string, factory: (system: ActorSystem) => Journal): void {
    this.journalFactories.set(pluginId, factory);
    // If the active journal changed, force re-lookup.
    if (this._journal && this.currentJournalPluginId() === pluginId) this._journal = null;
  }

  registerSnapshotStore(pluginId: string, factory: (system: ActorSystem) => SnapshotStore): void {
    this.snapshotFactories.set(pluginId, factory);
    if (this._snapshotStore && this.currentSnapshotPluginId() === pluginId) this._snapshotStore = null;
  }

  /**
   * Register a durable-state store factory under `pluginId` (#872).
   *
   * The factory is invoked at most once, on first resolution, and is handed
   * the `ActorSystem` — which is the only route a plug-in has to
   * `system.config`, since the extension keeps its system private.  That is
   * the point: a backend's HOCON block is read *inside* the factory, so the
   * store is built from the merged settings rather than from whatever was
   * known at registration time.
   */
  registerDurableStateStore(pluginId: string, factory: (system: ActorSystem) => DurableStateStore): void {
    this.durableStateFactories.set(pluginId, factory);
    if (this._durableStateStore && this.currentDurableStatePluginId() === pluginId) this._durableStateStore = null;
  }

  /** Resolve the active journal, instantiating it on first use. */
  get journal(): Journal {
    if (!this._journal) {
      const pluginId = this.currentJournalPluginId();
      const factory = this.journalFactories.get(pluginId);
      if (!factory) {
        throw new Error(
          `Unknown journal plugin '${pluginId}': no factory is registered under that id. `
            + `Register the backend (e.g. registerPostgresPlugins(ext, ...)) before the first `
            + `PersistentActor is created, or correct actor-ts.persistence.journal.plugin.`,
        );
      }
      this._journal = factory(this.system);
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
            + `Register the backend (e.g. registerPostgresPlugins(ext, ...)) before the first `
            + `PersistentActor is created, or correct actor-ts.persistence.snapshot-store.plugin.`,
        );
      }
      this._snapshotStore = factory(this.system);
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
            + `Register the backend (e.g. registerSqlitePlugins(ext, ...)) before the first `
            + `DurableStateActor is created, or correct actor-ts.persistence.durable-state.plugin.`,
        );
      }
      this._durableStateStore = factory(this.system);
    }
    return this._durableStateStore;
  }

  /** Replace the active journal in code — useful for tests that need a spy. */
  setJournal(journal: Journal): void { this._journal = journal; }
  setSnapshotStore(snapshotStore: SnapshotStore): void { this._snapshotStore = snapshotStore; }
  setDurableStateStore(durableStateStore: DurableStateStore): void { this._durableStateStore = durableStateStore; }

  /**
   * Set the active journal and/or snapshot store in one call — a thin
   * convenience over {@link setJournal} / {@link setSnapshotStore} for tests
   * and simple, single-backend apps that wire persistence directly in code
   * rather than through the config-selected `registerXxxPlugins` helpers.
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
    call: () => Promise<T>,
  ): Promise<T> {
    const metrics = this.system._metricsRegistry;
    if (metrics === null) return breaker ? breaker.call(call, isStoreOutage) : call();
    return this.callObserved(metrics, breaker, instruments, operation, call);
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
   */
  private async callObserved<T>(
    metrics: MetricsRegistry,
    breaker: CircuitBreaker | null,
    instruments: SeamInstruments,
    operation: string,
    call: () => Promise<T>,
  ): Promise<T> {
    // -1 until the store is asked, which is what tells a refusal from a failure.
    let startedAt = -1;
    const reach = (): Promise<T> => {
      startedAt = performance.now();
      return call();
    };
    try {
      const value = await (breaker ? breaker.call(reach, isStoreOutage) : reach());
      instruments.latency(metrics, operation).observe((performance.now() - startedAt) / 1_000);
      return value;
    } catch (error) {
      if (startedAt < 0) {
        instruments.failures(metrics, operation, 'breaker-open').inc();
      } else {
        instruments.latency(metrics, operation).observe((performance.now() - startedAt) / 1_000);
        instruments.failures(metrics, operation, failureReasonOf(error)).inc();
      }
      throw error;
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
   */
  private resolveBreaker(id: string): CircuitBreaker | null {
    if (id === '') return null;
    return this.system.extension(CircuitBreakerExtensionId).breaker(id);
  }

  private currentJournalPluginId(): string {
    const key = ConfigKeys.persistence.journal.plugin;
    return this.system.config.hasPath(key)
      ? this.system.config.getString(key)
      : ConfigKeys.persistence.journal.inMemory;
  }

  private currentSnapshotPluginId(): string {
    const key = ConfigKeys.persistence.snapshotStore.plugin;
    return this.system.config.hasPath(key)
      ? this.system.config.getString(key)
      : ConfigKeys.persistence.snapshotStore.inMemory.root;
  }

  private currentDurableStatePluginId(): string {
    const key = ConfigKeys.persistence.durableState.plugin;
    return this.system.config.hasPath(key)
      ? this.system.config.getString(key)
      : ConfigKeys.persistence.durableState.inMemory;
  }
}

export const PersistenceExtensionId: ExtensionId<PersistenceExtension> = extensionId(
  'PersistenceExtension',
  (system) => new PersistenceExtension(system),
);
