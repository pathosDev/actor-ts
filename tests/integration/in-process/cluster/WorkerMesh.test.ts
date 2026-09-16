/**
 * The in-process worker-mesh rig: two or three `ActorSystem`s on this
 * thread, each a real `Cluster` node on a real `MessageChannelTransport`,
 * routed through one `WorkerBroker` — the star a worker mesh is, with no
 * thread underneath.  What this file verifies (#1564): membership converges
 * over the broker, an actor's `tell` reaches an actor on the other node
 * through a `RemoteActorRef`, a cross-node `ask` brings its reply back to
 * the asking node (the `RefCodec` reply-ref round trip), the receiver's
 * `context.sender` names the remote sender (#1561), and an unclustered
 * node's local traffic is unaffected.  Sharding over this rig is
 * `WorkerMeshSharding.test.ts`; singletons and the coordinator are
 * `WorkerMeshSystemActors.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { RemoteActorRef } from '../../../../src/cluster/RemoteActorRef.js';
import {
  MessageChannelTransport,
  type PortLike,
} from '../../../../src/cluster/transports/MessageChannelTransport.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { TestProbe } from '../../../../src/testkit/TestProbe.js';
import { WorkerBroker } from '../../../../src/worker/WorkerBroker.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

/**
 * Kept as a name so every call site here stays unchanged; the body forwards to
 * the shared helper (#418).
 */
const waitFor = (
  predicate: () => boolean,
  timeoutMs = 2_000,
  stepMs = 25,
  label = 'the awaited broker-mesh state',
): Promise<void> => awaitCondition(predicate, { timeoutMs, intervalMs: stepMs, label });

type Node = {
  system: ActorSystem;
  cluster: Cluster;
  address: NodeAddress;
};

type Greeting = { readonly kind: 'greeting'; readonly text: string };
type Question = { readonly kind: 'question'; readonly text: string; readonly replyTo: ActorRef<string> };

async function startNode(
  systemName: string,
  addr: NodeAddress,
  broker: WorkerBroker,
  seeds: string[] = [],
): Promise<Node> {
  const ch = new MessageChannel();
  const brokerPort = ch.port1 as unknown as PortLike;
  const workerPort = ch.port2 as unknown as PortLike;
  broker.register(addr, brokerPort);

  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(addr.host)
    .withPort(addr.port)
    .withSeeds(seeds)
    .withTransport(new MessageChannelTransport(addr, workerPort))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, address: addr };
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave();
  await node.system.terminate();
}

describe('WorkerBroker ↔ MessageChannelTransport end-to-end', () => {
  test('two broker-connected nodes see each other as Up', async () => {
    const broker = new WorkerBroker();
    const addrA = new NodeAddress('wm-two', 'w', 1);
    const addrB = new NodeAddress('wm-two', 'w', 2);

    const nodeA = await startNode('wm-two', addrA, broker);
    const nodeB = await startNode('wm-two', addrB, broker, [addrA.toString()]);

    await waitFor(() =>
      nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      2_000,
    );

    await stopNode(nodeA);
    await stopNode(nodeB);
    broker.close();
  });

  test('messages flow actor-to-actor across the broker: a tell from node A lands on node B', async () => {
    const broker = new WorkerBroker();
    const addrA = new NodeAddress('wm-msg', 'w', 1);
    const addrB = new NodeAddress('wm-msg', 'w', 2);

    const nodeA = await startNode('wm-msg', addrA, broker);
    const nodeB = await startNode('wm-msg', addrB, broker, [addrA.toString()]);
    await waitFor(() =>
      nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      2_000,
    );

    // The receiver lives on B and records what reaches it; a probe on B is
    // how the test reads the receiver's mailbox without a second hop.
    const received = new TestProbe(nodeB.system);
    class Sink extends Actor<Greeting> {
      override onReceive(message: Greeting): void { received.tell(message); }
    }
    nodeB.system.spawn(Sink, 'sink');

    // The sender lives on A and holds nothing but a remote ref to B's actor.
    const remote = new RemoteActorRef<Greeting>(addrB, `actor-ts://wm-msg/user/sink`, nodeA.cluster);
    class Greeter extends Actor<string> {
      override onReceive(text: string): void { remote.tell({ kind: 'greeting', text }); }
    }
    const greeter = nodeA.system.spawn(Greeter, 'greeter');
    greeter.tell('hello across the broker');

    expect(await received.receiveOne(2_000)).toEqual({ kind: 'greeting', text: 'hello across the broker' });

    await stopNode(nodeA); await stopNode(nodeB);
    broker.close();
  });

  test('a cross-node ask brings its reply back to the asking node', async () => {
    const broker = new WorkerBroker();
    const addrA = new NodeAddress('wm-ask', 'w', 1);
    const addrB = new NodeAddress('wm-ask', 'w', 2);

    const nodeA = await startNode('wm-ask', addrA, broker);
    const nodeB = await startNode('wm-ask', addrB, broker, [addrA.toString()]);
    await waitFor(() =>
      nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      2_000,
    );

    class Echo extends Actor<Question> {
      override onReceive(question: Question): void {
        question.replyTo.tell(`${this.cluster.selfAddress.toString()} says ${question.text}`);
      }
    }
    nodeB.system.spawn(Echo, 'echo');
    const remote = new RemoteActorRef<Question>(addrB, `actor-ts://wm-ask/user/echo`, nodeA.cluster);

    // The reply ref the ask synthesises on A is rewritten to a wire marker
    // on the way out and rebuilt on B; B's reply crosses back through the
    // broker to the ref A registered for it.
    expect(await remote.ask<string>({ kind: 'question', text: 'who are you' }, 2_000))
      .toBe(`${addrB.toString()} says who are you`);

    await stopNode(nodeA); await stopNode(nodeB);
    broker.close();
  });

  test('the receiver sees the remote sender: context.sender names the actor on the other node (#1561)', async () => {
    const broker = new WorkerBroker();
    const addrA = new NodeAddress('wm-sender', 'w', 1);
    const addrB = new NodeAddress('wm-sender', 'w', 2);

    const nodeA = await startNode('wm-sender', addrA, broker);
    const nodeB = await startNode('wm-sender', addrB, broker, [addrA.toString()]);
    await waitFor(() =>
      nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      2_000,
    );

    const observed = new TestProbe(nodeB.system);
    class SenderReporter extends Actor<Greeting> {
      override onReceive(): void {
        // The sender is a `RemoteActorRef` built from the envelope's `from`;
        // its path is the sending actor's, and a reply to it crosses back.
        const sender = this.context.sender;
        observed.tell(sender.map((ref) => ref.path.toString()).getOrElse('none'));
        sender.forEach((ref) => (ref as ActorRef<Greeting>).tell({ kind: 'greeting', text: 'and to you' }));
      }
    }
    nodeB.system.spawn(SenderReporter, 'reporter');

    const heardBack = new TestProbe(nodeA.system);
    const remote = new RemoteActorRef<Greeting>(addrB, `actor-ts://wm-sender/user/reporter`, nodeA.cluster);
    class Caller extends Actor<Greeting | string> {
      override onReceive(message: Greeting | string): void {
        if (typeof message === 'string') remote.tell({ kind: 'greeting', text: message }, this.context.self);
        else heardBack.tell(message);
      }
    }
    const caller = nodeA.system.spawn(Caller, 'caller');
    caller.tell('good morning');

    expect(await observed.receiveOne(2_000)).toBe('actor-ts://wm-sender/user/caller');
    expect(await heardBack.receiveOne(2_000)).toEqual({ kind: 'greeting', text: 'and to you' });

    await stopNode(nodeA); await stopNode(nodeB);
    broker.close();
  });

  test('three-node mesh: every node sees every other as Up', async () => {
    const broker = new WorkerBroker();
    const addrs = [
      new NodeAddress('wm-three', 'w', 1),
      new NodeAddress('wm-three', 'w', 2),
      new NodeAddress('wm-three', 'w', 3),
    ];
    const nodes: Node[] = [];
    nodes.push(await startNode('wm-three', addrs[0]!, broker));
    nodes.push(await startNode('wm-three', addrs[1]!, broker, [addrs[0]!.toString()]));
    nodes.push(await startNode('wm-three', addrs[2]!, broker, [addrs[0]!.toString()]));

    await waitFor(() => nodes.every(node => node.cluster.upMembers().length === 3), 3_000);

    for (const node of nodes) {
      const ups = node.cluster.upMembers().map(m => m.address.toString()).sort();
      expect(ups).toEqual(addrs.map(nodeA => nodeA.toString()).sort());
    }

    for (const node of nodes) await stopNode(node);
    broker.close();
  });

  test('orphaned sends between unclustered nodes do not crash anything', async () => {
    const broker = new WorkerBroker();
    const addrA = new NodeAddress('wm-orphan', 'w', 1);
    const nodeA = await startNode('wm-orphan', addrA, broker);

    class NoopActor extends Actor<string> { override onReceive(_: string): void {} }
    const ref = nodeA.system.spawn(NoopActor, 'noop');
    ref.tell('hello');
    // An absence: the claim is that a tell to a purely local actor over a
    // broker-backed cluster raises nothing.  Survival is already true at t=0,
    // so only a window can disprove it.
    await sleep(30);
    // Survived without error.
    expect(nodeA.cluster.upMembers().length).toBe(1);

    await stopNode(nodeA);
    broker.close();
  });
});

describe('WorkerBroker — a forged `from` does not survive the hop (#774)', () => {
  /**
   * The unit half of this lives in `tests/unit/worker/WorkerBroker.test.ts`
   * against a `FakePort`; this is the end-to-end half, and it is not
   * redundant.  It runs the corrected frame through a real `MessageChannel`
   * — so the rewritten envelope has to survive **structured clone**, which a
   * fake port never exercises — and it asserts on the value
   * `MessageChannelTransport` hands its `WireHandler`, which is the exact
   * argument `Cluster.handleWire` receives as the peer identity.
   *
   * **Exploit walkthrough (pre-fix).**  The broker re-posted the envelope
   * verbatim, so the address in `from` was the sender's to choose: worker 1
   * naming worker 2 kept worker 2's failure-detector timer alive at worker 3
   * and had its envelopes attributed to worker 2.
   */
  test('the peer identity the transport reports is the sending port, not the payload', async () => {
    const broker = new WorkerBroker();
    const hostile = new NodeAddress('wm-forge', 'w', 1);
    const impersonated = new NodeAddress('wm-forge', 'w', 2);
    const victim = new NodeAddress('wm-forge', 'w', 3);

    const victimChannel = new MessageChannel();
    broker.register(victim, victimChannel.port1 as unknown as PortLike);
    const transport = new MessageChannelTransport(victim, victimChannel.port2 as unknown as PortLike);
    const reportedSenders: NodeAddress[] = [];
    transport.setHandler((from) => { reportedSenders.push(from); });
    await transport.start();

    // Nothing special about the attacker's wiring: it is an ordinary
    // registered peer holding an ordinary end of an ordinary channel.
    const hostileChannel = new MessageChannel();
    broker.register(hostile, hostileChannel.port1 as unknown as PortLike);
    const hostilePort = hostileChannel.port2 as unknown as PortLike;
    hostilePort.start?.();
    hostilePort.postMessage({
      from: impersonated.toJSON(),
      to: victim.toJSON(),
      payload: { kind: 'heartbeat', from: impersonated.toJSON(), seq: 1, ts: Date.now() },
    });

    await waitFor(() => reportedSenders.length === 1, 2_000, 5, 'the forged frame to arrive');
    expect(reportedSenders[0]!.toString()).toBe(hostile.toString());
    expect(transport.peers().map(p => p.toString())).not.toContain(impersonated.toString());

    await transport.shutdown();
    hostileChannel.port2.close();
    broker.close();
  });
});
