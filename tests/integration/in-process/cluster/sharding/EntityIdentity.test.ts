import { match } from 'ts-pattern';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';

const TYPE_NAME = 'identity';
const NUM_SHARDS = 8;

type WhoAmICommand = { readonly id: string; readonly kind: 'who-am-i' };
type Command = WhoAmICommand;

/** What the entity reports about itself — everything the test asserts on. */
type IdentityReport = {
  readonly entityId: string;
  readonly typeName: string;
  readonly shardId: number;
  readonly path: string;
  readonly seenInPreStart: string;
};

class IdentityEntity extends Actor<Command> {
  private seenInPreStart = '';

  override preStart(): void { this.seenInPreStart = this.entityId; }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'who-am-i' }, () => this.onWhoAmI())
      .exhaustive();
  }

  private onWhoAmI(): void {
    const report: IdentityReport = {
      entityId: this.entityId,
      typeName: this.entity.typeName,
      shardId: this.entity.shardId,
      path: this.context.path.toString(),
      seenInPreStart: this.seenInPreStart,
    };
    this.sender.forEach((sender) => sender.tell(report));
  }
}

let system: ActorSystem;
let cluster: Cluster;
let region: ActorRef<Command>;

beforeAll(async () => {
  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  system = ActorSystem.create('entity-identity', systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(45_900)
    .withTransport(new InMemoryTransport(new NodeAddress('entity-identity', 'h', 45_900)))
    .withGossipIntervalMs(30);
  cluster = await Cluster.join(system, clusterOptions);
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(IdentityEntity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS);
  region = cluster.sharding.start<Command>(shardingOptions);
});

afterAll(async () => {
  await cluster.leave();
  await system.terminate();
});

describe('a sharded entity knows its own id', () => {
  test('reports the routed id, its type and its shard', async () => {
    const report = await region.ask<IdentityReport>({ id: 'user-1', kind: 'who-am-i' }, 3_000);

    expect(report.entityId).toBe('user-1');
    expect(report.typeName).toBe(TYPE_NAME);
    expect(report.shardId).toBeGreaterThanOrEqual(0);
    expect(report.shardId).toBeLessThan(NUM_SHARDS);
    // Not a number the entity invented — it names the shard actor it lives under.
    expect(report.path).toContain(`/shard-${report.shardId}/`);
  });

  test('the id is readable in preStart, before the first message', async () => {
    const report = await region.ask<IdentityReport>({ id: 'user-2', kind: 'who-am-i' }, 3_000);

    expect(report.seenInPreStart).toBe('user-2');
  });

  test('the id survives characters the child name has to escape (#568)', async () => {
    // `entityName()` escapes anything an actor name cannot carry, so the path
    // does not read back as the id — this is the case that makes a real
    // accessor necessary rather than merely convenient.  The escape is
    // injective, so two ids can no longer land on one child name; what it is
    // *not* is a second way to spell the id.
    const report = await region.ask<IdentityReport>({ id: 'user:42/eu', kind: 'who-am-i' }, 3_000);

    expect(report.entityId).toBe('user:42/eu');
    // ':' is carried literally, '/' cannot be — it would split the path.
    expect(report.path.endsWith('/entity-user:42~002Feu')).toBe(true);
  });

  test('two ids that differ only in punctuation get their own entity (#568)', async () => {
    // The regression: both of these used to fold to `entity-a_b_x_com`.  When
    // they also hashed into one shard, the second missed the shard's id-keyed
    // map, spawned a child under a name already taken, and the throw killed
    // the shard along with every unrelated entity in it.
    const dotted = await region.ask<IdentityReport>({ id: 'a.b@x.com', kind: 'who-am-i' }, 3_000);
    const dashed = await region.ask<IdentityReport>({ id: 'a-b@x.com', kind: 'who-am-i' }, 3_000);

    expect(dotted.entityId).toBe('a.b@x.com');
    expect(dashed.entityId).toBe('a-b@x.com');
    expect(dotted.path).not.toBe(dashed.path);

    // And both are still reachable afterwards — the shard survived.
    const again = await region.ask<IdentityReport>({ id: 'a.b@x.com', kind: 'who-am-i' }, 3_000);
    expect(again.entityId).toBe('a.b@x.com');
  });

  test('every entity gets its own id, not the shard\'s or a neighbour\'s', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `tenant-${i}`);
    const reports = await Promise.all(
      ids.map((id) => region.ask<IdentityReport>({ id, kind: 'who-am-i' }, 3_000)),
    );

    expect(reports.map((report) => report.entityId)).toEqual(ids);
  });
});
