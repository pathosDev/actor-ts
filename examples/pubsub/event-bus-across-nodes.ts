/**
 * Realistic PubSub: three nodes in an in-memory cluster form a shared event
 * bus.  Node A publishes domain events to several topics; nodes B and C
 * subscribe to the topics they care about and react locally.  No node knows
 * where the others' subscribers live — the mediators gossip the topic map.
 *
 *   bun run examples/pubsub/event-bus-across-nodes.ts
 *
 * Expected:
 *   - [nodeB@orders] sees ORDER events from A
 *   - [nodeC@shipping] sees SHIPPING events from A
 *   - both nodes see BROADCAST events
 *   - after B leaves, A's publishes no longer try to reach B
 */
import { Actor, ActorSystem, Cluster, ClusterOptions, InMemoryTransport, NodeAddress, Props } from '../../src/index.js';
import { DistributedPubSubId, DistributedPubSubOptions, Publish, Subscribe } from '../../src/cluster/pubsub/index.js';

interface DomainEvent { readonly type: string; readonly payload: unknown; }

class TopicListener extends Actor<DomainEvent> {
  constructor(private readonly label: string) { super(); }
  override onReceive(evt: DomainEvent): void {
    console.log(`[${this.label}] received ${evt.type} → ${JSON.stringify(evt.payload)}`);
  }
}

async function startNode(host: string, port: number, seeds: string[] = []): Promise<{
  system: ActorSystem;
  cluster: Cluster;
  mediator: import('../../src/ActorRef.js').ActorRef<Subscribe | Publish>;
}> {
  const system = ActorSystem.create('events');
  const clusterOptions = ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress('events', host, port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(system, clusterOptions);
  const pubSubOptions = DistributedPubSubOptions.create()
    .withGossipIntervalMs(100);
  const mediator = system.extension(DistributedPubSubId).start(cluster, pubSubOptions);
  return { system, cluster, mediator };
}

async function waitUntil(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(25);
  }
  throw new Error('waitUntil timed out');
}

async function main(): Promise<void> {
  const a = await startNode('a', 7100);
  const b = await startNode('b', 7101, ['events@a:7100']);
  const c = await startNode('c', 7102, ['events@a:7100']);

  await waitUntil(() =>
    a.cluster.upMembers().length === 3 &&
    b.cluster.upMembers().length === 3 &&
    c.cluster.upMembers().length === 3,
  );
  console.log('cluster formed with 3 nodes');

  // B cares about orders + everything broadcast.
  const bOrders = b.system.spawnAnonymous(Props.create(() => new TopicListener('nodeB@orders')));
  b.mediator.tell(new Subscribe('orders', bOrders));
  const bBroadcast = b.system.spawnAnonymous(Props.create(() => new TopicListener('nodeB@broadcast')));
  b.mediator.tell(new Subscribe('broadcast', bBroadcast));

  // C cares about shipping + broadcast.
  const cShipping = c.system.spawnAnonymous(Props.create(() => new TopicListener('nodeC@shipping')));
  c.mediator.tell(new Subscribe('shipping', cShipping));
  const cBroadcast = c.system.spawnAnonymous(Props.create(() => new TopicListener('nodeC@broadcast')));
  c.mediator.tell(new Subscribe('broadcast', cBroadcast));

  // Let two gossip rounds replicate the topic registry.
  await Bun.sleep(350);

  // A publishes from where the events originate.
  a.mediator.tell(new Publish('orders', { type: 'OrderPlaced', payload: { id: 42, total: 99.5 } }));
  a.mediator.tell(new Publish('shipping', { type: 'ShipmentDispatched', payload: { orderId: 42, tracking: 'X-123' } }));
  a.mediator.tell(new Publish('broadcast', { type: 'SystemAnnouncement', payload: 'nightly maintenance at 02:00' }));

  await Bun.sleep(150);
  console.log('--- B leaves ---');
  await b.cluster.leave();
  await b.system.terminate();

  // Give A and C time to prune B's subscriptions.
  await Bun.sleep(600);

  // Publish again — only C should react now; A no longer forwards to B.
  a.mediator.tell(new Publish('orders', { type: 'OrderPlaced', payload: { id: 43, total: 12.0 } }));
  a.mediator.tell(new Publish('broadcast', { type: 'SystemAnnouncement', payload: 'all clear' }));

  await Bun.sleep(200);
  await a.cluster.leave(); await a.system.terminate();
  await c.cluster.leave(); await c.system.terminate();
}

void main();
