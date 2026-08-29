/**
 * Realistic Singleton: a cluster-wide "cron" actor that emits a tick every
 * 250ms.  If the leader dies, the singleton moves to the surviving node
 * automatically.  Every node holds a proxy, so clients don't have to know
 * where the cron lives.
 *
 *   bun run examples/cluster/singleton-cron.ts
 *
 * Expected output: ticks labelled with the current host (e.g. [a] tick #1);
 * after ~1s node A is shut down — you will see subsequent ticks labelled
 * with [b] or [c] as failover takes effect.
 */
import { match } from 'ts-pattern';
import {
  Actor,
  ActorSystem,
  type ActorRef,
} from '../../src/index.js';
import {
  Cluster,
  ClusterBootstrapOptions,
  InMemoryTransport,
  NodeAddress,
  SingletonKey,
} from '../../src/cluster/index.js';

type SubscribeCommand = { kind: 'subscribe'; sub: ActorRef<CronEvent> };
type TickCommand = { kind: 'tick' };

type CronCommand = SubscribeCommand | TickCommand;
type CronEvent = { readonly tickNumber: number; readonly hostedOn: string; };

class Cron extends Actor<CronCommand> {
  /** The singleton's identity, declared on the actor itself. */
  static readonly singleton = SingletonKey.of<CronCommand>('cron');

  private tickCount = 0;
  private readonly subs = new Set<ActorRef<CronEvent>>();
  constructor(private readonly host: string) { super(); }

  override preStart(): void {
    console.log(`[${this.host}] cron spawned — scheduling ticks`);
    this.context.timers.startTimerWithFixedDelay('tick', { kind: 'tick' }, 250, 100);
  }
  override onReceive(command: CronCommand): void {
    match(command)
      .with({ kind: 'subscribe' }, (c) => this.onSubscribe(c))
      .with({ kind: 'tick' }, () => this.onTick())
      .exhaustive();
  }

  private onSubscribe(command: SubscribeCommand): void {
    this.subs.add(command.sub);
  }

  private onTick(): void {
    this.tickCount++;
    const evt: CronEvent = { tickNumber: this.tickCount, hostedOn: this.host };
    console.log(`[${this.host}] tick #${this.tickCount}`);
    for (const s of this.subs) s.tell(evt);
  }
}

class CronClient extends Actor<CronEvent> {
  constructor(private readonly where: string) { super(); }
  override onReceive(e: CronEvent): void {
    console.log(`  (client@${this.where}) saw tick #${e.tickNumber} hosted on ${e.hostedOn}`);
  }
}

async function startNode(host: string, port: number, seeds: string[] = []): Promise<{
  sys: ActorSystem; cluster: Cluster; name: string;
}> {
  const { system, cluster } = await Cluster.bootstrap(
    ClusterBootstrapOptions.create('cron-cluster')
      .withHost(host)
      .withPort(port)
      .withSeeds(seeds)
      .withTransport(new InMemoryTransport(new NodeAddress('cron-cluster', host, port)))
      .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
      .withGossipIntervalMs(80)
      .withReceptionist(false)
      .withShutdownOnSignals(false));
  return { sys: system, cluster, name: host };
}

async function main(): Promise<void> {
  const nodeA = await startNode('a', 9001);
  const nodeB = await startNode('b', 9002, ['cron-cluster@a:9001']);
  const nodeC = await startNode('c', 9003, ['cron-cluster@a:9001']);

  // Wait until all three see each other.
  await Bun.sleep(300);

  // Each node installs its own singleton manager — only the leader hosts
  // the Cron actor.
  for (const { cluster, name } of [nodeA, nodeB, nodeC]) {
    cluster.singleton.start(Cron, () => new Cron(name));
  }

  // Spawn a client on each node and subscribe it via the proxy.
  for (const { sys, cluster, name } of [nodeA, nodeB, nodeC]) {
    const client = sys.spawnAnonymous(() => new CronClient(name));
    cluster.singleton.ref(Cron).tell({ kind: 'subscribe', sub: client });
  }

  // Let the cluster tick for a while.
  await Bun.sleep(900);
  console.log('--- killing the current leader ---');
  // `leader()` is an Option — `!` would hand back the Option itself, whose
  // `.address` is undefined.
  const currentLeader = nodeA.cluster.leader();
  if (currentLeader.isNone()) throw new Error('no leader elected');
  const victim = [nodeA, nodeB, nodeC]
    .find(node => node.cluster.selfAddress.equals(currentLeader.value.address))!;
  await victim.cluster.leave();
  await victim.sys.terminate();

  // Ticks should continue on whichever node became the new leader.
  await Bun.sleep(900);

  for (const { sys, cluster } of [nodeA, nodeB, nodeC]) {
    if (sys === victim.sys) continue;
    await cluster.leave(); await sys.terminate();
  }
}

void main();
