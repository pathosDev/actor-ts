/**
 * Sharding's refusal lines escape what a peer wrote into them (#1220).
 *
 * `isShardingMessage` admits any `kind` that starts with `sharding.`, and a
 * `Register` carries a region path the sender chooses freely.  The refusal
 * lines in `ShardCoordinator` interpolated both as they came, and
 * `ConsoleLogger` writes one line per record — so a CR or LF inside either
 * forged as many further records as the sender liked, each reading exactly
 * like framework output.  Every such field now goes through the transport's
 * escaping helpers before it reaches a line.
 *
 * Each case is reachable by one frame from any authenticated member: the
 * attacker is a bare `InMemoryTransport` under its own address, the shape
 * `ShardCoordinatorAuthority.test.ts` uses, and every forged field names that
 * address wherever the authority gate compares one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../../src/cluster/Protocol.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import { SystemGroups, systemActorPath } from '../../../../src/internal/SystemPaths.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';
import { coordinatorSegments } from '../../../util/SystemPaths.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type WorkCommand = { readonly id: string; readonly kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 4;
const ENTITY_ID = 'user-1';

/** What every forged field carries: a line break followed by a record of the attacker's own. */
const FORGED_RECORD = 'x\r\n2026-11-14T00:00:00.000Z WARN [sharding] all good';

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
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly log: RecordingLogger;
  readonly coordinatorPath: string;
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
  delivered = 0;
});

/** A single-node cluster whose own region has registered and whose entity is up. */
async function startVictim(systemName: string, port: number): Promise<Victim> {
  const log = new RecordingLogger();
  const system = ActorSystem.create(systemName, ActorSystemOptions.create().withLogger(log));
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
    .withPassivationIdleMs(0);
  const region = cluster.sharding.start<Command>(shardingOptions);
  const victim: Victim = {
    system,
    cluster,
    log,
    coordinatorPath: systemActorPath(systemName, SystemGroups.clusterSharding, `coordinator-${TYPE_NAME}`),
  };
  running = victim;
  region.tell({ id: ENTITY_ID, kind: 'work' });
  await awaitCondition(() => delivered === 1, {
    timeoutMs: 4_000,
    label: 'the entity came up, so the local region registered',
  });
  return victim;
}

async function attacker(name: string, port: number): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport(new NodeAddress(name, 'h', port));
  transport.setHandler(() => { /* replies are not read */ });
  await transport.start();
  transports.push(transport);
  return transport;
}

function forge(from: InMemoryTransport, victim: Victim, to: string, body: unknown): void {
  from.send(victim.cluster.selfAddress, { kind: 'envelope', to, from: null, body } as unknown as WireMessage);
}

/** The first record mentioning `fragment`, once one has been written. */
async function recordMentioning(victim: Victim, fragment: string): Promise<string> {
  await awaitCondition(() => victim.log.records.some((r) => r.message.includes(fragment)), {
    timeoutMs: 4_000,
    label: `a log record mentioning '${fragment}'`,
  });
  return victim.log.records.find((r) => r.message.includes(fragment))!.message;
}

/** A record holds no raw line break, and shows the forged text in its escaped form. */
function expectEscaped(record: string): void {
  expect(record).not.toMatch(/[\r\n]/);
  expect(record).toContain('x\\u000d\\u000a2026');
}

describe('sharding refusal lines escape peer-supplied text (#1220)', () => {
  test('an unattributed frame with a line break in its kind is refused on one line', async () => {
    const victim = await startVictim('1220-kind', 44_120);

    // Told straight into the mailbox: the wire's own way there — a trailing
    // slash that misses the per-path handler — is refused by the envelope trust
    // policy for a `/system` path today, but the refusal line must not depend on
    // that staying true.
    const coordinator = victim.system._resolvePath(coordinatorSegments(victim.system.name, TYPE_NAME));
    if (coordinator.isNone()) throw new Error('coordinator actor not found');
    coordinator.value.tell({ kind: `sharding.${FORGED_RECORD}` } as never);

    expectEscaped(await recordMentioning(victim, 'refusing an unattributed'));
  });

  test('a refused Register shows its region path escaped', async () => {
    const victim = await startVictim('1220-num-shards', 44_122);
    const evil = await attacker('evil-1220-num-shards', 44_123);

    forge(evil, victim, victim.coordinatorPath, {
      kind: 'sharding.Register',
      region: `/${FORGED_RECORD}`,
      node: evil.self.toJSON(),
      proxy: false,
      hostedShards: [],
      numShards: NUM_SHARDS + 1,
    });

    expectEscaped(await recordMentioning(victim, 'refusing to register region'));
  });

  test('a Register with surplus hosted shards shows its region path escaped', async () => {
    const victim = await startVictim('1220-hosted', 44_124);
    const evil = await attacker('evil-1220-hosted', 44_125);

    forge(evil, victim, victim.coordinatorPath, {
      kind: 'sharding.Register',
      region: `/${FORGED_RECORD}`,
      node: evil.self.toJSON(),
      proxy: false,
      hostedShards: [NUM_SHARDS + 7],
      numShards: NUM_SHARDS,
    });

    expectEscaped(await recordMentioning(victim, 'hosted shard(s) for type'));
  });

  test('a Register claiming an owned shard shows its region path escaped', async () => {
    const victim = await startVictim('1220-conflict', 44_126);
    const evil = await attacker('evil-1220-conflict', 44_127);

    forge(evil, victim, victim.coordinatorPath, {
      kind: 'sharding.Register',
      region: `/${FORGED_RECORD}`,
      node: evil.self.toJSON(),
      proxy: false,
      hostedShards: [hashShardId(ENTITY_ID, NUM_SHARDS)],
      numShards: NUM_SHARDS,
    });

    expectEscaped(await recordMentioning(victim, 'already own'));
  });
});
