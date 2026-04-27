import { expect, test } from 'bun:test';
import {
  Actor,
  ActorSystem,
  Cluster,
  ClusterSharding,
  HashAllocationStrategy,
  InMemoryTransport,
  LeastShardAllocationStrategy,
  LogLevel,
  NoopLogger,
  NodeAddress,
  Passivate,
  PoisonPill,
  Props,
  SelfUp,
  SelfRemoved,
  LeaderChanged,
} from '../src/index.js';
import type { ActorRef } from '../src/index.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs: number, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(stepMs);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface NodeCtx<TMsg> {
  system: ActorSystem;
  cluster: Cluster;
  region: ActorRef<TMsg>;
}

/** Minimal cluster node with a configured sharding region. */
async function startNode<TMsg>(opts: {
  systemName: string;
  host: string;
  port: number;
  seeds?: string[];
  roles?: string[];
  sharding: (sharding: ClusterSharding) => ActorRef<TMsg>;
}): Promise<NodeCtx<TMsg>> {
  const system = ActorSystem.create(opts.systemName, {
    logger: new NoopLogger(),
    logLevel: LogLevel.Off,
  });
  const cluster = await Cluster.join(system, {
    host: opts.host,
    port: opts.port,
    seeds: opts.seeds ?? [],
    roles: opts.roles,
    transport: new InMemoryTransport(new NodeAddress(opts.systemName, opts.host, opts.port)),
    failureDetector: { heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 },
    gossipIntervalMs: 80,
  });
  const region = opts.sharding(ClusterSharding.get(system, cluster));
  return { system, cluster, region };
}

async function stopNode(n: NodeCtx<unknown>): Promise<void> {
  await n.cluster.leave();
  await n.system.terminate();
}

/* --------------------------------- Tests --------------------------------- */

test('Self events fire when own member transitions to Up', async () => {
  const system = ActorSystem.create('self-up', { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const cluster = await Cluster.join(system, {
    host: '10.10.0.1', port: 31000,
    transport: new InMemoryTransport(new NodeAddress('self-up', '10.10.0.1', 31000)),
  });
  let selfUp = 0;
  cluster.subscribe(e => { if (e instanceof SelfUp) selfUp++; });
  await sleep(100);
  expect(selfUp).toBeGreaterThanOrEqual(1);
  await cluster.leave();
  await system.terminate();
});

test('LeaderChanged fires when the oldest member leaves', async () => {
  const sys1 = ActorSystem.create('leader-x', { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const c1 = await Cluster.join(sys1, {
    host: '10.11.0.1', port: 32001,
    transport: new InMemoryTransport(new NodeAddress('leader-x', '10.11.0.1', 32001)),
    failureDetector: { heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 },
    gossipIntervalMs: 80,
  });
  const sys2 = ActorSystem.create('leader-x', { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const c2 = await Cluster.join(sys2, {
    host: '10.11.0.2', port: 32002, seeds: ['10.11.0.1:32001'],
    transport: new InMemoryTransport(new NodeAddress('leader-x', '10.11.0.2', 32002)),
    failureDetector: { heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 },
    gossipIntervalMs: 80,
  });
  await sleep(300);

  let leaderSeen: string | null = null;
  c2.subscribe(e => { if (e instanceof LeaderChanged) leaderSeen = e.leader.fold(() => null as string | null, l => l.address.toString()); });

  await c1.leave(); await sys1.terminate();
  await waitFor(() => leaderSeen === 'leader-x@10.11.0.2:32002', 1_500);
  expect(leaderSeen).toBe('leader-x@10.11.0.2:32002');

  await c2.leave(); await sys2.terminate();
});

type CounterCmd = { id: string; op: 'inc' };

test('Role filter: entities only land on members with the matching role', async () => {
  const seen = new Map<string, Map<string, number>>();
  function countingEntity(node: string) {
    return class extends Actor<CounterCmd> {
      override onReceive(cmd: CounterCmd): void {
        const perNode = seen.get(node) ?? new Map();
        perNode.set(cmd.id, (perNode.get(cmd.id) ?? 0) + 1);
        seen.set(node, perNode);
      }
    };
  }

  const spawnRegion = (name: string) => (s: ClusterSharding): ActorRef<CounterCmd> =>
    s.start<CounterCmd>({
      typeName: 'counter',
      entityProps: Props.create(() => new (countingEntity(name))()),
      extractEntityId: msg => msg.id,
      numShards: 8,
      role: 'backend',
    });

  const n1 = await startNode<CounterCmd>({ systemName: 'rl', host: '10.12.0.1', port: 33001, roles: ['backend'], sharding: spawnRegion('n1') });
  const n2 = await startNode<CounterCmd>({ systemName: 'rl', host: '10.12.0.2', port: 33002, seeds: ['10.12.0.1:33001'], roles: [], sharding: spawnRegion('n2') });
  const n3 = await startNode<CounterCmd>({ systemName: 'rl', host: '10.12.0.3', port: 33003, seeds: ['10.12.0.1:33001'], roles: ['backend'], sharding: spawnRegion('n3') });

  await waitFor(() => [n1, n2, n3].every(n => n.cluster.upMembers().length === 3), 2_000);
  await sleep(150);

  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    n1.region.tell({ id, op: 'inc' });
  }
  await sleep(400);

  expect(seen.get('n2')).toBeUndefined(); // n2 has no backend role
  const n1Count = Array.from(seen.get('n1')?.values() ?? []).reduce((a, b) => a + b, 0);
  const n3Count = Array.from(seen.get('n3')?.values() ?? []).reduce((a, b) => a + b, 0);
  expect(n1Count + n3Count).toBe(8);

  await stopNode(n1); await stopNode(n2); await stopNode(n3);
});

test('Proxy region routes but never hosts entities', async () => {
  const hosted = new Set<string>();
  const backendEntity = () => new (class extends Actor<CounterCmd> {
    override preStart(): void { hosted.add(this.self.path.name); }
    override onReceive(_: CounterCmd): void {}
  })();

  const host = await startNode<CounterCmd>({
    systemName: 'prx', host: '10.13.0.1', port: 34001,
    sharding: s => s.start({
      typeName: 'counter',
      entityProps: Props.create(backendEntity),
      extractEntityId: m => m.id,
      numShards: 4,
    }),
  });
  const proxy = await startNode<CounterCmd>({
    systemName: 'prx', host: '10.13.0.2', port: 34002, seeds: ['10.13.0.1:34001'],
    sharding: s => s.startProxy({
      typeName: 'counter',
      entityProps: Props.create(backendEntity), // unused but required by types
      extractEntityId: m => m.id,
      numShards: 4,
    }),
  });

  await waitFor(() => host.cluster.upMembers().length === 2 && proxy.cluster.upMembers().length === 2, 2_000);
  await sleep(150);

  // Send from proxy; must route to host.
  proxy.region.tell({ id: 'x', op: 'inc' });
  proxy.region.tell({ id: 'y', op: 'inc' });
  await sleep(300);

  expect(hosted.size).toBe(2); // both entities materialised on host

  await stopNode(host); await stopNode(proxy);
});

test('Passivation stops idle entity and buffers next message until re-create', async () => {
  let created = 0;
  let stopped = 0;

  class Entity extends Actor<{ id: string; op: 'work' | 'sleep' }> {
    override preStart(): void { created++; }
    override postStop(): void { stopped++; }
    override onReceive(msg: { id: string; op: 'work' | 'sleep' }): void {
      if (msg.op === 'sleep') {
        // Ask the region to passivate us. We tell it to use PoisonPill
        // as the stop message so that we terminate cleanly when it arrives.
        this.context.parent.forEach((p) => p.tell(
          new Passivate(PoisonPill.instance, this.self),
          this.self,
        ));
      }
    }
  }

  const node = await startNode<{ id: string; op: 'work' | 'sleep' }>({
    systemName: 'pas', host: '10.14.0.1', port: 35001,
    sharding: s => s.start({
      typeName: 'passiv',
      entityProps: Props.create(() => new Entity()),
      extractEntityId: m => m.id,
      numShards: 4,
      passivationIdleMs: 0, // passivation only via Passivate here
    }),
  });
  await sleep(100);

  node.region.tell({ id: '1', op: 'work' });
  node.region.tell({ id: '1', op: 'sleep' });
  await sleep(200);
  expect(created).toBe(1);
  expect(stopped).toBe(1);

  // Next message should cause a fresh entity (created==2).
  node.region.tell({ id: '1', op: 'work' });
  await sleep(200);
  expect(created).toBe(2);

  await stopNode(node);
});

test('LeastShardAllocationStrategy balances shards across nodes', async () => {
  const hosted = new Map<string, number>();
  const entity = (node: string) => new (class extends Actor<CounterCmd> {
    override preStart(): void { hosted.set(node, (hosted.get(node) ?? 0) + 1); }
    override onReceive(_: CounterCmd): void {}
  })();

  const mk = (name: string) => (s: ClusterSharding): ActorRef<CounterCmd> =>
    s.start<CounterCmd>({
      typeName: 'counter',
      entityProps: Props.create(() => entity(name)),
      extractEntityId: m => m.id,
      numShards: 12,
      allocationStrategy: new LeastShardAllocationStrategy(1, 3),
      rebalanceIntervalMs: 300,
    });

  const n1 = await startNode<CounterCmd>({ systemName: 'lsa', host: '10.15.0.1', port: 36001, sharding: mk('n1') });
  const n2 = await startNode<CounterCmd>({ systemName: 'lsa', host: '10.15.0.2', port: 36002, seeds: ['10.15.0.1:36001'], sharding: mk('n2') });
  const n3 = await startNode<CounterCmd>({ systemName: 'lsa', host: '10.15.0.3', port: 36003, seeds: ['10.15.0.1:36001'], sharding: mk('n3') });

  await waitFor(() => [n1, n2, n3].every(n => n.cluster.upMembers().length === 3), 2_000);
  await sleep(150);

  // Materialize an entity per shard from n1.
  const ids = Array.from({ length: 12 }, (_, i) => `e${i}`);
  for (const id of ids) n1.region.tell({ id, op: 'inc' });

  // Allow initial allocation + a rebalance pass.
  await sleep(1_200);

  const loads = [hosted.get('n1') ?? 0, hosted.get('n2') ?? 0, hosted.get('n3') ?? 0];
  const total = loads.reduce((a, b) => a + b, 0);
  expect(total).toBeGreaterThanOrEqual(12);
  // Strategy should spread reasonably across all 3 nodes.
  expect(loads.filter(l => l > 0).length).toBe(3);

  await stopNode(n1); await stopNode(n2); await stopNode(n3);
});

test('rememberEntities re-creates entities on the new owner after node death', async () => {
  const active = new Map<string, Set<string>>();
  const entity = (node: string) => new (class extends Actor<CounterCmd> {
    override preStart(): void {
      const s = active.get(node) ?? new Set();
      s.add(this.self.path.name); active.set(node, s);
    }
    override postStop(): void { active.get(node)?.delete(this.self.path.name); }
    override onReceive(_: CounterCmd): void {}
  })();

  const mk = (name: string) => (s: ClusterSharding): ActorRef<CounterCmd> =>
    s.start<CounterCmd>({
      typeName: 'counter',
      entityProps: Props.create(() => entity(name)),
      extractEntityId: m => m.id,
      numShards: 8,
      rememberEntities: true,
      rebalanceIntervalMs: 200,
    });

  const n1 = await startNode<CounterCmd>({ systemName: 'rem', host: '10.16.0.1', port: 37001, sharding: mk('n1') });
  const n2 = await startNode<CounterCmd>({ systemName: 'rem', host: '10.16.0.2', port: 37002, seeds: ['10.16.0.1:37001'], sharding: mk('n2') });
  const n3 = await startNode<CounterCmd>({ systemName: 'rem', host: '10.16.0.3', port: 37003, seeds: ['10.16.0.1:37001'], sharding: mk('n3') });

  await waitFor(() => [n1, n2, n3].every(n => n.cluster.upMembers().length === 3), 2_000);
  await sleep(200);

  // Create a handful of entities from n1 so the coordinator registers them.
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  for (const id of ids) n1.region.tell({ id, op: 'inc' });
  await sleep(500);

  // Identify one entity living on n2, then kill n2.
  const before = active.get('n2') ?? new Set();
  expect(before.size).toBeGreaterThan(0);
  const movedEntity = before.values().next().value as string;

  await stopNode(n2);
  await sleep(1_200);

  // The moved entity must show up on n1 or n3 without any new user message.
  const resurrection = [
    active.get('n1')?.has(movedEntity) ?? false,
    active.get('n3')?.has(movedEntity) ?? false,
  ];
  expect(resurrection.some(Boolean)).toBe(true);

  await stopNode(n1); await stopNode(n3);
});

test('HashAllocationStrategy allocates deterministically across sorted members', async () => {
  const a = new NodeAddress('s', 'h', 1);
  const b = new NodeAddress('s', 'h', 2);
  const strategy = new HashAllocationStrategy();
  for (let i = 0; i < 20; i++) {
    const owner1 = strategy.allocate(i, [a, b], new Map());
    const owner2 = strategy.allocate(i, [b, a], new Map()); // different insertion order
    expect(owner1.equals(owner2)).toBe(true);
  }
});
