/**
 * Hello-PubSub: three subscribers on the same node join a chat room and see
 * each other's messages via the DistributedPubSubMediator.
 *
 *   bun run examples/pubsub/chat-mediator.ts
 *
 * Expected output: each subscriber logs every message posted to "chat".
 */
import { Actor, ActorSystem, Cluster, InMemoryTransport, NodeAddress, Props } from '../../src/index.js';
import { DistributedPubSubId, Publish, Subscribe } from '../../src/cluster/pubsub/index.js';

interface ChatMessage { readonly from: string; readonly text: string; }

class Subscriber extends Actor<ChatMessage> {
  constructor(private readonly name: string) { super(); }
  override onReceive(msg: ChatMessage): void {
    console.log(`[${this.name}] <${msg.from}> ${msg.text}`);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('chat');
  // Single-node in-memory cluster — pub-sub also works cluster-wide (see event-bus-across-nodes.ts).
  const cluster = await Cluster.join(system, {
    host: 'local', port: 1,
    transport: new InMemoryTransport(new NodeAddress('chat', 'local', 1)),
  });

  const mediator = system.extension(DistributedPubSubId).start(cluster);

  for (const name of ['alice', 'bob', 'carol']) {
    const sub = system.spawn(Props.create(() => new Subscriber(name)), name);
    mediator.tell(new Subscribe('chat', sub));
  }

  // Give the subscriptions a tick to settle into the mediator's local table.
  await Bun.sleep(20);

  mediator.tell(new Publish('chat', { from: 'alice', text: 'hi everyone' }));
  mediator.tell(new Publish('chat', { from: 'bob', text: 'morning!' }));
  mediator.tell(new Publish('chat', { from: 'carol', text: 'ready for standup?' }));

  await Bun.sleep(50);
  await cluster.leave();
  await system.terminate();
}

void main();
