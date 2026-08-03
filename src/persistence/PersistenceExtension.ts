import type { ActorSystem } from '../ActorSystem.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import type { Journal } from './Journal.js';
import { InMemoryJournal } from './journals/InMemoryJournal.js';
import type { SnapshotStore } from './SnapshotStore.js';
import { InMemorySnapshotStore } from './snapshot-stores/InMemorySnapshotStore.js';

/**
 * System-wide access point to the currently-configured journal and
 * snapshot store.  Plug-ins register a new factory through
 * `registerJournal` / `registerSnapshotStore`; the active plug-in is
 * chosen by the HOCON config path `actor-ts.persistence.journal.plugin`
 * (defaults to the in-memory reference implementation).
 */
export class PersistenceExtension implements Extension {
  private readonly journalFactories = new Map<string, (system: ActorSystem) => Journal>();
  private readonly snapshotFactories = new Map<string, (system: ActorSystem) => SnapshotStore>();

  private _journal: Journal | null = null;
  private _snapshotStore: SnapshotStore | null = null;

  constructor(private readonly system: ActorSystem) {
    // Ship the in-memory reference plug-in out of the box.
    this.registerJournal('actor-ts.persistence.journal.in-memory', () => new InMemoryJournal());
    this.registerSnapshotStore('actor-ts.persistence.snapshot-store.in-memory', () => new InMemorySnapshotStore());
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

  /** Replace the active journal in code — useful for tests that need a spy. */
  setJournal(journal: Journal): void { this._journal = journal; }
  setSnapshotStore(snapshotStore: SnapshotStore): void { this._snapshotStore = snapshotStore; }

  /**
   * Set the active journal and/or snapshot store in one call — a thin
   * convenience over {@link setJournal} / {@link setSnapshotStore} for tests
   * and simple, single-backend apps that wire persistence directly in code
   * rather than through the config-selected `registerXxxPlugins` helpers.
   */
  configure(stores: { journal?: Journal; snapshotStore?: SnapshotStore }): void {
    if (stores.journal !== undefined) this.setJournal(stores.journal);
    if (stores.snapshotStore !== undefined) this.setSnapshotStore(stores.snapshotStore);
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
      : ConfigKeys.persistence.snapshotStore.inMemory;
  }
}

export const PersistenceExtensionId: ExtensionId<PersistenceExtension> = extensionId(
  'PersistenceExtension',
  (system) => new PersistenceExtension(system),
);
