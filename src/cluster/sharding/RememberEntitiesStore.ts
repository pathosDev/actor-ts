import type { Journal } from '../../persistence/Journal.js';
import { REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS } from '../Constants.js';

/**
 * Append-only event recording an entity's lifecycle on the
 * coordinator side.  The coordinator emits one of these every time
 * `onEntityStarted` or `onEntityStopped` runs (when
 * `rememberEntities: true`); replaying the full event log on
 * coordinator restart rebuilds the in-memory `entitiesPerShard` map.
 */
export type StartedEvent = { readonly kind: 'started'; readonly shardId: number; readonly entityId: string };
export type StoppedEvent = { readonly kind: 'stopped'; readonly shardId: number; readonly entityId: string };

export type RememberEvent = StartedEvent | StoppedEvent;

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
   * Replay what rebuilds the registry for `typeName`, in order: every event
   * ever recorded, or — for a store that compacts, as the journal-backed one
   * does (#649) — `started` events for the entities live at the last
   * compaction followed by everything recorded since.  Folding the result
   * gives the same set either way.  Returns an empty array if nothing's been
   * written.  Called once per coordinator preStart.
   */
  load(typeName: string): Promise<RememberEvent[]>;

  /** Forget every event for `typeName`.  Used by tests + reset tooling. */
  clear(typeName: string): Promise<void>;
}

/**
 * What {@link JournalRememberEntitiesStore} writes in place of the history it
 * compacts: the live entity set, by shard (#649).  Journal-internal — `load`
 * expands it into `started` events, so the coordinator never sees this kind.
 */
type RememberedSnapshotEvent = {
  readonly kind: 'snapshot';
  readonly entities: ReadonlyArray<readonly [number, ReadonlyArray<string>]>;
};

/** Everything the remember-entities stream can hold. */
type StoredRememberEvent = RememberEvent | RememberedSnapshotEvent;

/**
 * Default `RememberEntitiesStore` impl backed by any `Journal`.
 * Stores events under `persistenceId = "sharding-coordinator-{typeName}"`
 * so a custom journal layout doesn't collide with regular event-
 * sourced actors (which use the user-defined `persistenceId`).
 *
 * Tagged with `'sharding-remember'` so users can spot the registry
 * in tag-based projections / queries if they want to audit it.
 *
 * **Compacted, so a start replays a bounded amount (#649).**  One event per
 * entity start and stop, read from sequence 1 on every coordinator start, grew
 * forever: with passivation on, every idle-then-wake cycle adds two, and the
 * coordinator awaits the whole replay before it handles a message.  Once
 * `max(REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS, last snapshot size)` events
 * have been appended behind the last snapshot, the store reads the stream,
 * folds it into one `snapshot` event carrying the live set, appends that, and
 * deletes everything before it.  `load` then reads one snapshot and at most
 * one interval of tail, however long the type has churned.
 *
 * **The snapshot is the stream's own head, so a compaction never empties it.**
 * A stream compacted to nothing is what #1052 refuses for an event-sourced
 * actor — the high-water mark says events existed and none survive — and here
 * it would silently forget every entity.  The delete stops one short of the
 * snapshot.  It runs after the snapshot is written, so a delete that fails
 * leaves a longer stream, never a shorter one, and `load` starts at the *last*
 * snapshot it reads, so the leftover prefix changes nothing.
 *
 * **Fenced against a second writer.**  The snapshot is appended with the head
 * its fold read as `expectedSeq`, so an event another coordinator wrote in
 * between — which only a split brain allows — fails the append with
 * `JournalConcurrencyError` instead of being folded away; the compaction gives
 * up and the next interval tries again.  A compaction failure is never an
 * `append` failure: the event the caller asked for was already written.
 *
 * **Layout.**  A stream written before #649 holds no `snapshot` event and loads
 * exactly as it did.  A stream this version has compacted holds one, which an
 * earlier version does not understand — so a downgrade past #649 is not
 * supported for a type whose registry has been compacted.
 */
export class JournalRememberEntitiesStore implements RememberEntitiesStore {
  /** Per type: events appended behind the last snapshot, as far as this store knows. */
  private readonly tailLengths = new Map<string, number>();
  /** Per type: the tail length at which the next compaction runs. */
  private readonly compactAt = new Map<string, number>();

  constructor(private readonly journal: Journal) {}

  private persistenceIdFor(typeName: string): string {
    return `sharding-coordinator-${typeName}`;
  }

  async append(typeName: string, event: RememberEvent): Promise<void> {
    const persistenceId = this.persistenceIdFor(typeName);
    const head = await this.journal.highestSeq(persistenceId);
    await this.journal.append(persistenceId, [{ event, tags: ['sharding-remember'] }], head);
    const tailLength = (this.tailLengths.get(typeName) ?? 0) + 1;
    this.tailLengths.set(typeName, tailLength);
    if (tailLength >= (this.compactAt.get(typeName) ?? REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS)) {
      await this.compact(typeName);
    }
  }

  async load(typeName: string): Promise<RememberEvent[]> {
    const persistenceId = this.persistenceIdFor(typeName);
    const stored = await this.journal.read<StoredRememberEvent>(persistenceId, 1);
    const { snapshot, tail } = splitAtLastSnapshot(stored.map((persisted) => persisted.event));
    this.tailLengths.set(typeName, tail.length);
    this.compactAt.set(typeName, compactionInterval(snapshot));
    return [...expandSnapshot(snapshot), ...tail];
  }

  async clear(typeName: string): Promise<void> {
    const persistenceId = this.persistenceIdFor(typeName);
    const head = await this.journal.highestSeq(persistenceId);
    if (head > 0) await this.journal.delete(persistenceId, head);
    this.tailLengths.delete(typeName);
    this.compactAt.delete(typeName);
  }

  /**
   * Fold the stream into one snapshot event and delete what it covers — see
   * the class doc for why each step is in this order.  Whatever goes wrong,
   * the next attempt waits one more interval: a journal that refuses the
   * delete or the append must not be hit with a full read on every append.
   */
  private async compact(typeName: string): Promise<void> {
    const persistenceId = this.persistenceIdFor(typeName);
    try {
      const head = await this.journal.highestSeq(persistenceId);
      const stored = await this.journal.read<StoredRememberEvent>(persistenceId, 1, head);
      const live = foldLiveEntities(stored.map((persisted) => persisted.event));
      const snapshot: RememberedSnapshotEvent = {
        kind: 'snapshot',
        entities: Array.from(live, ([shardId, entityIds]) => [shardId, Array.from(entityIds)] as const),
      };
      const [written] = await this.journal.append<StoredRememberEvent>(
        persistenceId,
        [{ event: snapshot, tags: ['sharding-remember'] }],
        head,
      );
      this.tailLengths.set(typeName, 0);
      this.compactAt.set(typeName, compactionInterval(snapshot));
      if (written !== undefined && written.sequenceNr > 1) {
        await this.journal.delete(persistenceId, written.sequenceNr - 1);
      }
    } catch {
      const tailLength = this.tailLengths.get(typeName) ?? 0;
      this.compactAt.set(typeName, tailLength + REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS);
    }
  }
}

/** The appends a snapshot of this size buys before the next compaction is worth its read. */
function compactionInterval(snapshot: RememberedSnapshotEvent | null): number {
  let size = 0;
  for (const [, entityIds] of snapshot?.entities ?? []) size += entityIds.length;
  return Math.max(REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS, size);
}

/** The last snapshot in `events`, and the lifecycle events after it. */
function splitAtLastSnapshot(
  events: ReadonlyArray<StoredRememberEvent>,
): { readonly snapshot: RememberedSnapshotEvent | null; readonly tail: RememberEvent[] } {
  let snapshot: RememberedSnapshotEvent | null = null;
  let tail: RememberEvent[] = [];
  for (const event of events) {
    if (event.kind === 'snapshot') {
      snapshot = event;
      tail = [];
    } else {
      tail.push(event);
    }
  }
  return { snapshot, tail };
}

/** A snapshot as the `started` events that rebuild it. */
function expandSnapshot(snapshot: RememberedSnapshotEvent | null): StartedEvent[] {
  const started: StartedEvent[] = [];
  for (const [shardId, entityIds] of snapshot?.entities ?? []) {
    for (const entityId of entityIds) started.push({ kind: 'started', shardId, entityId });
  }
  return started;
}

/** The live entity set `events` describe, by shard — the fold the coordinator runs over `load`. */
function foldLiveEntities(events: ReadonlyArray<StoredRememberEvent>): Map<number, Set<string>> {
  const { snapshot, tail } = splitAtLastSnapshot(events);
  const live = new Map<number, Set<string>>();
  for (const event of [...expandSnapshot(snapshot), ...tail]) {
    let entityIds = live.get(event.shardId);
    if (event.kind === 'started') {
      if (entityIds === undefined) {
        entityIds = new Set();
        live.set(event.shardId, entityIds);
      }
      entityIds.add(event.entityId);
    } else if (entityIds !== undefined) {
      entityIds.delete(event.entityId);
      if (entityIds.size === 0) live.delete(event.shardId);
    }
  }
  return live;
}
