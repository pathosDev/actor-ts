/**
 * The coordinator's queue of `GetShardHome` requests waiting on a shard is
 * bounded (#1219).
 *
 * `onGetShardHome` appended every request for a shard it could not place yet
 * to a per-shard list, and only an allocation emptied it.  #712 made the
 * coordinator derive the requester's identity from the authenticated peer, but
 * a legitimate member may still ask — so any member could ask over and over
 * for a shard that cannot be placed and grow the coordinator's heap without
 * limit.
 *
 * Two rules now hold.  A request that repeats one already waiting — the same
 * region on the same node — adds nothing, since it would be answered with the
 * same frame.  And past {@link MAX_PENDING_SHARD_HOME_REQUESTS} distinct
 * requesters the newest is dropped to dead letters, with one warning per
 * episode, rather than queued.
 *
 * The shard is unplaceable because the type's role matches no member: the
 * local region registers, but as nothing the coordinator may place a shard on,
 * so every request waits.  The flood comes from a bare transport under its own
 * address, the shape `ShardCoordinatorAuthority.test.ts` uses, so every frame
 * passes the authority gate.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { MAX_PENDING_SHARD_HOME_REQUESTS } from '../../../../src/cluster/Constants.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../../src/cluster/Protocol.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import type { GetShardHome } from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { SystemGroups, systemActorPath } from '../../../../src/internal/SystemPaths.js';
import { DeadLetter } from '../../../../src/SystemMessages.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';
import { coordinatorSegments } from '../../../util/SystemPaths.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type WorkCommand = { readonly id: string; readonly kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 4;
/** Any shard but the one the warm-up message asks about, so only the attacker's requests wait on it. */
const SHARD = (hashShardId('warm-up', NUM_SHARDS) + 1) % NUM_SHARDS;

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { /* never routed to: no shard is placed */ }
}

/** Every `GetShardHome` the system gave up as a dead letter. */
const deadShardHomeRequests: GetShardHome[] = [];

class DeadLetterWatcher extends Actor<DeadLetter> {
  override preStart(): void { this.system.eventStream.subscribe(this.self, DeadLetter); }

  override onReceive(letter: DeadLetter): void { this.onDeadLetter(letter); }

  private onDeadLetter(letter: DeadLetter): void {
    const message = letter.message as { kind?: unknown };
    if (message?.kind === 'sharding.GetShardHome') deadShardHomeRequests.push(letter.message as GetShardHome);
  }
}

type CoordinatorInternals = {
  readonly regions: Map<string, unknown>;
  readonly pending: Map<number, GetShardHome[]>;
};

type Victim = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly log: RecordingLogger;
  readonly coordinatorPath: string;
  readonly coordinator: () => CoordinatorInternals;
};

let running: Victim | null = null;
const transports: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.shutdown().catch(() => { /* best-effort */ })));
  if (running) {
    await running.cluster.leave().catch(() => { /* best-effort */ });
    await running.system.terminate().catch(() => { /* best-effort */ });
    running = null;
  }
  deadShardHomeRequests.length = 0;
});

async function startVictim(systemName: string, port: number): Promise<Victim> {
  const log = new RecordingLogger();
  const system = ActorSystem.create(systemName, ActorSystemOptions.create().withLogger(log));
  system.spawn(DeadLetterWatcher, 'dead-letter-watcher');
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  // A role no member carries: the coordinator has no region it may place a
  // shard on, so every request for one waits.
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    .withRole('nobody-has-this-role')
    .withPassivationIdleMs(0);
  const region = cluster.sharding.start<Command>(shardingOptions);

  const coordinator = (): CoordinatorInternals => {
    const resolved = system._resolvePath(coordinatorSegments(systemName, TYPE_NAME));
    if (resolved.isNone()) throw new Error('coordinator actor not found');
    const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
    return cell?.actor as CoordinatorInternals;
  };
  const victim: Victim = {
    system,
    cluster,
    log,
    coordinatorPath: systemActorPath(systemName, SystemGroups.clusterSharding, `coordinator-${TYPE_NAME}`),
    coordinator,
  };
  running = victim;
  region.tell({ id: 'warm-up', kind: 'work' });
  await awaitCondition(() => {
    try { return coordinator().regions.size > 0; } catch { return false; }
  }, { timeoutMs: 4_000, label: 'the coordinator is live and the local region registered' });
  return victim;
}

async function attacker(name: string, port: number): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport(new NodeAddress(name, 'h', port));
  transport.setHandler(() => { /* replies are not read */ });
  await transport.start();
  transports.push(transport);
  return transport;
}

function askForHome(from: InMemoryTransport, victim: Victim, requester: string): void {
  const request: GetShardHome = {
    kind: 'sharding.GetShardHome',
    shardId: SHARD,
    requester,
    requesterNode: from.self.toJSON(),
  };
  from.send(victim.cluster.selfAddress, {
    kind: 'envelope',
    to: victim.coordinatorPath,
    from: null,
    body: request,
  } as unknown as WireMessage);
}

const waitingOn = (victim: Victim): number => victim.coordinator().pending.get(SHARD)?.length ?? 0;

describe('the coordinator bounds the GetShardHome requests waiting on a shard (#1219)', () => {
  test('a request repeating one already waiting adds nothing', async () => {
    const victim = await startVictim('1219-repeat', 44_220);
    const evil = await attacker('evil-1219-repeat', 44_221);

    for (let index = 0; index < 50; index++) askForHome(evil, victim, '/system/sharding/region');
    // The fence: one distinct request behind the fifty, so all of them have
    // been handled once it is in the queue.
    askForHome(evil, victim, '/system/sharding/fence');
    await awaitCondition(
      () => victim.coordinator().pending.get(SHARD)?.some((r) => r.requester === '/system/sharding/fence') ?? false,
      { timeoutMs: 4_000, label: 'the coordinator handled every request' },
    );

    expect(waitingOn(victim)).toBe(2);
  });

  test('past the cap the newest request goes to dead letters, with one warning', async () => {
    const victim = await startVictim('1219-cap', 44_222);
    const evil = await attacker('evil-1219-cap', 44_223);
    const overflow = 25;

    for (let index = 0; index < MAX_PENDING_SHARD_HOME_REQUESTS + overflow; index++) {
      askForHome(evil, victim, `/system/sharding/region-${index}`);
    }
    await awaitCondition(() => deadShardHomeRequests.length === overflow, {
      timeoutMs: 8_000,
      label: 'every request past the cap reached dead letters',
    });

    expect(waitingOn(victim)).toBe(MAX_PENDING_SHARD_HOME_REQUESTS);
    // The oldest requests are the ones kept: an honest region that asked
    // before the flood is not displaced by it.
    expect(victim.coordinator().pending.get(SHARD)?.[0]?.requester).toBe('/system/sharding/region-0');
    expect(deadShardHomeRequests.map((r) => r.requester)).toContain(
      `/system/sharding/region-${MAX_PENDING_SHARD_HOME_REQUESTS}`,
    );
    const warnings = victim.log.records.filter((r) => r.level === 'warn' && r.message.includes('GetShardHome'));
    expect(warnings).toHaveLength(1);
  }, 20_000);
});
