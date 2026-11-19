/**
 * A remembered entity that exhausts its restart budget stays remembered, and
 * comes back on its own (#954).
 *
 * Its shard used to report the budget's final stop as a bare `EntityStopped`,
 * the coordinator persisted that as `stopped`, and the entity was gone from
 * the durable registry: the next failover — the case remember-entities exists
 * for — restored everything except it.  The shard now says the stop was
 * `'unrequested'`, the coordinator forgets only a `'passivated'` one, and the
 * shard re-creates an unrequested stop at the end of its restart backoff.
 *
 * Two cases, one per half of the wiring:
 *
 * - **The registry keeps it across a failover.**  The restart backoff is long,
 *   so nothing re-creates the entity in the first life and re-adds it to the
 *   registry by a fresh `started`.  The first node is then terminated and a
 *   second one comes up over the same journal — the failover, reduced to the
 *   one node that owns the shard — and the entity has to start there from the
 *   registry alone.
 * - **It comes back without a message.**  The backoff is short, and no message
 *   for the entity is sent after its last failure.
 *
 * The budget is a real one, `OneForOneStrategy` with one restart a minute, so
 * the second failure is the one supervision answers with a stop.
 */
import { match } from 'ts-pattern';
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorOptions } from '../../../../../src/ActorOptions.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { JournalRememberEntitiesStore, type RememberEvent } from '../../../../../src/cluster/sharding/RememberEntitiesStore.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { Directive, OneForOneStrategy } from '../../../../../src/Supervision.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';
import { regionSegments } from '../../../../util/SystemPaths.js';

const TYPE_NAME = 'crash-survival';

type PingCommand = { readonly kind: 'ping'; readonly id: string };
type FailCommand = { readonly kind: 'fail'; readonly id: string };
type Command = PingCommand | FailCommand;

/** Every entity id that reached `preStart`, in order, across both lives. */
let started: string[] = [];

class Entity extends Actor<Command> {
  override preStart(): void { started.push(this.entityId); }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'ping' }, () => this.onPing())
      .with({ kind: 'fail' }, () => this.onFail())
      .exhaustive();
  }

  private onPing(): void {}

  private onFail(): void { throw new Error(`entity ${this.entityId} failed on purpose`); }
}

/** One restart a minute: the second failure exhausts the budget. */
const oneRestart = new OneForOneStrategy(() => Directive.Restart, { maxRetries: 1, withinTimeRangeMs: 60_000 });

type Node = { readonly system: ActorSystem; readonly cluster: Cluster; readonly region: ActorRef<Command> };

let nodes: Node[] = [];

afterEach(async () => {
  for (const node of nodes) {
    await node.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await node.system.terminate().catch(() => { /* teardown is best-effort */ });
  }
  nodes = [];
  started = [];
});

async function startNode(name: string, port: number, journal: InMemoryJournal, backoffMs: number): Promise<Node> {
  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  const entityOptions = ActorOptions.create<Command>().withSupervisorStrategy(oneRestart);
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withEntityOptions(entityOptions)
    .withExtractEntityId((message) => message.id)
    .withNumShards(1)
    .withRememberEntities(true)
    .withRememberEntitiesStore(new JournalRememberEntitiesStore(journal))
    .withPassivationIdleMs(0)
    .withEntityRestartBackoffMinMs(backoffMs)
    .withEntityRestartBackoffMaxMs(backoffMs)
    .withEntityRestartBackoffRandomFactor(0);
  const region = cluster.sharding.start<Command>(shardingOptions);
  const node = { system, cluster, region };
  nodes.push(node);
  return node;
}

function entityIsUp(node: Node, entityId: string): boolean {
  return node.system._resolvePath([...regionSegments(node.system.name, TYPE_NAME), 'shard-0', `entity-${entityId}`])
    .isSome();
}

/** The registry the journal holds, folded — what a coordinator would load. */
async function remembered(journal: InMemoryJournal): Promise<Set<string>> {
  const live = new Set<string>();
  const events: RememberEvent[] = await new JournalRememberEntitiesStore(journal).load(TYPE_NAME);
  for (const event of events) {
    if (event.kind === 'started') live.add(event.entityId);
    else live.delete(event.entityId);
  }
  return live;
}

function startsOf(entityId: string): number {
  return started.filter((id) => id === entityId).length;
}

/** Fail `entityId` until its budget is spent and its shard has stopped it. */
async function exhaustBudget(node: Node, entityId: string): Promise<void> {
  node.region.tell({ kind: 'fail', id: entityId });
  await awaitCondition(() => startsOf(entityId) === 2, { timeoutMs: 3_000, label: `'${entityId}' restarted once` });
  node.region.tell({ kind: 'fail', id: entityId });
  await awaitCondition(() => !entityIsUp(node, entityId), { timeoutMs: 3_000, label: `'${entityId}' stopped for good` });
}

describe('ClusterSharding — a remembered entity past its restart budget (#954)', () => {
  test('stays in the durable registry and starts on the node that takes over', async () => {
    const journal = new InMemoryJournal();
    // A backoff longer than the test, so nothing re-creates the entity in this
    // life and writes it back into the registry with a fresh `started`.
    const first = await startNode('crash-survival-1', 47_410, journal, 60_000);
    first.region.tell({ kind: 'ping', id: 'steady' });
    first.region.tell({ kind: 'ping', id: 'fragile' });
    await awaitCondition(async () => (await remembered(journal)).size === 2, {
      timeoutMs: 3_000,
      label: 'both entities are remembered',
    });

    await exhaustBudget(first, 'fragile');
    // The fence: an entity started behind the stop travels the same region →
    // coordinator → store path, so once it is in the journal, the stop's
    // report has been handled — and, before #954, persisted.
    first.region.tell({ kind: 'ping', id: 'fence' });
    await awaitCondition(async () => (await remembered(journal)).has('fence'), {
      timeoutMs: 3_000,
      label: 'the fence entity is remembered',
    });
    expect(await remembered(journal)).toEqual(new Set(['steady', 'fragile', 'fence']));

    // The failover: this node goes, another comes up over the same journal.
    await first.cluster.leave();
    await first.system.terminate();
    nodes = [];
    started = [];
    const second = await startNode('crash-survival-2', 47_411, journal, 60_000);
    second.region.tell({ kind: 'ping', id: 'steady' });

    await awaitCondition(() => started.includes('fragile'), {
      timeoutMs: 5_000,
      label: 'the entity that exhausted its budget started on the new node',
    });
    expect(new Set(started)).toEqual(new Set(['steady', 'fragile', 'fence']));
  }, 15_000);

  test('is re-created at the end of its restart backoff, with no message for it', async () => {
    const journal = new InMemoryJournal();
    const node = await startNode('crash-survival-3', 47_412, journal, 150);
    node.region.tell({ kind: 'ping', id: 'fragile' });
    await awaitCondition(() => startsOf('fragile') === 1, { timeoutMs: 3_000, label: 'the entity started' });

    await exhaustBudget(node, 'fragile');
    // No message for it from here on.
    await awaitCondition(() => startsOf('fragile') === 3 && entityIsUp(node, 'fragile'), {
      timeoutMs: 3_000,
      label: 'the entity came back on its own',
    });
    expect(await remembered(journal)).toEqual(new Set(['fragile']));
  }, 15_000);
});
