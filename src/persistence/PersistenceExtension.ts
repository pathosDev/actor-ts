import type { ActorSystem } from '../ActorSystem.js';
import { ClusterExtensionId } from '../cluster/ClusterExtension.js';
import type { Config } from '../config/Config.js';
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
 */
export type PersistencePlugin = (persistence: PersistenceExtension) => unknown;

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
   * The registry `persistence_breaker_state` was last brought up to date in —
   * see {@link publishBreakerStates}.  `null` until metrics are first seen on.
   */
  private breakerStatesPublishedTo: MetricsRegistry | null = null;

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
   * the `ActorSystem` — which is the only route a plug-in has to
   * `system.config`, since the extension keeps its system private.  That is
   * the point: a backend's HOCON block is read *inside* the factory, so the
   * store is built from the merged settings rather than from whatever was
   * known at registration time.  What a registration drops follows the
   * rules of {@link registerJournal}.
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
    if (registrations.length === 0) return;
    this.system.extension(CoordinatedStartupId).addTask(
      StartupPhases.PersistenceStart,
      'persistence-plugins',
      async () => { await Promise.all(registrations); },
    );
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
    if (metrics !== this.breakerStatesPublishedTo) this.publishBreakerStates(metrics);
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
    const metrics = this.system._metricsRegistry;
    if (metrics !== null) this.publishBreakerState(metrics, role, breaker.state);
    return breaker;
  }

  /**
   * A persistence breaker moved.  Read the registry now rather than when the
   * listener was attached: the breaker outlives any one registry, and metrics
   * may have been switched on or off since.
   */
  private onBreakerStateChange(role: PersistenceBreakerRole, state: CircuitState): void {
    const metrics = this.system._metricsRegistry;
    if (metrics !== null) this.publishBreakerState(metrics, role, state);
  }

  /**
   * Bring `metrics` up to date with every breaker resolved so far — once per
   * registry, from the first call through a seam that sees it.
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
    metrics.gauge(
      'persistence_breaker_state', { breaker: role },
      { help: 'State of the circuit breaker in front of a persistence store: 0 closed, 1 half-open, 2 open.' },
    ).set(BREAKER_STATE_VALUE[state]);
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
 * the id the extension registers its in-memory reference store under.
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
 * The three are read together, so a selector holding no id at all — `null`, a
 * block, a list — is refused by whichever axis resolves first rather than only
 * by its own: it is a mistake in the file whichever store the application uses.
 */
export function readPersistencePluginIdsFromConfig(config: Config): PersistencePluginIds {
  const keys = ConfigKeys.persistence;
  return {
    journal: readPluginId(config, keys.journal.plugin, keys.journal.inMemory),
    snapshotStore: readPluginId(config, keys.snapshotStore.plugin, keys.snapshotStore.inMemory.root),
    durableState: readPluginId(config, keys.durableState.plugin, keys.durableState.inMemory),
  };
}

/** One selector: the id it holds, or `fallback` when it is absent. */
function readPluginId(config: Config, selector: string, fallback: string): string {
  return config.hasPath(selector) ? config.getString(selector) : fallback;
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
