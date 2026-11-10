import { match } from 'ts-pattern';
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorOptions } from '../../../../../src/ActorOptions.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import type { StartShardingOptionsBuilder } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { escalatingStrategy } from '../../../../../src/Supervision.js';
import { regionSegments } from '../../../../util/SystemPaths.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { Logger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { RecordingLogger } from '../../../../util/RecordingLogger.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

/**
 * A shard actor that dies outside a handoff used to take its entities with it
 * for good (#894).  The region keeps ownership on purpose — that is how the
 * shard comes back here once its failure backoff is over (#1437) — but keeping
 * it also means neither `onRegister` nor `tryAllocate` ever runs again, and
 * those were the only two paths that shipped the remembered registry.  So the
 * shard came back empty while the coordinator still listed everything it had
 * held.
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

/** Every start an entity of {@link FailingEntity} attempted — one per re-creation. */
let failingStarts = 0;

/**
 * An entity that cannot start — what a store that is down does to every
 * entity that replays from it.
 */
class FailingEntity extends Actor<Command> {
  override preStart(): void {
    failingStarts++;
    throw new Error('the store behind this entity is down');
  }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void {}
}

/**
 * Kept as a name so every call site here stays unchanged; the body forwards to
 * the shared helper (#418), which names the awaited state in its timeout message
 * and — unlike the deadline loop it replaces — cannot fall through silently.
 */
const waitFor = (
  predicate: () => boolean,
  timeoutMs = 5_000,
  stepMs = 10,
  label = 'the awaited remember-entities recovery state',
): Promise<void> => awaitCondition(predicate, { timeoutMs, intervalMs: stepMs, label });

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
  logger: Logger | null = null,
): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger ?? new NoopLogger())
    .withLogLevel(logger === null ? LogLevel.Off : LogLevel.Warn);
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
    .withEntityActor(Entity)
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
  failingStarts = 0;
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

    // The shard stays down for its failure backoff's first wait, 200 ms at the
    // shipped defaults, and the region asks the coordinator for the registry
    // when it brings the shard back rather than on the death (#1437).  Not
    // asserting the gap itself: a poll that a loaded runner starves for that
    // long would miss it.  The two fresh incarnations are the evidence, and no
    // message is sent to provoke them: the region has to ask on its own.
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

    // An absence: without rememberEntities nothing may be restored, so
    // `created === 1` holds at t=0 and a poll on it would assert nothing.  The
    // window is what would expose a recovery that should not happen — and it
    // outlasts the backoff's first wait, so the shard has come back by its end,
    // empty (#1437).
    await sleep(250);
    expect(created).toBe(1);

    // And the next message brings the entity back, one at a time.
    node.region.tell({ id: 'user-1', kind: 'work' });
    await waitFor(() => created === 2);
  }, 15_000);

  test('a shard whose entity fails every start backs off instead of looping (#1437)', async () => {
    // The loop the backoff exists to end: an entity that cannot start, under a
    // strategy that hands the failure to its shard, with rememberEntities on.
    // The shard died, the region asked for its registry, the answer re-created
    // the shard and the entity in it, and the entity failed again — with no
    // traffic at all, 9 297 times in one idle second when it was last measured.
    const log = new RecordingLogger();
    const node = await startNode('remember-shard-loop', 47_302, (builder) => {
      const entityOptions = ActorOptions.create<Command>().withSupervisorStrategy(escalatingStrategy);
      builder
        .withRememberEntities(true)
        .withEntityActor(FailingEntity)
        .withEntityOptions(entityOptions)
        .withShardFailureBackoffMinMs(100)
        .withShardFailureBackoffRandomFactor(0);
    }, log);
    const shardDied = (): boolean =>
      log.records.some((record) => record.level === 'warn' && record.message.includes('stopped unexpectedly'));

    // Traffic until the shard dies.  Each message re-creates the entity, which
    // fails its start; the region's own supervision may restart the shard in
    // place a number of times first — its default allows ten a minute — and
    // only a stop reaches the respawn path.  One message per failure, so a
    // restart in place always has a message to re-create the entity on.
    for (let attempt = 1; attempt <= 12 && !shardDied(); attempt++) {
      node.region.tell({ id: 'poison', kind: 'work' });
      await waitFor(() => failingStarts >= attempt || shardDied(), 4_000, 10, `failure ${attempt} happened`);
    }
    await waitFor(shardDied, 4_000, 10, 'the shard died at least once');

    const before = failingStarts;
    // The idle second: nothing is sent from here on, so every start counted
    // below is a respawn the region made on its own.  An absence of a storm
    // cannot be polled for — the count is the assertion — hence the window.
    await sleep(1_000);
    const respawns = failingStarts - before;

    // Waits of 100, 200, 400, 800 ms fit at most four respawns into a second.
    expect(respawns).toBeLessThanOrEqual(4);
    // And the shard does come back: a backoff that parked it for good would
    // pass the bound above with nothing to show for it.
    expect(respawns).toBeGreaterThan(0);
  }, 15_000);
});
