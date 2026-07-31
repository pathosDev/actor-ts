import type { NodeAddressData } from '../NodeAddress.js';

/**
 * Message types exchanged between ShardRegions and the ShardCoordinator.
 * They travel as plain actor messages (delivered locally or over the wire
 * as EnvelopeMessage.body) so the discriminator is a string `$t` property.
 */

export type RegisterRegion = {
  readonly $t: 'sharding.Register';
  readonly region: string; // full path of the sender region
  readonly node: NodeAddressData;
  readonly proxy: boolean;
  readonly hostedShards: number[]; // shards this region already hosts
};

export type RegisterAcknowledgment = {
  readonly $t: 'sharding.RegisterAcknowledgment';
  readonly coordinator: string;
};

export type GetShardHome = {
  readonly $t: 'sharding.GetShardHome';
  readonly shardId: number;
  readonly requester: string; // region path of the caller
  readonly requesterNode: NodeAddressData;
};

export type ShardHome = {
  readonly $t: 'sharding.ShardHome';
  readonly shardId: number;
  readonly region: string;
  readonly node: NodeAddressData;
};

export type BeginHandOff = {
  readonly $t: 'sharding.BeginHandOff';
  readonly shardId: number;
};

export type BeginHandOffAcknowledgment = {
  readonly $t: 'sharding.BeginHandOffAcknowledgment';
  readonly shardId: number;
};

export type HandOff = {
  readonly $t: 'sharding.HandOff';
  readonly shardId: number;
};

export type HandOffComplete = {
  readonly $t: 'sharding.HandOffComplete';
  readonly shardId: number;
  readonly region: string;
  readonly node: NodeAddressData;
};

export type RegionTerminated = {
  readonly $t: 'sharding.RegionTerminated';
  readonly region: string;
  readonly node: NodeAddressData;
};

export type EntityStarted = {
  readonly $t: 'sharding.EntityStarted';
  readonly shardId: number;
  readonly entityId: string;
};

export type EntityStopped = {
  readonly $t: 'sharding.EntityStopped';
  readonly shardId: number;
  readonly entityId: string;
};

export type RememberedEntities = {
  readonly $t: 'sharding.RememberedEntities';
  readonly shardId: number;
  readonly entityIds: string[];
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
export type EntityEnvelope = {
  readonly $t: 'sharding.EntityEnvelope';
  readonly entityId: string;
  readonly message: unknown;
};

/**
 * Region-driven passivation.  Both passivation policies — the idle sweep and
 * the `maxEntities` LRU — are decided by the region (it routes every message,
 * so it is the only place that sees activity across all shards on this node)
 * and executed by the shard that owns the entity.
 */
export type PassivateEntity = {
  readonly $t: 'sharding.PassivateEntity';
  readonly entityId: string;
};

/** Pre-create remembered entities in a shard after it has been allocated here. */
export type StartEntities = {
  readonly $t: 'sharding.StartEntities';
  readonly entityIds: string[];
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
  readonly $t: 'sharding.Envelope';
  readonly message: unknown;
  readonly originNode: NodeAddressData | null;
  readonly originRegion: string | null;
  readonly correlationId: number | null;
};

/** Reply counterpart to {@link ShardEnvelope} — delivers a response to the asker. */
export type ShardReply = {
  readonly $t: 'sharding.Reply';
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
  | ShardEnvelope
  | ShardReply
  | EntityEnvelope
  | PassivateEntity
  | StartEntities;

export function isShardingMessage(message: unknown): message is ShardingMessage {
  return typeof message === 'object'
    && message !== null
    && typeof (message as { $t?: unknown }).$t === 'string'
    && (message as { $t: string }).$t.startsWith('sharding.');
}
