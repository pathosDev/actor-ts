import type { ActorSystem } from '../ActorSystem.js';
import { ClusterExtensionId } from '../cluster/ClusterExtension.js';
import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import type { DurableStateStore } from './DurableStateStore.js';
import { InMemoryDurableStateStore } from './durable-state-stores/InMemoryDurableStateStore.js';
import type { Journal } from './Journal.js';
import { InMemoryJournal } from './journals/InMemoryJournal.js';
import type { Logger } from '../Logger.js';
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
