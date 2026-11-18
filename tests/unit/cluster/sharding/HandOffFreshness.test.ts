/**
 * A `HandOff` carries a per-shard freshness token, and a region refuses one that
 * is not newer than the last token it saw for that shard (#1214).
 *
 * The origin gate (#584) decides *who* may order a hand-off, and the ownership
 * precondition makes a duplicate harmless, but neither orders frames in time.
 * `Transport` flushes what it buffered before a handshake completed, so an
 * authentic `HandOff` can arrive long after the coordinator sent it — after the
 * shard moved away and came back, say, or from a coordinator that has since lost
 * the leadership.  Without a token the region cannot tell such a frame from a
 * current one, and it tears down a shard it legitimately owns.
 *
 * The harness is `ShardingAuthority.test.ts`'s single-node victim for the region
 * half: frames handed to the region exactly as its own coordinator's arrive, so
 * every one passes the origin gate and only the token decides.  The coordinator
 * half uses `ShardRegisterConflict.test.ts`'s claimant, a second address that
 * registers through a bare transport and records what the coordinator sends it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { MAX_WALL_CLOCK_SKEW_MS } from '../../../../src/cluster/Constants.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import {
  AuthenticatedShardingMessage,
  type ShardingMessage,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { SystemGroups, shardRegionName, systemActorPath } from '../../../../src/internal/SystemPaths.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import type { WireMessage } from '../../../../src/cluster/Protocol.js';
import { coordinatorSegments, regionSegments } from '../../../util/SystemPaths.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';
import { stageMember } from '../../../util/StagedMember.js';

type WorkCommand = { id: string; kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 4;
const ENTITY_ID = 'user-1';

/** How long an absence is given to show itself: a turn of the region and some. */
const ABSENCE_WINDOW_MS = 200;

let delivered = 0;

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { delivered++; }
}

type Victim = {
  system: ActorSystem;
  cluster: Cluster;
  region: ReturnType<Cluster['sharding']['start']>;
  regionPath: string;
  coordinatorPath: string;
  shardId: number;
};

/** A second node speaking the wire under its own identity, and recording replies. */
type Claimant = {
  readonly transport: InMemoryTransport;
  readonly address: NodeAddress;
  readonly regionPath: string;
  readonly received: WireMessage[];
};

type TokenedBody = { readonly kind: string; readonly shardId: number; readonly token?: unknown };

let running: Victim | null = null;
const transports: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.shutdown().catch(() => { /* best-effort */ })));
  if (running) {
    await running.cluster.leave().catch(() => { /* best-effort */ });
    await running.system.terminate().catch(() => { /* best-effort */ });
    running = null;
  }
  delivered = 0;
});

/**
 * A single-node cluster with one live entity: this node is its own leader, so
 * the coordinator's node is the victim's own address.  The rebalance tick is
 * pushed out of the run, so every `HandOff` a case sees is one it caused.
 */
async function startVictim(systemName: string, port: number): Promise<Victim> {
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
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    .withRebalanceIntervalMs(600_000)
    .withPassivationIdleMs(0);
  const region = cluster.sharding.start<Command>(shardingOptions);

  const victim: Victim = {
    system,
    cluster,
    region: region as Victim['region'],
    regionPath: systemActorPath(systemName, SystemGroups.clusterSharding, shardRegionName(TYPE_NAME)),
    coordinatorPath: systemActorPath(systemName, SystemGroups.clusterSharding, `coordinator-${TYPE_NAME}`),
    shardId: hashShardId(ENTITY_ID, NUM_SHARDS),
  };
  running = victim;

  region.tell({ id: ENTITY_ID, kind: 'work' });
  await awaitCondition(() => delivered === 1, {
    timeoutMs: 4_000,
    label: 'the entity came up on a genuine coordinator ShardHome',
  });
  return victim;
}

/** Hand the region a directive exactly as its own coordinator's arrive. */
function tellAsCoordinator(victim: Victim, message: ShardingMessage | Record<string, unknown>): void {
  const resolved = victim.system._resolvePath(regionSegments(victim.system.name, TYPE_NAME));
  if (resolved.isNone()) throw new Error('region actor not found');
  (resolved.value as ActorRef<ShardingMessage | AuthenticatedShardingMessage>)
    .tell(new AuthenticatedShardingMessage(victim.cluster.selfAddress, message as ShardingMessage));
}

function actorOf<T>(victim: Victim, segments: string[]): T {
  const resolved = victim.system._resolvePath(segments);
  if (resolved.isNone()) throw new Error(`no actor at ${segments.join('/')}`);
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  const actor = cell?.actor;
  if (!actor) throw new Error('cell holds no actor');
  return actor as T;
}

function coordinatorTokens(victim: Victim): Map<number, number> {
  return actorOf<{ readonly shardTokens: Map<number, number> }>(
    victim, coordinatorSegments(victim.system.name, TYPE_NAME),
  ).shardTokens;
}

function entityIsUp(victim: Victim): boolean {
  return victim.system._resolvePath([
    ...regionSegments(victim.system.name, TYPE_NAME),
    `shard-${victim.shardId}`,
    `entity-${ENTITY_ID}`,
  ]).isSome();
}

function homeOn(victim: Victim, node: NodeAddress, region: string, token: number): Record<string, unknown> {
  return { kind: 'sharding.ShardHome', shardId: victim.shardId, region, node: node.toJSON(), token };
}

/**
 * A token above anything the victim's coordinator has issued so far.  Its
 * tokens are drawn no lower than its wall clock, so one minute ahead is clear of
 * every one it can issue while a case runs.
 */
function aheadOfTheCoordinator(): number {
  return Date.now() + 60_000;
}

async function claimant(name: string, port: number): Promise<Claimant> {
  const address = new NodeAddress(name, 'h', port);
  const transport = new InMemoryTransport(address);
  const received: WireMessage[] = [];
  transport.setHandler((_from, message) => { received.push(message); });
  await transport.start();
  transports.push(transport);
  return {
    transport,
    address,
    regionPath: systemActorPath(name, SystemGroups.clusterSharding, shardRegionName(TYPE_NAME)),
    received,
  };
}

function register(from: Claimant, victim: Victim, hostedShards: number[], shardTokens?: unknown): void {
  from.transport.send(victim.cluster.selfAddress, {
    kind: 'envelope',
    to: victim.coordinatorPath,
    from: null,
    body: {
      kind: 'sharding.Register',
      region: from.regionPath,
      node: from.address.toJSON(),
      proxy: false,
      hostedShards,
      numShards: NUM_SHARDS,
      ...(shardTokens === undefined ? {} : { shardTokens }),
    },
  } as unknown as WireMessage);
}

/** Every `HandOff` the claimant was sent, in arrival order. */
function handOffsTo(from: Claimant): TokenedBody[] {
  return from.received
    .map((message) => (message as { body?: TokenedBody }).body)
    .filter((body): body is TokenedBody => !!body && body.kind === 'sharding.HandOff');
}

describe('HandOff freshness token: the region (#1214)', () => {
  test('a late HandOff for a shard that moved away and came back is refused', async () => {
    const victim = await startVictim('freshness-moved-back', 47_210);
    const elsewhere = stageMember(victim.cluster, new NodeAddress('freshness-elsewhere', 'h', 47_211));

    // The frame the coordinator sent before the shard moved, held in a
    // connection's pending buffer while what follows happened.
    const issuedAt = aheadOfTheCoordinator();
    const late = { kind: 'sharding.HandOff', shardId: victim.shardId, token: issuedAt };

    // Moved away, then placed back here — each move a newer directive.
    tellAsCoordinator(victim, homeOn(victim, elsewhere, `/system/cluster-sharding/${TYPE_NAME}-region`, issuedAt + 1));
    await awaitCondition(() => !entityIsUp(victim), { label: 'the move away stopped the local copy' });
    tellAsCoordinator(victim, homeOn(victim, victim.cluster.selfAddress, victim.regionPath, issuedAt + 2));
    victim.region.tell({ id: ENTITY_ID, kind: 'work' });
    await awaitCondition(() => delivered === 2 && entityIsUp(victim), {
      timeoutMs: 4_000,
      label: 'the shard is back and its entity serves here',
    });

    tellAsCoordinator(victim, late);
    // An absence: the entity is up at t=0 and must still be up afterwards.
    await sleep(ABSENCE_WINDOW_MS); // an absence: nothing may happen, so there is no state to poll for
    expect(entityIsUp(victim)).toBe(true);
  });

  test('a HandOff without a token is refused', async () => {
    const victim = await startVictim('freshness-no-token', 47_212);

    tellAsCoordinator(victim, { kind: 'sharding.HandOff', shardId: victim.shardId });
    await sleep(ABSENCE_WINDOW_MS); // an absence: nothing may happen, so there is no state to poll for
    expect(entityIsUp(victim)).toBe(true);

    // The same frame with a token is acted on, so the refusal was the token's.
    tellAsCoordinator(victim, { kind: 'sharding.HandOff', shardId: victim.shardId, token: aheadOfTheCoordinator() });
    await awaitCondition(() => !entityIsUp(victim), { timeoutMs: 4_000, label: 'the tokened HandOff stopped the shard' });
  });

  test('a token the region has already seen is not newer, and a newer one is acted on', async () => {
    const victim = await startVictim('freshness-equal-token', 47_213);
    const seen = aheadOfTheCoordinator();

    // A placement here records its token without moving anything, and an older
    // one arriving after it — a lookup's answer from a coordinator since
    // replaced — does not lower what was recorded.
    tellAsCoordinator(victim, homeOn(victim, victim.cluster.selfAddress, victim.regionPath, seen));
    tellAsCoordinator(victim, homeOn(victim, victim.cluster.selfAddress, victim.regionPath, seen - 30_000));
    tellAsCoordinator(victim, { kind: 'sharding.HandOff', shardId: victim.shardId, token: seen });
    await sleep(ABSENCE_WINDOW_MS); // an absence: nothing may happen, so there is no state to poll for
    expect(entityIsUp(victim)).toBe(true);

    tellAsCoordinator(victim, { kind: 'sharding.HandOff', shardId: victim.shardId, token: seen + 1 });
    await awaitCondition(() => !entityIsUp(victim), { timeoutMs: 4_000, label: 'the newer HandOff stopped the shard' });
  });

  test('a ShardHome without a token is refused', async () => {
    const victim = await startVictim('freshness-home-no-token', 47_214);
    const elsewhere = stageMember(victim.cluster, new NodeAddress('freshness-home-elsewhere', 'h', 47_215));

    tellAsCoordinator(victim, {
      kind: 'sharding.ShardHome',
      shardId: victim.shardId,
      region: `/system/cluster-sharding/${TYPE_NAME}-region`,
      node: elsewhere.toJSON(),
    });
    await sleep(ABSENCE_WINDOW_MS); // an absence: nothing may happen, so there is no state to poll for
    expect(entityIsUp(victim)).toBe(true);
  });

  test('a re-registration reports the tokens the region has seen, and the coordinator issues above them', async () => {
    const victim = await startVictim('freshness-report', 47_216);
    // What the region saw from a coordinator before this one: higher than any
    // token this coordinator has issued for the shard.
    const fromPreviousCoordinator = aheadOfTheCoordinator();
    tellAsCoordinator(victim, homeOn(victim, victim.cluster.selfAddress, victim.regionPath, fromPreviousCoordinator));

    tellAsCoordinator(victim, { kind: 'sharding.RegistrationRequest', coordinator: victim.coordinatorPath });
    await awaitCondition(
      () => (coordinatorTokens(victim).get(victim.shardId) ?? 0) >= fromPreviousCoordinator,
      { label: 'the coordinator took the reported token as its floor' },
    );
  });
});

describe('HandOff freshness token: the coordinator (#1214)', () => {
  test('every directive about a shard carries a token newer than the one before', async () => {
    const victim = await startVictim('freshness-issue', 47_217);
    const stale = await claimant('freshness-issue-claimant', 47_218);
    const before = Date.now();

    // A colliding claim earns a conflict HandOff; a repeated claim earns another.
    register(stale, victim, [victim.shardId]);
    await awaitCondition(() => handOffsTo(stale).length >= 1, { label: 'the first conflict HandOff' });
    register(stale, victim, [victim.shardId]);
    await awaitCondition(() => handOffsTo(stale).length >= 2, { label: 'the second conflict HandOff' });

    const tokens = handOffsTo(stale).map((body) => body.token);
    for (const token of tokens) expect(Number.isSafeInteger(token)).toBe(true);
    expect((tokens[1] as number)).toBeGreaterThan(tokens[0] as number);
    // No lower than the clock: what outdates a frame a previous coordinator sent
    // and no region has seen yet.
    expect(tokens[0] as number).toBeGreaterThanOrEqual(before);
  });

  test("a token a region reports in its Register floors the coordinator's next one", async () => {
    const victim = await startVictim('freshness-floor', 47_219);
    const stale = await claimant('freshness-floor-claimant', 47_220);
    const reported = Date.now() + 3_600_000;

    register(stale, victim, [victim.shardId], [[victim.shardId, reported]]);
    await awaitCondition(() => handOffsTo(stale).length >= 1, { label: 'the conflict HandOff' });

    expect(handOffsTo(stale)[0]!.token as number).toBeGreaterThan(reported);

    // A later, lower report raises nothing and lowers nothing.
    register(stale, victim, [victim.shardId], [[victim.shardId, Date.now()]]);
    await awaitCondition(() => handOffsTo(stale).length >= 2, { label: 'the second conflict HandOff' });
    expect(handOffsTo(stale)[1]!.token as number).toBeGreaterThan(handOffsTo(stale)[0]!.token as number);
  });

  test('a reported token past the clock-skew bound is ignored rather than adopted', async () => {
    const victim = await startVictim('freshness-implausible', 47_221);
    const stale = await claimant('freshness-implausible-claimant', 47_222);
    // Adopted, this would pin every later token of the shard at the ceiling of
    // a safe integer, where `+ 1` stops growing.
    const implausible = Date.now() + MAX_WALL_CLOCK_SKEW_MS + 3_600_000;

    register(stale, victim, [victim.shardId], [[victim.shardId, implausible]]);
    await awaitCondition(() => handOffsTo(stale).length >= 1, { label: 'the conflict HandOff' });

    const token = handOffsTo(stale)[0]!.token as number;
    expect(Number.isSafeInteger(token)).toBe(true);
    expect(token).toBeLessThan(implausible);
  });
});
