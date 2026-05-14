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
import {
  Actor,
  ActorSystem,
  Cluster,
  ClusterSingletonId,
  InMemoryTransport,
  NodeAddress,
  Props,
  type ActorRef,
} from '../../src/index.js';

type CronCmd = { kind: 'subscribe'; sub: ActorRef<CronEvent> } | { kind: 'tick' };
interface CronEvent { readonly tickNumber: number; readonly hostedOn: string; }

class Cron extends Actor<CronCmd> {
  private n = 0;
  private readonly subs = new Set<ActorRef<CronEvent>>();
  constructor(private readonly host: string) { super(); }

  override preStart(): void {
    console.log(`[${this.host}] cron spawned — scheduling ticks`);
    this.context.timers.startTimerWithFixedDelay('tick', { kind: 'tick' }, 250, 100);
  }
  override onReceive(cmd: CronCmd): void {
    if (cmd.kind === 'subscribe') { this.subs.add(cmd.sub); return; }
    this.n++;
    const evt: CronEvent = { tickNumber: this.n, hostedOn: this.host };
    console.log(`[${this.host}] tick #${this.n}`);
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
  const { system, cluster } = await Cluster.bootstrap({
    name: 'cron-cluster',
    host, port, seeds,
    transport: new InMemoryTransport(new NodeAddress('cron-cluster', host, port)),
    failureDetector: { heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 },
    gossipIntervalMs: 80,
    receptionist: false,
    shutdownOnSignals: false,
  });
  return { sys: system, cluster, name: host };
}

async function main(): Promise<void> {
  const a = await startNode('a', 9001);
  const b = await startNode('b', 9002, ['cron-cluster@a:9001']);
  const c = await startNode('c', 9003, ['cron-cluster@a:9001']);

  // Wait until all three see each other.
  await Bun.sleep(300);

  // Each node installs its own singleton manager — only the leader hosts
  // the Cron actor.
  for (const { sys, cluster, name } of [a, b, c]) {
    sys.extension(ClusterSingletonId).start(cluster, {
      typeName: 'cron',
      props: Props.create(() => new Cron(name)),
    });
  }

  // Spawn a client on each node and subscribe it via the proxy.
  for (const { sys, name } of [a, b, c]) {
    const client = sys.spawnAnonymous(Props.create(() => new CronClient(name)));
    sys.extension(ClusterSingletonId).get<CronCmd>('cron').forEach(h =>
      h.proxy.tell({ kind: 'subscribe', sub: client }),
    );
  }

  // Let the cluster tick for a while.
  await Bun.sleep(900);
  console.log('--- killing the current leader ---');
  const currentLeader = a.cluster.leader()!.address;
  const victim = [a, b, c].find(n => n.cluster.selfAddress.equals(currentLeader))!;
  await victim.cluster.leave();
  await victim.sys.terminate();

  // Ticks should continue on whichever node became the new leader.
  await Bun.sleep(900);

  for (const { sys, cluster } of [a, b, c]) {
    if (sys === victim.sys) continue;
    await cluster.leave(); await sys.terminate();
  }
}

void main();
