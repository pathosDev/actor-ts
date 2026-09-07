/**
 * #862 — *which* actors `actor-ts.mailbox.default.capacity` reaches.
 *
 * The bound shipped scoped to strict descendants of `/user`, on the premise
 * that "under `/system`" and "the framework's own" are the same set.  They are
 * not.  A sharded entity is spawned by its `Shard`, which is a child of a
 * `ShardRegion`, which the framework spawns under `/system` — so the class the
 * *application* wrote lands three levels down a `/system` path and the bound
 * skipped it.  The same holds for a cluster singleton, spawned by its manager.
 *
 * That is the population the feature's own documentation names as its
 * motivation: a memory-constrained sharded deployment.  So these tests are
 * about the tree, not about the mailbox — `BoundedMailbox` itself is covered in
 * `MailboxVariants.test.ts`, and the assertions here are deliberately the
 * cheapest ones that tell the two scopes apart.
 *
 * The exemption they must not swallow is the other half: a bounded mailbox on a
 * shard region, a coordinator or a singleton manager is how a cluster deadlocks
 * under load, so the framework's own actors have to stay unbounded while the
 * application's actor beneath them does not.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { Shard } from '../../../src/cluster/sharding/Shard.js';
import type { ShardConfig, ShardInbox } from '../../../src/cluster/sharding/Shard.js';
import { ClusterSingleton } from '../../../src/cluster/singleton/ClusterSingleton.js';
import { StartSingletonOptions } from '../../../src/cluster/singleton/StartSingletonOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { SystemGroups } from '../../../src/internal/SystemPaths.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { BoundedMailbox, Mailbox, MailboxFullError } from '../../../src/mailbox/index.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

type PingCommand = { readonly kind: 'ping' };

/**
 * Records itself on start, so a test can reach the mailbox of an actor it never
 * spawned — nothing hands back a ref to a sharded entity or a singleton
 * instance, and that inaccessibility is part of why the scope went unnoticed.
 */
class SpawnedProbe extends Actor<PingCommand> {
  static spawned: SpawnedProbe[] = [];
  override preStart(): void { SpawnedProbe.spawned.push(this); }
  /** The cell seam wants a ref, and only the instance can reach its own. */
  get ref(): object { return this.self as unknown as object; }
  get parentRef(): object { return this.context.parent.toNullable() as unknown as object; }
  override onReceive(_message: PingCommand): void {}
}

/**
 * A TestKit whose only non-default setting is the mailbox block.  Nested and
 * not a dotted key, which would stay one literal top-level key and leave every
 * assertion below reading the reference value instead.
 */
const kitWithMailboxDefault = (
  name: string,
  mailboxDefault: Record<string, number | string>,
): TestKit =>
  TestKit.create(name, TestKitOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { mailbox: { default: mailboxDefault } } }));

/** The queue an actor actually got, through the cell's test seam. */
const mailboxOf = (ref: object): unknown =>
  (ref as { getCell(): { _mailboxForTest(): unknown } }).getCell()._mailboxForTest();

const pingEnvelope = (entityId: string): ShardInbox => ({
  kind: 'sharding.EntityEnvelope',
  entityId,
  message: { kind: 'ping' } satisfies PingCommand,
}) as ShardInbox;

describe('the global mailbox bound reaches the application under /system (#862)', () => {
  test('a sharded entity is bounded, and the shard that spawned it is not', async () => {
    SpawnedProbe.spawned = [];
    const kit = kitWithMailboxDefault('mbox-scope-entity', { capacity: 4 });
    // Under `/system`, exactly where `ClusterSharding` puts a region — the
    // `Shard` is driven directly rather than through a cluster, because the
    // only thing deciding the entity's mailbox is the tree it lands in.
    const config: ShardConfig = { typeName: 'probe', shardId: 0, entityActor: SpawnedProbe };
    const shard = kit.system._spawnSystemActor<ShardInbox>(
      () => new Shard(config),
      SystemGroups.clusterSharding,
      'shard-0',
    );
    shard.tell(pingEnvelope('e-1'));
    await awaitCondition(() => SpawnedProbe.spawned.length === 1, {
      label: 'the shard spawned its entity',
    });

    // The entity is the application's actor: the operator's bound is for it.
    expect(mailboxOf(SpawnedProbe.spawned[0]!.ref)).toBeInstanceOf(BoundedMailbox);
    // The shard is the framework's — shedding its traffic loses entity mail the
    // application never learns was addressed to it.
    expect(mailboxOf(shard)).not.toBeInstanceOf(BoundedMailbox);
    expect(mailboxOf(shard)).toBeInstanceOf(Mailbox);

    await kit.system.terminate();
  });

  test('an entity of a shard under /user is bounded too', async () => {
    // The same `Shard`, one tree over.  Without it the assertion above could
    // pass on a fix that had merely stopped looking at the path at all.
    SpawnedProbe.spawned = [];
    const kit = kitWithMailboxDefault('mbox-scope-entity-user', { capacity: 4 });
    const config: ShardConfig = { typeName: 'probe', shardId: 0, entityActor: SpawnedProbe };
    const shard = kit.system.spawn<ShardInbox>(() => new Shard(config), 'shard-0');
    shard.tell(pingEnvelope('e-1'));
    await awaitCondition(() => SpawnedProbe.spawned.length === 1, {
      label: 'the shard spawned its entity',
    });

    expect(mailboxOf(SpawnedProbe.spawned[0]!.ref)).toBeInstanceOf(BoundedMailbox);

    await kit.system.terminate();
  });

  test('a cluster singleton instance is bounded, and its manager is not', async () => {
    SpawnedProbe.spawned = [];
    const kit = kitWithMailboxDefault('mbox-scope-singleton', { capacity: 4 });
    const address = new NodeAddress('mbox-scope-singleton', 'h', 35_921);
    const cluster = await Cluster.join(kit.system, ClusterOptions.create()
      .withHost('h')
      .withPort(35_921)
      .withSeeds([])
      .withTransport(new InMemoryTransport(address))
      .withGossipIntervalMs(80));
    const singletonOptions = StartSingletonOptions.create<PingCommand>()
      .withTypeName('probe-singleton')
      .withActor(SpawnedProbe);
    ClusterSingleton.get(kit.system, cluster).start(singletonOptions);
    await awaitCondition(() => SpawnedProbe.spawned.length === 1, {
      timeoutMs: 4_000,
      label: 'the manager spawned its singleton',
    });

    expect(mailboxOf(SpawnedProbe.spawned[0]!.ref)).toBeInstanceOf(BoundedMailbox);
    // The manager arbitrates hand-over; a dropped hand-over message is how two
    // nodes end up hosting the same singleton.
    expect(mailboxOf(SpawnedProbe.spawned[0]!.parentRef)).not.toBeInstanceOf(BoundedMailbox);

    await cluster.leave().catch(() => {});
    await kit.system.terminate();
  });
});

describe('mailbox.default.overflow is the policy for any bounded mailbox (#862)', () => {
  test('a spawn-site capacity with no policy of its own picks up the configured one', async () => {
    // The commit's central deliberate decision, and the one nothing bound: the
    // narrower alternative — `overflow` applying only to the *global* bound —
    // is indistinguishable from this wherever the global bound is set too.  So
    // no `capacity` here at all: the only bound in this system comes from the
    // spawn site, and `reject` can only have reached it from the config.
    const kit = kitWithMailboxDefault('mbox-scope-overflow', { overflow: 'reject' });
    let release = (): void => {};
    const latch = new Promise<void>((resolve) => { release = resolve; });
    class Latched extends Actor<number> {
      override async onReceive(n: number): Promise<void> { if (n === 0) await latch; }
    }
    const options = ActorOptions.create<number>().withMailboxCapacity(2);
    const ref = kit.system.spawnAnonymous(Latched, options);

    // `reject` surfaces at the sender; the built-in `drop-head` swallows these
    // silently, which is exactly the distinction being pinned.
    expect(() => { for (let i = 0; i < 32; i++) ref.tell(i); }).toThrow(MailboxFullError);

    release();
    await kit.system.terminate();
  });
});
