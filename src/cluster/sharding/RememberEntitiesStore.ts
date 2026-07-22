import type { Journal } from '../../persistence/Journal.js';

/**
 * Append-only event recording an entity's lifecycle on the
 * coordinator side.  The coordinator emits one of these every time
 * `onEntityStarted` or `onEntityStopped` runs (when
 * `rememberEntities: true`); replaying the full event log on
 * coordinator restart rebuilds the in-memory `entitiesPerShard` map.
 */
export type RememberEvent =
  | { readonly kind: 'started'; readonly shardId: number; readonly entityId: string }
  | { readonly kind: 'stopped'; readonly shardId: number; readonly entityId: string };

/**
 * Pluggable persistence backend for the sharded-entity registry.  The
 * default `JournalRememberEntitiesStore` reuses the system's `Journal`
 * — same plumbing that backs `PersistentActor`, so any Journal
 * implementation (in-memory, SQLite, Cassandra, …) works out of the
 * box.  Custom impls can hit a different store entirely (e.g. a
 * standalone SQLite DB for the registry, separate from the event
 * journal).
 *
 * **Concurrency**: `append` is called serially by the coordinator
 * (it chains writes via a promise-of-the-last-write), so impls don't
 * need to handle concurrent appends to the same `typeName`.
 */
export interface RememberEntitiesStore {
  /** Persist a single entity-lifecycle event. */
  append(typeName: string, event: RememberEvent): Promise<void>;

  /**
   * Replay every event ever recorded for `typeName`, in append order.
   * Returns an empty array if nothing's been written.  Called once
   * per coordinator preStart.
   */
  load(typeName: string): Promise<RememberEvent[]>;

  /** Forget every event for `typeName`.  Used by tests + reset tooling. */
  clear(typeName: string): Promise<void>;
}

/**
 * Default `RememberEntitiesStore` impl backed by any `Journal`.
 * Stores events under `persistenceId = "sharding-coordinator-{typeName}"`
 * so a custom journal layout doesn't collide with regular event-
 * sourced actors (which use the user-defined `persistenceId`).
 *
 * Tagged with `'sharding-remember'` so users can spot the registry
 * in tag-based projections / queries if they want to audit it.
 */
export class JournalRememberEntitiesStore implements RememberEntitiesStore {
  constructor(private readonly journal: Journal) {}

  private persistenceIdFor(typeName: string): string {
    return `sharding-coordinator-${typeName}`;
  }

  async append(typeName: string, event: RememberEvent): Promise<void> {
    const persistenceId = this.persistenceIdFor(typeName);
    const head = await this.journal.highestSeq(persistenceId);
    await this.journal.append(persistenceId, [event], head, ['sharding-remember']);
  }

  async load(typeName: string): Promise<RememberEvent[]> {
    const persistenceId = this.persistenceIdFor(typeName);
    const events = await this.journal.read<RememberEvent>(persistenceId, 1);
    return events.map((pe) => pe.event);
  }

  async clear(typeName: string): Promise<void> {
    const persistenceId = this.persistenceIdFor(typeName);
    const head = await this.journal.highestSeq(persistenceId);
    if (head > 0) await this.journal.delete(persistenceId, head);
  }
}
