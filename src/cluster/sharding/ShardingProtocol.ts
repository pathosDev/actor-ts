import type { NodeAddressData } from '../NodeAddress.js';

/**
 * Message types exchanged between ShardRegions and the ShardCoordinator.
 * They travel as plain actor messages (delivered locally or over the wire
 * as EnvelopeMessage.body) so the discriminator is a string `$t` property.
 */

export interface RegisterRegion {
  readonly $t: 'sharding.Register';
  readonly region: string; // full path of the sender region
  readonly node: NodeAddressData;
  readonly proxy: boolean;
  readonly hostedShards: number[]; // shards this region already hosts
}

export interface RegisterAcknowledgment {
  readonly $t: 'sharding.RegisterAcknowledgment';
  readonly coordinator: string;
}

export interface GetShardHome {
  readonly $t: 'sharding.GetShardHome';
  readonly shardId: number;
  readonly requester: string; // region path of the caller
  readonly requesterNode: NodeAddressData;
}

export interface ShardHome {
  readonly $t: 'sharding.ShardHome';
  readonly shardId: number;
  readonly region: string;
  readonly node: NodeAddressData;
}

export interface BeginHandOff {
  readonly $t: 'sharding.BeginHandOff';
  readonly shardId: number;
}

export interface BeginHandOffAcknowledgment {
  readonly $t: 'sharding.BeginHandOffAcknowledgment';
  readonly shardId: number;
}

export interface HandOff {
  readonly $t: 'sharding.HandOff';
  readonly shardId: number;
}

export interface HandOffComplete {
  readonly $t: 'sharding.HandOffComplete';
  readonly shardId: number;
  readonly region: string;
  readonly node: NodeAddressData;
}

export interface RegionTerminated {
  readonly $t: 'sharding.RegionTerminated';
  readonly region: string;
  readonly node: NodeAddressData;
}

export interface EntityStarted {
  readonly $t: 'sharding.EntityStarted';
  readonly shardId: number;
  readonly entityId: string;
}

export interface EntityStopped {
  readonly $t: 'sharding.EntityStopped';
  readonly shardId: number;
  readonly entityId: string;
}

export interface RememberedEntities {
  readonly $t: 'sharding.RememberedEntities';
  readonly shardId: number;
  readonly entityIds: string[];
}

/**
 * Wraps a user message forwarded between ShardRegions, carrying the
 * information needed to route a reply back to the original asker.
 *
 * The origin region (where the ask started) stores the real sender keyed
 * by `correlationId` and forwards this envelope; the receiving region
 * materialises a synthetic sender ref bound to that correlationId so any
 * reply from the entity flows back as a `ShardReply`.
 */
export interface ShardEnvelope {
  readonly $t: 'sharding.Envelope';
  readonly message: unknown;
  readonly originNode: NodeAddressData | null;
  readonly originRegion: string | null;
  readonly correlationId: number | null;
}

/** Reply counterpart to {@link ShardEnvelope} — delivers a response to the asker. */
export interface ShardReply {
  readonly $t: 'sharding.Reply';
  readonly correlationId: number;
  readonly message: unknown;
}

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
  | ShardReply;

export function isShardingMessage(msg: unknown): msg is ShardingMessage {
  return typeof msg === 'object'
    && msg !== null
    && typeof (msg as { $t?: unknown }).$t === 'string'
    && (msg as { $t: string }).$t.startsWith('sharding.');
}
