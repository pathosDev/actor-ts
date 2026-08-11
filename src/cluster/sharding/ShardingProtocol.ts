import type { ActorRef } from '../../ActorRef.js';
import type { NodeAddressData } from '../NodeAddress.js';

/**
 * Message types exchanged between ShardRegions and the ShardCoordinator.
 * They travel as plain actor messages (delivered locally or over the wire
 * as EnvelopeMessage.body) so the discriminator is a string `kind` property.
 */

export type RegisterRegion = {
  readonly kind: 'sharding.Register';
  readonly region: string; // full path of the sender region
  readonly node: NodeAddressData;
  readonly proxy: boolean;
  readonly hostedShards: number[]; // shards this region already hosts
};

export type RegisterAcknowledgment = {
  readonly kind: 'sharding.RegisterAcknowledgment';
  readonly coordinator: string;
};

export type GetShardHome = {
  readonly kind: 'sharding.GetShardHome';
  readonly shardId: number;
  readonly requester: string; // region path of the caller
  readonly requesterNode: NodeAddressData;
};

export type ShardHome = {
  readonly kind: 'sharding.ShardHome';
  readonly shardId: number;
  readonly region: string;
  readonly node: NodeAddressData;
};

export type BeginHandOff = {
  readonly kind: 'sharding.BeginHandOff';
  readonly shardId: number;
};

export type BeginHandOffAcknowledgment = {
  readonly kind: 'sharding.BeginHandOffAcknowledgment';
  readonly shardId: number;
};

export type HandOff = {
  readonly kind: 'sharding.HandOff';
  readonly shardId: number;
};

export type HandOffComplete = {
  readonly kind: 'sharding.HandOffComplete';
  readonly shardId: number;
  readonly region: string;
  readonly node: NodeAddressData;
};

export type RegionTerminated = {
  readonly kind: 'sharding.RegionTerminated';
  readonly region: string;
  readonly node: NodeAddressData;
};

export type EntityStarted = {
  readonly kind: 'sharding.EntityStarted';
  readonly shardId: number;
  readonly entityId: string;
};

export type EntityStopped = {
  readonly kind: 'sharding.EntityStopped';
  readonly shardId: number;
  readonly entityId: string;
};

export type RememberedEntities = {
  readonly kind: 'sharding.RememberedEntities';
  readonly shardId: number;
  readonly entityIds: string[];
};

/**
 * Region → coordinator: "re-send what you remember for this shard".
 *
 * Sent when a shard actor dies outside a handoff.  Ownership does not move in
 * that case, so neither `onRegister` nor `tryAllocate` runs and nothing else
 * would ever re-ship the registry — the shard comes back empty while the
 * coordinator still lists its entities.
 *
 * It carries no requester: the answer goes to whichever region `shardHome`
 * says owns the shard, which is the only region that could do anything with
 * it, and a region that has since lost the shard drops the reply anyway.
 */
export type GetRememberedEntities = {
  readonly kind: 'sharding.GetRememberedEntities';
  readonly shardId: number;
};

/* ----------------------- region ↔ shard (node-local) --------------------- */

/**
 * Addresses one entity by id instead of relying on `extractEntityId`.
 *
 * The region wraps every message bound for a local entity in this envelope
 * before handing it to the owning `Shard` — the shard has no extractor of its
 * own, and the id has already been computed one level up.  It is also the
 * on-the-wire shape a remote region forwards, so an envelope that arrives
 * inside a {@link ShardEnvelope} routes exactly like a locally created one.
 */
export type EntityEnvelope<TMessage = unknown> = {
  readonly kind: 'sharding.EntityEnvelope';
  readonly entityId: string;
  readonly message: TMessage;
};

/**
 * Region-driven passivation.  Both passivation policies — the idle sweep and
 * the `maxEntities` LRU — are decided by the region (it routes every message,
 * so it is the only place that sees activity across all shards on this node)
 * and executed by the shard that owns the entity.
 */
export type PassivateEntity = {
  readonly kind: 'sharding.PassivateEntity';
  readonly entityId: string;
};

/**
 * Region → region: hand `message` to shard `shardId` on the receiving node.
 *
 * A shard is addressable by path, but since #892 the actor behind that path
 * comes and goes — an empty one is stopped and re-created on demand — so a
 * path-addressed ref would drop whatever was sent while it was down (#901).
 * Remote shard traffic therefore goes to the region, which is always up and
 * materialises the shard before forwarding.  That is the shape the entity path
 * has always had: {@link ShardEnvelope} is addressed to the region too, never
 * to the entity itself.
 */
export type ToShard = {
  readonly kind: 'sharding.ToShard';
  readonly shardId: number;
  readonly message: unknown;
};

/** Pre-create remembered entities in a shard after it has been allocated here. */
export type StartEntities = {
  readonly kind: 'sharding.StartEntities';
  readonly entityIds: string[];
};

/* ----------------------------- introspection ---------------------------- */

/**
 * Bring an entity up without sending it anything (#151).  Useful to warm a
 * known-hot entity, or to re-establish one whose state is rebuilt in
 * `preStart`.
 */
export type StartEntity = {
  readonly kind: 'sharding.StartEntity';
  readonly entityId: string;
};

/**
 * Ask a shard what it is holding.  `replyTo` must be a ref the shard can
 * actually reach — an actor's own `self` works from any node; `ask()` works
 * when the shard is on the caller's node.  For the cluster-wide picture use
 * `ClusterSharding.shards()`, which routes its reply through the region.
 */
export type GetShardStats = {
  readonly kind: 'sharding.GetShardStats';
  readonly replyTo: ActorRef<ShardStats>;
};

export type ShardStats = {
  readonly kind: 'sharding.ShardStats';
  readonly shardId: number;
  readonly entityCount: number;
  readonly entityIds: ReadonlyArray<string>;
};

/** Coordinator → region leg of a cluster-wide stats query. */
export type GetShardRegionStats = {
  readonly kind: 'sharding.GetShardRegionStats';
  readonly queryId: number;
  readonly requester: string; // coordinator path
  readonly requesterNode: NodeAddressData;
};

export type ShardRegionStats = {
  readonly kind: 'sharding.ShardRegionStats';
  readonly queryId: number;
  readonly region: string;
  readonly node: NodeAddressData;
  readonly shards: ReadonlyArray<{
    readonly shardId: number;
    readonly entityCount: number;
    /** Whether the shard actor is materialised right now — see {@link ShardLocation}. */
    readonly resident: boolean;
  }>;
};

/**
 * Region → coordinator: the whole shard map with entity counts.  Replies are
 * addressed by path + node and correlated by id, like every other sharding
 * reply — an `ask` ref is not resolvable from another node, which is exactly
 * why the correlation machinery exists.
 */
export type GetClusterShardingStats = {
  readonly kind: 'sharding.GetClusterShardingStats';
  readonly correlationId: number;
  readonly requester: string; // region path of the caller
  readonly requesterNode: NodeAddressData;
  /** How long the coordinator waits for the regions it fanned out to. */
  readonly timeoutMs: number;
};

/** Where one shard lives, and how much it is holding.  Plain data — no refs. */
export type ShardLocation = {
  readonly shardId: number;
  readonly node: NodeAddressData;
  readonly regionPath: string;
  readonly entityCount: number;
  /**
   * Whether the owning region currently has a shard actor for it.  A shard
   * that passivated while empty stays allocated and addressable but is `false`
   * here until something wakes it — which `entityCount: 0` alone cannot tell
   * you, since a running-but-empty shard reports the same count.
   */
  readonly resident: boolean;
};

export type ClusterShardingStats = {
  readonly kind: 'sharding.ClusterShardingStats';
  readonly correlationId: number;
  readonly shards: ReadonlyArray<ShardLocation>;
};

/* --------------------- node-local queries on the region ------------------ */
/*
 * These two never leave the node.  `ClusterSharding` is a plain object, not an
 * actor, so it asks its own region — an in-process ask, whose reply ref works
 * — and lets the region do the cross-node part with the correlation machinery
 * it already owns.  That is also what lets the replies carry live `ActorRef`s:
 * they are built on the asking node, so nothing has to survive serialisation.
 */

/** `ClusterSharding.shards()` — answered with `ReadonlyArray<ShardInfo>`. */
export type GetShards = {
  readonly kind: 'sharding.GetShards';
  readonly timeoutMs: number;
};

/** `ClusterSharding.shardRefFor()` — answered with the shard's `ActorRef`. */
export type GetShardLocation = {
  readonly kind: 'sharding.GetShardLocation';
  readonly shardId: number;
};

/**
 * Coordinator → every registered region: the allocation map changed.
 *
 * Each region turns this into a local `ShardMapChanged` cluster event, which
 * is what gets the event onto *every* node — the coordinator only runs on the
 * leader, and a listener that only fires there is no use to a per-node panel.
 */
export type ShardMapUpdate = {
  readonly kind: 'sharding.ShardMapUpdate';
  readonly typeName: string;
  readonly version: number;
  /** `[shardId, regionKey][]` — a Map's wire shape. */
  readonly shards: ReadonlyArray<readonly [number, string]>;
  readonly regions: ReadonlyArray<{
    readonly key: string;
    readonly address: string;
    readonly path: string;
    readonly proxy: boolean;
    readonly shardCount: number;
  }>;
};

/**
 * Wraps a user message forwarded between ShardRegions, carrying the
 * information needed to route a reply back to the original asker.
 *
 * The origin region (where the ask started) stores the real sender keyed
 * by `correlationId` and forwards this envelope; the receiving region
 * materialises a synthetic sender ref bound to that correlationId so any
 * reply from the entity flows back as a `ShardReply`.
 */
export type ShardEnvelope = {
  readonly kind: 'sharding.Envelope';
  readonly message: unknown;
  readonly originNode: NodeAddressData | null;
  readonly originRegion: string | null;
  readonly correlationId: number | null;
};

/** Reply counterpart to {@link ShardEnvelope} — delivers a response to the asker. */
export type ShardReply = {
  readonly kind: 'sharding.Reply';
  readonly correlationId: number;
  readonly message: unknown;
};

export type ShardingMessage =
  | RegisterRegion
  | RegisterAcknowledgment
  | GetShardHome
  | ShardHome
  | BeginHandOff
  | BeginHandOffAcknowledgment
  | HandOff
  | HandOffComplete
  | RegionTerminated
  | EntityStarted
  | EntityStopped
  | RememberedEntities
  | GetRememberedEntities
  | ShardEnvelope
  | ShardReply
  | EntityEnvelope
  | ToShard
  | PassivateEntity
  | StartEntities
  | StartEntity
  | GetShardStats
  | GetShardRegionStats
  | ShardRegionStats
  | GetClusterShardingStats
  | ClusterShardingStats
  | GetShards
  | GetShardLocation
  | ShardMapUpdate;

export function isShardingMessage(message: unknown): message is ShardingMessage {
  return typeof message === 'object'
    && message !== null
    && typeof (message as { kind?: unknown }).kind === 'string'
    && (message as { kind: string }).kind.startsWith('sharding.');
}
