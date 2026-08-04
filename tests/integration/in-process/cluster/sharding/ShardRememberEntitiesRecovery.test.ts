import { match } from 'ts-pattern';
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import type { StartShardingOptionsBuilder } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { regionSegments } from '../../../../util/systemPaths.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';

/**
 * A shard actor that dies outside a handoff used to take its entities with it
 * for good (#894).  The region keeps ownership on purpose — that is how the
 * next message re-creates the shard — but keeping it also means neither
 * `onRegister` nor `tryAllocate` ever runs again, and those were the only two
 * paths that shipped the remembered registry.  So the shard came back empty
 * while the coordinator still listed everything it had held.
 *
 * `numShards = 1` puts every entity in one shard, so a single stop is enough
 * to lose all of them at once.
 */

type WorkCommand = { id: string; kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';

let created = 0;

class Entity extends Actor<Command> {
  override preStart(): void { created++; }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void {}
}

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(stepMs);
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

type Node = {
  system: ActorSystem;
  cluster: Cluster;
  region: ActorRef<Command>;
};

let running: Node | null = null;

async function startNode(
  systemName: string,
  port: number,
  options: (builder: StartShardingOptionsBuilder<Command>) => void,
): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);

  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(() => new Entity())
    .withExtractEntityId((message) => message.id)
    .withNumShards(1)
    // The registry under test is the coordinator's in-memory one; a store
    // would only add a journal to the picture.
    .withRememberEntitiesStore(null)
    // Nothing here is about idleness, and a sweep would only add noise.
    .withPassivationIdleMs(0);
  options(shardingOptions);

  const region = cluster.sharding.start<Command>(shardingOptions);
  const node = { system, cluster, region };
  running = node;
  return node;
}

/** The shard actor itself, so a test can kill it the way a crash would. */
function shardRef(node: Node): ActorRef<unknown> {
  const resolved = node.system._resolvePath([
    ...regionSegments(node.system.name, TYPE_NAME),
    'shard-0',
  ]);
  if (resolved.isNone()) throw new Error('shard actor not found');
  return resolved.value as ActorRef<unknown>;
}

function shardIsUp(node: Node): boolean {
  return node.system._resolvePath([
    ...regionSegments(node.system.name, TYPE_NAME),
    'shard-0',
  ]).isSome();
}

function entityIsUp(node: Node, entityId: string): boolean {
  return node.system._resolvePath([
    ...regionSegments(node.system.name, TYPE_NAME),
    'shard-0',
    `entity-${entityId}`,
  ]).isSome();
}

afterEach(async () => {
  if (running) {
    await running.cluster.leave();
    await running.system.terminate();
    running = null;
  }
  created = 0;
});

describe('ClusterSharding — remembered entities after an unexpected shard death (#894)', () => {
  test('the entities come back without anyone sending a message', async () => {
    const node = await startNode('remember-shard-death', 47_300, (builder) => {
      builder.withRememberEntities(true);
    });

    node.region.tell({ id: 'user-1', kind: 'work' });
    node.region.tell({ id: 'user-2', kind: 'work' });
    await waitFor(() => created === 2);
    await waitFor(() => entityIsUp(node, 'user-1') && entityIsUp(node, 'user-2'));

    // Stopping the shard outside a handoff: exactly the branch that used to
    // log "stopped unexpectedly" and then quietly drop everything.
    shardRef(node).stop();

    // Not asserting that the shard goes away first — recovery re-creates it
    // within the same turn, so the gap is not observable from out here. The
    // two fresh incarnations are the evidence, and no message is sent to
    // provoke them: the region has to ask the coordinator on its own.
    await waitFor(() => created === 4);
    await waitFor(() => entityIsUp(node, 'user-1') && entityIsUp(node, 'user-2'));
  }, 15_000);

  test('without rememberEntities the shard comes back empty, as before', async () => {
    // The complement: nothing to remember means nothing to restore, and the
    // region must not start asking the coordinator for a registry it never fed.
    const node = await startNode('forget-shard-death', 47_301, (builder) => {
      builder.withRememberEntities(false);
    });

    node.region.tell({ id: 'user-1', kind: 'work' });
    await waitFor(() => created === 1);

    shardRef(node).stop();
    await waitFor(() => !shardIsUp(node));

    await sleep(250);
    expect(created).toBe(1);

    // And the next message still brings it back, one entity at a time.
    node.region.tell({ id: 'user-1', kind: 'work' });
    await waitFor(() => created === 2);
  });
});
