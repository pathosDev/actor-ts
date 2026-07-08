import { expect, test } from 'bun:test';
import {
  Actor,
  ActorSystem,
  ActorSystemOptions,
  Cluster,
  ClusterOptions,
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
  StartShardingOptions,
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

interface NodeCtx<TMessage> {
  system: ActorSystem;
  cluster: Cluster;
  region: ActorRef<TMessage>;
}

/** Minimal cluster node with a configured sharding region. */
async function startNode<TMessage>(opts: {
  systemName: string;
  host: string;
  port: number;
  seeds?: string[];
  roles?: string[];
  sharding: (sharding: ClusterSharding) => ActorRef<TMessage>;
}): Promise<NodeCtx<TMessage>> {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(opts.systemName, sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(opts.host)
    .withPort(opts.port)
    .withSeeds(opts.seeds ?? [])
    .withTransport(new InMemoryTransport(new NodeAddress(opts.systemName, opts.host, opts.port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  if (opts.roles !== undefined) clusterOptions.withRoles(opts.roles);
  const cluster = await Cluster.join(system, clusterOptions);
  const region = opts.sharding(cluster.sharding);
  return { system, cluster, region };
}

async function stopNode(n: NodeCtx<unknown>): Promise<void> {
  await n.cluster.leave();
  await n.system.terminate();
}

/* --------------------------------- Tests --------------------------------- */

test('Self events fire when own member transitions to Up', async () => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('self-up', sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('10.10.0.1')
    .withPort(31000)
    .withTransport(new InMemoryTransport(new NodeAddress('self-up', '10.10.0.1', 31000)));
  const cluster = await Cluster.join(
    system,
    clusterOptions,
  );
  let selfUp = 0;
  cluster.subscribe(e => { if (e instanceof SelfUp) selfUp++; });
  await sleep(100);
  expect(selfUp).toBeGreaterThanOrEqual(1);
  await cluster.leave();
  await system.terminate();
});

test('LeaderChanged fires when the oldest member leaves', async () => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys1 = ActorSystem.create('leader-x', sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('10.11.0.1')
    .withPort(32001)
    .withTransport(new InMemoryTransport(new NodeAddress('leader-x', '10.11.0.1', 32001)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const c1 = await Cluster.join(
    sys1,
    clusterOptions,
  );
  const sysOptions2 = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys2 = ActorSystem.create('leader-x', sysOptions2);
  const clusterOptions2 = ClusterOptions.create()
    .withHost('10.11.0.2')
    .withPort(32002)
    .withSeeds(['10.11.0.1:32001'])
    .withTransport(new InMemoryTransport(new NodeAddress('leader-x', '10.11.0.2', 32002)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const c2 = await Cluster.join(
    sys2,
    clusterOptions2,
  );
  await sleep(300);

  let leaderSeen: string | null = null;
  c2.subscribe(e => { if (e instanceof LeaderChanged) leaderSeen = e.leader.fold(() => null as string | null, l => l.address.toString()); });

  await c1.leave(); await sys1.terminate();
  await waitFor(() => leaderSeen === 'leader-x@10.11.0.2:32002', 1_500);
  expect(leaderSeen).toBe('leader-x@10.11.0.2:32002');

  await c2.leave(); await sys2.terminate();
});

type CounterCommand = { id: string; op: 'inc' };

test('Role filter: entities only land on members with the matching role', async () => {
  const seen = new Map<string, Map<string, number>>();
  function countingEntity(node: string) {
    return class extends Actor<CounterCommand> {
      override onReceive(cmd: CounterCommand): void {
        const perNode = seen.get(node) ?? new Map();
        perNode.set(cmd.id, (perNode.get(cmd.id) ?? 0) + 1);
        seen.set(node, perNode);
      }
    };
  }

  const spawnRegion = (name: string) => (s: ClusterSharding): ActorRef<CounterCommand> => {
    const startShardingOptions = StartShardingOptions.create<CounterCommand>()
      .withTypeName('counter')
      .withEntityProps(Props.create(() => new (countingEntity(name))()))
      .withExtractEntityId(msg => msg.id)
      .withNumShards(8)
      .withRole('backend');
    return s.start<CounterCommand>(
      startShardingOptions,
    );
  };

  const n1 = await startNode<CounterCommand>({ systemName: 'rl', host: '10.12.0.1', port: 33001, roles: ['backend'], sharding: spawnRegion('n1') });
  const n2 = await startNode<CounterCommand>({ systemName: 'rl', host: '10.12.0.2', port: 33002, seeds: ['10.12.0.1:33001'], roles: [], sharding: spawnRegion('n2') });
  const n3 = await startNode<CounterCommand>({ systemName: 'rl', host: '10.12.0.3', port: 33003, seeds: ['10.12.0.1:33001'], roles: ['backend'], sharding: spawnRegion('n3') });

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
  const backendEntity = () => new (class extends Actor<CounterCommand> {
    override preStart(): void { hosted.add(this.self.path.name); }
    override onReceive(_: CounterCommand): void {}
  })();

  const host = await startNode<CounterCommand>({
    systemName: 'prx', host: '10.13.0.1', port: 34001,
    sharding: s => {
      const startShardingOptions = StartShardingOptions.create<CounterCommand>()
        .withTypeName('counter')
        .withEntityProps(Props.create(backendEntity))
        .withExtractEntityId(m => m.id)
        .withNumShards(4);
      return s.start(
      startShardingOptions,
    );
    },
  });
  const proxy = await startNode<CounterCommand>({
    systemName: 'prx', host: '10.13.0.2', port: 34002, seeds: ['10.13.0.1:34001'],
    sharding: s => {
      const startShardingOptions = StartShardingOptions.create<CounterCommand>()
        .withTypeName('counter')
        .withEntityProps(Props.create(backendEntity));
      return s.startProxy(
      startShardingOptions // unused but required by types
        .withExtractEntityId(m => m.id)
        .withNumShards(4),
    );
    },
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
    sharding: s => {
      const startShardingOptions = StartShardingOptions.create<{ id: string; op: 'work' | 'sleep' }>()
        .withTypeName('passiv')
        .withEntityProps(Props.create(() => new Entity()))
        .withExtractEntityId(m => m.id)
        .withNumShards(4)
        .withPassivationIdleMs(0);
      return s.start(
      startShardingOptions, // passivation only via Passivate here
    );
    },
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
  const entity = (node: string) => new (class extends Actor<CounterCommand> {
    override preStart(): void { hosted.set(node, (hosted.get(node) ?? 0) + 1); }
    override onReceive(_: CounterCommand): void {}
  })();

  const mk = (name: string) => (s: ClusterSharding): ActorRef<CounterCommand> => {
    const startShardingOptions = StartShardingOptions.create<CounterCommand>()
      .withTypeName('counter')
      .withEntityProps(Props.create(() => entity(name)))
      .withExtractEntityId(m => m.id)
      .withNumShards(12)
      .withAllocationStrategy(new LeastShardAllocationStrategy(1, 3))
      .withRebalanceIntervalMs(300);
    return s.start<CounterCommand>(
      startShardingOptions,
    );
  };

  const n1 = await startNode<CounterCommand>({ systemName: 'lsa', host: '10.15.0.1', port: 36001, sharding: mk('n1') });
  const n2 = await startNode<CounterCommand>({ systemName: 'lsa', host: '10.15.0.2', port: 36002, seeds: ['10.15.0.1:36001'], sharding: mk('n2') });
  const n3 = await startNode<CounterCommand>({ systemName: 'lsa', host: '10.15.0.3', port: 36003, seeds: ['10.15.0.1:36001'], sharding: mk('n3') });

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
  const entity = (node: string) => new (class extends Actor<CounterCommand> {
    override preStart(): void {
      const s = active.get(node) ?? new Set();
      s.add(this.self.path.name); active.set(node, s);
    }
    override postStop(): void { active.get(node)?.delete(this.self.path.name); }
    override onReceive(_: CounterCommand): void {}
  })();

  const mk = (name: string) => (s: ClusterSharding): ActorRef<CounterCommand> => {
    const startShardingOptions = StartShardingOptions.create<CounterCommand>()
      .withTypeName('counter')
      .withEntityProps(Props.create(() => entity(name)))
      .withExtractEntityId(m => m.id)
      .withNumShards(8)
      .withRememberEntities(true)
      .withRebalanceIntervalMs(200);
    return s.start<CounterCommand>(
      startShardingOptions,
    );
  };

  const n1 = await startNode<CounterCommand>({ systemName: 'rem', host: '10.16.0.1', port: 37001, sharding: mk('n1') });
  const n2 = await startNode<CounterCommand>({ systemName: 'rem', host: '10.16.0.2', port: 37002, seeds: ['10.16.0.1:37001'], sharding: mk('n2') });
  const n3 = await startNode<CounterCommand>({ systemName: 'rem', host: '10.16.0.3', port: 37003, seeds: ['10.16.0.1:37001'], sharding: mk('n3') });

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
