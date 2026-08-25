import type { Logger } from '../Logger.js';
import type { StorageLocality, StorageUseKind } from './StorageLocality.js';

/**
 * The slice of a cluster the advisory needs — structural on purpose, so the
 * unit tests fake it without transports or timers, and so this module needs
 * no import from the cluster layer.  `Cluster` satisfies it as-is.
 */
export type ClusterStorageView = {
  /** Remote members present, or seed addresses configured — a standalone single node stays `false`. */
  expectsRemotePeers(): boolean;
  /** Membership subscription; returns the unsubscribe. */
  subscribe(
    listener: (event: unknown) => void,
    options?: { readonly replayMode?: 'events' | 'snapshot' },
  ): () => void;
};

/**
 * Where the advisory finds the cluster: the currently joined one, if any, and
 * a hook for every future registration.  The hook matters because of ordering
 * — `Cluster.join` registers the instance *before* `_start` populates the
 * seed list, and a `PersistentActor` may recover before any join at all — so
 * nothing here may snapshot `expectsRemotePeers()` at registration time.
 */
export type ClusterStorageSource = {
  current(): ClusterStorageView | null;
  onRegister(listener: (cluster: ClusterStorageView) => void): void;
};

type NodeLocalStoreUse = {
  readonly kind: StorageUseKind;
  readonly storeName: string;
  readonly level: 'warn' | 'error';
};

/**
 * One warning per system per store kind when `'node-local'` storage meets a
 * cluster that expects remote peers (#1356) — the same shape as the #941
 * TLS startup advisory: say it once, loudly, at the moment the combination
 * becomes real, and stay quiet in every case where saying it would be wrong.
 *
 * Quiet cases, each deliberate:
 *
 *   - **Undeclared or `'shared'` stores** — unknown is not evidence, and a
 *     shared-capable backend's remaining failure mode (two nodes on two
 *     *instances* of it) is the storage identity's job (#1358), not a
 *     declaration's.
 *   - **A standalone single node** — `expectsRemotePeers()` is false by
 *     construction, and per-node SQLite on one node is the documented
 *     production default.
 *   - **A cluster without persistent actors** — the latch sits at the store
 *     *use* seams (`PersistentActor` / `DurableStateActor` / the
 *     remember-entities wiring), never in the lazy `PersistenceExtension`
 *     getters, so the unused in-memory default journal cannot warn.
 *   - **Replicated event sourcing** — `ReplicatedEventSourcedActor` extends
 *     `Actor` and crosses none of those seams; its per-node journal is the
 *     intended design, exempt structurally rather than by flag.
 *   - **A cluster whose seeds never answer** — no membership event ever
 *     fires, so a parked note stays parked.  The cold-start diagnosis owns
 *     that failure (#1351, #1355); a storage warning on a cluster that never
 *     formed would point at the wrong subsystem.
 */
export class StorageLocalityAdvisory {
  private readonly reported = new Set<StorageUseKind>();
  private readonly pending = new Map<StorageUseKind, NodeLocalStoreUse>();
  private armedCluster: ClusterStorageView | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly source: ClusterStorageSource,
    private readonly log: Logger,
  ) {
    // Future joins (including leave + rejoin, which builds a NEW Cluster):
    // re-arm on the new instance so parked notes survive the swap.
    source.onRegister((cluster) => { if (this.pending.size > 0) this.arm(cluster); });
  }

  /**
   * Record that a store is actually in use for `kind`.  Reports immediately
   * when the cluster already expects remote peers; otherwise parks the note
   * and re-evaluates lazily on membership events, because peers may arrive
   * (or seeds be read) long after the first persistent actor recovered.
   */
  noteStoreUse(
    kind: StorageUseKind,
    store: { readonly storageLocality?: StorageLocality },
    level: 'warn' | 'error' = 'warn',
  ): void {
    if (store.storageLocality !== 'node-local') return;
    if (this.reported.has(kind) || this.pending.has(kind)) return;
    const use: NodeLocalStoreUse = { kind, storeName: store.constructor.name, level };
    const cluster = this.source.current();
    if (cluster !== null && cluster.expectsRemotePeers()) {
      this.report(use);
      return;
    }
    this.pending.set(kind, use);
    if (cluster !== null) this.arm(cluster);
  }

  private arm(cluster: ClusterStorageView): void {
    if (this.armedCluster === cluster) return;
    this.unsubscribe?.();
    this.armedCluster = cluster;
    // `snapshot` replay fires the listener once immediately, which doubles as
    // the evaluation for peers that arrived between `current()` and here.
    this.unsubscribe = cluster.subscribe(() => this.evaluate(cluster), { replayMode: 'snapshot' });
  }

  private evaluate(cluster: ClusterStorageView): void {
    if (!cluster.expectsRemotePeers()) return;
    for (const use of [...this.pending.values()]) this.report(use);
    this.pending.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.armedCluster = null;
  }

  private report(use: NodeLocalStoreUse): void {
    this.reported.add(use.kind);
    const message = nodeLocalStorageMessage(use.kind, use.storeName);
    if (use.level === 'error') this.log.error(message);
    else this.log.warn(message);
  }
}

/**
 * Names the failure, what the node is actually doing, and the ways out —
 * carrying the stable needle `node-local storage` so operators and tests can
 * filter for it, the same contract the TLS advisory's key name serves.
 */
function nodeLocalStorageMessage(kind: StorageUseKind, storeName: string): string {
  const rememberEntitiesConsequence = kind === 'remember-entities'
    ? ' On coordinator failover the next leader replays ITS OWN journal and forgets every remembered entity.'
    : '';
  return `persistence: ${kind} '${storeName}' declares node-local storage, but this cluster expects `
    + 'remote peers. Each node reads and writes only its own database, so an entity that moves between '
    + 'nodes recovers from whichever database it lands on — two nodes, two histories, and no error on '
    + `either (#1356).${rememberEntitiesConsequence} Use a shared backend for clustered persistent state `
    + '(Postgres, MariaDB, MSSQL, MongoDB, DynamoDB, Cassandra, libSQL, D1), or replicated event '
    + 'sourcing where a per-node journal is the intended design — see "Storage locality & identity" in '
    + 'the persistence overview documentation.';
}
