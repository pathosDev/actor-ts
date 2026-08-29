import type { Logger } from '../Logger.js';
import type { StorageLocality, StorageUseKind } from './StorageLocality.js';

/**
 * The store-kind half of the gossiped identity vocabulary — string-identical
 * to `keyof StorageIdentitiesData` on the cluster side, and deliberately
 * declared here rather than imported: the advisory talks to the cluster
 * through the structural view below, and vocabulary shared by value would
 * be the one runtime edge this module is built not to have.
 */
export type StorageIdentityField = 'journal' | 'snapshotStore' | 'durableStateStore';

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
  /** Gossip one of this node's resolved store identities on the self member (#1358). */
  publishStorageIdentity(field: StorageIdentityField, identity: string): void;
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

/** The shape both seams hand in — any store contract satisfies it. */
export type ObservedStore = {
  readonly storageLocality?: StorageLocality;
  storageIdentity?(): Promise<string>;
};

/**
 * Which identity field a store use feeds.  `'remember-entities'` maps onto
 * the journal on purpose: the auto-wired registry IS the system journal, so
 * a sharded-daemon-only system still publishes a journal identity.
 */
const IDENTITY_FIELD_BY_KIND: Record<StorageUseKind, StorageIdentityField> = {
  'journal': 'journal',
  'snapshot-store': 'snapshotStore',
  'durable-state-store': 'durableStateStore',
  'remember-entities': 'journal',
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
  private readonly storageIdentitySources = new Map<StorageIdentityField, ObservedStore>();
  private readonly identityResolutionStarted = new Set<StorageIdentityField>();
  private readonly resolvedStorageIdentities = new Map<StorageIdentityField, string>();
  private armedCluster: ClusterStorageView | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly source: ClusterStorageSource,
    private readonly log: Logger,
  ) {
    // Future joins (including leave + rejoin, which builds a NEW Cluster):
    // re-publish what already resolved — the new instance starts with an
    // empty self record — resolve what was only parked, and re-arm so parked
    // notes survive the swap.
    source.onRegister((cluster) => {
      for (const [field, identity] of this.resolvedStorageIdentities) {
        cluster.publishStorageIdentity(field, identity);
      }
      this.resolveParkedStorageIdentities();
      if (this.pending.size > 0) this.arm(cluster);
    });
  }

  /**
   * Record that a store is actually in use for `kind`.  Reports immediately
   * when the cluster already expects remote peers; otherwise parks the note
   * and re-evaluates lazily on membership events, because peers may arrive
   * (or seeds be read) long after the first persistent actor recovered.
   */
  noteStoreUse(
    kind: StorageUseKind,
    store: ObservedStore,
    level: 'warn' | 'error' = 'warn',
  ): void {
    // Identity resolution runs for EVERY declared store, `'shared'` ones
    // above all — two nodes on two instances of a shared-capable backend is
    // precisely the case the locality half below cannot see (#1358).
    this.startStorageIdentityResolution(kind, store);
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

  /**
   * Remember which store answers for `field`, and resolve it once a cluster
   * exists.  Resolution is deliberately cluster-gated: it *writes* — the
   * identity is minted into the database on first contact — and a system
   * that never clusters must not grow a `storage_identity` row or object it
   * has no reader for.  The promise runs beside recovery, a failure logs at
   * debug and stays unknown, and the result reaches whichever cluster is
   * joined now or joins later.
   */
  private startStorageIdentityResolution(kind: StorageUseKind, store: ObservedStore): void {
    const field = IDENTITY_FIELD_BY_KIND[kind];
    if (this.identityResolutionStarted.has(field)) return;
    if (store.storageIdentity === undefined) return;
    if (!this.storageIdentitySources.has(field)) this.storageIdentitySources.set(field, store);
    if (this.source.current() !== null) this.resolveParkedStorageIdentities();
  }

  private resolveParkedStorageIdentities(): void {
    for (const [field, store] of this.storageIdentitySources) {
      if (this.identityResolutionStarted.has(field)) continue;
      this.identityResolutionStarted.add(field);
      void store.storageIdentity!.call(store).then(
        (identity) => {
          this.resolvedStorageIdentities.set(field, identity);
          this.source.current()?.publishStorageIdentity(field, identity);
        },
        (reason) => this.log.debug(
          `persistence: ${field} storage identity unresolved — treated as unknown (#1358): ${String(reason)}`,
        ),
      );
    }
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
