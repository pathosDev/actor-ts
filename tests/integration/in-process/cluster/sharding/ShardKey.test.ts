import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { ShardKey } from '../../../../../src/cluster/sharding/ShardKey.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

type GreetCommand = { readonly kind: 'greet'; readonly userId: string };

const seen: string[] = [];

/** Declares its own identity — typeName AND how a command names its entity. */
class UserActor extends Actor<GreetCommand> {
  static readonly shard = ShardKey.of<GreetCommand>('user', (command) => command.userId);
  override onReceive(command: GreetCommand): void { seen.push(`${command.userId}@self`); }
}

/** Same, but needs a constructor argument — routed to the factory overload. */
class TenantActor extends Actor<GreetCommand> {
  static readonly shard = ShardKey.of<GreetCommand>('tenant', (command) => command.userId);
  constructor(private readonly label: string) { super(); }
  override onReceive(command: GreetCommand): void { seen.push(`${command.userId}@${this.label}`); }
}

async function startNode(systemName: string, port: number): Promise<{ system: ActorSystem; cluster: Cluster }> {
  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster };
}

/**
 * Kept as a name so every call site here stays unchanged; the body forwards to
 * the shared helper (#418), which names the awaited state in its timeout message
 * and — unlike the deadline loop it replaces — cannot fall through silently.
 */
const waitFor = (
  predicate: () => boolean,
  timeoutMs = 3_000,
  label = 'the awaited shard-key routing state',
): Promise<void> => awaitCondition(predicate, { timeoutMs, intervalMs: 20, label });

describe('ClusterSharding — class-declared shard keys', () => {
  test('a zero-argument entity class needs nothing but itself', async () => {
    seen.length = 0;
    const node = await startNode('shk-1', 53001);

    // No typeName, no entity actor, no extractEntityId — all of it is on the class.
    const users = node.cluster.sharding.start(UserActor);
    users.tell({ kind: 'greet', userId: 'u-1' });
    await waitFor(() => seen.includes('u-1@self'));

    await node.cluster.leave();
    await node.system.terminate();
  });

  test('an entity with dependencies uses the factory overload', async () => {
    seen.length = 0;
    const node = await startNode('shk-2', 53002);

    const tenants = node.cluster.sharding.start(TenantActor, () => new TenantActor('eu'));
    tenants.tell({ kind: 'greet', userId: 't-9' });
    await waitFor(() => seen.includes('t-9@eu'));

    await node.cluster.leave();
    await node.system.terminate();
  });

  test('entityRefFor takes the class or the key, and routes without an extractor', async () => {
    seen.length = 0;
    const node = await startNode('shk-3', 53003);
    node.cluster.sharding.start(UserActor);

    node.cluster.sharding.entityRefFor(UserActor, 'u-2').tell({ kind: 'greet', userId: 'ignored' });
    await waitFor(() => seen.includes('ignored@self'));

    // The key form resolves to the same region; a lookup key needs no extractor.
    node.cluster.sharding.entityRefFor(ShardKey.of<GreetCommand>('user'), 'u-3')
      .tell({ kind: 'greet', userId: 'also-ignored' });
    await waitFor(() => seen.includes('also-ignored@self'));

    await node.cluster.leave();
    await node.system.terminate();
  });

  test('explicit options override the extractor the key carries', async () => {
    seen.length = 0;
    const node = await startNode('shk-4', 53004);

    // Route everything to one entity regardless of what the key says.
    const shardingOptions = StartShardingOptions.create<GreetCommand>()
      .withExtractEntityId(() => 'fixed');
    const users = node.cluster.sharding.start(UserActor, shardingOptions);
    users.tell({ kind: 'greet', userId: 'u-4' });
    await waitFor(() => seen.includes('u-4@self'));

    await node.cluster.leave();
    await node.system.terminate();
  });

  test('a class with no shard static is rejected by name', async () => {
    const node = await startNode('shk-5', 53005);
    class Undeclared extends Actor<GreetCommand> {
      override onReceive(): void {}
    }

    expect(() => node.cluster.sharding.start(Undeclared as never))
      .toThrow(/Undeclared does not declare a shard key/);

    await node.cluster.leave();
    await node.system.terminate();
  });
});
