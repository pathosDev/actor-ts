/**
 * #936 — a ref marker in an envelope body made the receiving node dial an
 * address of the sender's choosing.
 *
 * `decodeSingleRef` built the marker's node with the raw `NodeAddress`
 * constructor, and `_sendEnvelope` handed whatever node a ref named to the
 * transport, which dials what it is given.  So an actor answering a decoded
 * `replyTo` — the idiom every handler uses — opened a connection to, say, a
 * cloud metadata endpoint and wrote a frame to it.  Remote death watch had the
 * same shape through `_sendWire`: watching a decoded ref sends a `watch` frame
 * to its node.
 *
 * The marker's address is validated now, and a frame leaves through those two
 * doors only for a member that is not a tombstone or a node the transport
 * already holds a connection to, acked or still handshaking.  The first block proves the dial no longer happens on
 * a real socket; the rest pin which destinations are still reachable.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { Actor } from '../../../src/Actor.js';
import { Nobody, type ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberData, WireMessage } from '../../../src/cluster/Protocol.js';
import { decodeRefs, type WireActorRef } from '../../../src/cluster/RefCodec.js';
import { RemoteActorRef } from '../../../src/cluster/RemoteActorRef.js';
import { InMemoryTransport, type Transport } from '../../../src/cluster/Transport.js';
import { OUTBOUND_REFUSAL_REPORT_INTERVAL_MS } from '../../../src/cluster/Constants.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/** What the actor under test is asked to do with the ref it is handed. */
type UseCommand = { readonly kind: 'reply' | 'watch'; readonly target: ActorRef<unknown> };

/** Does with a decoded ref what an ordinary handler does: replies to it, or watches it. */
class RefUser extends Actor<UseCommand> {
  override onReceive(command: UseCommand): void {
    if (command.kind === 'reply') command.target.tell('answer');
    else this.context.watch(command.target);
  }
}

/** The private surface these tests reach through — the wire entry, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: WireMessage): void;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

let nodes: NodeHandle[] = [];
let closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  for (const close of closers) await close();
  nodes = [];
  closers = [];
});

/** A cluster node with every background timer pushed far out — its own leader unless `seeds` names one. */
async function startNode(
  systemName: string,
  host: string,
  port: number,
  transport?: Transport,
  seeds: readonly NodeAddress[] = [],
): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, host, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withFailureDetector({ heartbeatIntervalMs: 60_000, unreachableAfterMs: 120_000, downAfterMs: 240_000 })
    .withGossipIntervalMs(60_000);
  if (transport !== undefined) clusterOptions.withTransport(transport);
  if (seeds.length > 0) clusterOptions.withSeeds(seeds.map((seed) => seed.toString()));
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, address };
  nodes.push(node);
  return node;
}

/** A ref marker as a peer would embed it in a message body. */
function marker(target: { readonly system: string; readonly host: string; readonly port: number }): WireActorRef {
  return { $ref: 'actor', path: '/user/anyone', host: target.host, port: target.port, system: target.system };
}

/** Deliver an envelope to the node's `user` actor, as `from` would put it on the wire. */
function deliverUse(node: NodeHandle, from: NodeAddress, kind: UseCommand['kind'], target: WireActorRef): void {
  internals(node.cluster).handleWire(from, {
    kind: 'envelope',
    to: `actor-ts://${node.system.name}/user/user`,
    from: null,
    body: { kind, target },
  });
}

/** Every destination the node handed its transport, recorded beside the real send. */
function recordDestinations(transport: Transport): string[] {
  const destinations: string[] = [];
  const send = transport.send.bind(transport);
  transport.send = (to: NodeAddress, message: WireMessage): void => {
    destinations.push(`${message.kind} → ${to.toString()}`);
    send(to, message);
  };
  return destinations;
}

/** A plain TCP listener that only counts the connections it is offered. */
async function countingListener(): Promise<{ readonly port: number; readonly connections: () => number }> {
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('listener has no port');
  return { port: address.port, connections: () => connections };
}

describe('a ref in a message body does not make the node dial its address (#936)', () => {
  for (const kind of ['reply', 'watch'] as const) {
    test(`${kind}: no connection reaches a non-member the ref names`, async () => {
      const listener = await countingListener();
      const node = await startNode(`wire-ref-dial-${kind}`, '127.0.0.1', kind === 'reply' ? 47_361 : 47_362);
      node.system.spawn(RefUser, 'user');
      const stranger = new NodeAddress('s', '10.0.93.6', 2552);

      deliverUse(node, stranger, kind, marker({ system: 's', host: '127.0.0.1', port: listener.port }));

      // The elapsed time IS the assertion: the dial would be a connection to a
      // listener on loopback, which lands in well under this window; nothing
      // arriving within it is the property under test.
      await sleep(300);
      expect(listener.connections()).toBe(0);
    });
  }
});

describe('which destinations a decoded ref can still reach (#936)', () => {
  test('a member is reached', async () => {
    const transport = new InMemoryTransport(new NodeAddress('wire-ref-member', 'h', 47_371));
    const sent = recordDestinations(transport);
    const node = await startNode('wire-ref-member', 'h', 47_371, transport);
    node.system.spawn(RefUser, 'user');
    const member = new NodeAddress('wire-ref-member', 'h', 47_372);
    const record: MemberData = { address: member.toJSON(), status: 'up', version: Date.now(), roles: [] };
    internals(node.cluster).handleWire(member, { kind: 'gossip', from: member.toJSON(), sequence: Date.now(), members: [record] });

    deliverUse(node, member, 'reply', marker({ system: member.systemName, host: member.host, port: member.port }));

    await awaitCondition(() => sent.includes(`envelope → ${member.toString()}`), {
      label: 'the reply left for the member', timeoutMs: 2_000,
    });
  });

  test('a tombstone is not', async () => {
    const transport = new InMemoryTransport(new NodeAddress('wire-ref-tombstone', 'h', 47_381));
    const sent = recordDestinations(transport);
    const node = await startNode('wire-ref-tombstone', 'h', 47_381, transport);
    node.system.spawn(RefUser, 'user');
    const departed = new NodeAddress('wire-ref-tombstone', 'h', 47_382);
    const record: MemberData = { address: departed.toJSON(), status: 'up', version: Date.now(), roles: [] };
    internals(node.cluster).handleWire(departed, { kind: 'gossip', from: departed.toJSON(), sequence: Date.now(), members: [record] });
    expect(node.cluster.down(departed)).toBe(true);
    const sender = new NodeAddress('wire-ref-tombstone', 'h', 47_383);

    deliverUse(node, sender, 'reply', marker({ system: departed.systemName, host: departed.host, port: departed.port }));

    // The elapsed time IS the assertion: the reply is a `tell` from an actor's
    // mailbox, so it would have reached the transport within this window.
    await sleep(100);
    expect(sent.filter((line) => line.endsWith(departed.toString()))).toEqual([]);
  });

  test('a peer the transport is connected to is reached, member or not', async () => {
    // During a join a member can learn of this node before this node learns of
    // it, so a reply to it travels over a connection to a node this one has
    // not admitted.  Sending over a connection dials nothing.
    const transport = new InMemoryTransport(new NodeAddress('wire-ref-connected', 'h', 47_391));
    const sent = recordDestinations(transport);
    const node = await startNode('wire-ref-connected', 'h', 47_391, transport);
    node.system.spawn(RefUser, 'user');
    const peer = new NodeAddress('wire-ref-connected', 'h', 47_392);
    const peerTransport = new InMemoryTransport(peer);
    await peerTransport.start();
    closers.push(() => peerTransport.shutdown());
    expect(transport.peers().some((connected) => connected.equals(peer))).toBe(true);

    deliverUse(node, peer, 'reply', marker({ system: peer.systemName, host: peer.host, port: peer.port }));

    await awaitCondition(() => sent.includes(`envelope → ${peer.toString()}`), {
      label: 'the reply left for the connected peer', timeoutMs: 2_000,
    });
  });

  test('a seed is reached straight after join, while its connection is still handshaking', async () => {
    // `Cluster.join` resolves before the seed is a member here and before the
    // connection the join opened has seen its `hello-ack`; `TcpTransport`
    // queues a frame on that connection and flushes it on the ack.  A gate
    // that asked `peers()` — acked connections only — dropped this `tell`.
    const seed = await startNode('wire-ref-handshake', '127.0.0.1', 47_431);
    const received: unknown[] = [];
    class Receiver extends Actor<unknown> {
      override onReceive(message: unknown): void { received.push(message); }
    }
    seed.system.spawn(Receiver, 'receiver');
    const joiner = await startNode('wire-ref-handshake', '127.0.0.1', 47_432, undefined, [seed.address]);

    new RemoteActorRef(seed.address, '/user/receiver', joiner.cluster).tell('right after join');

    await awaitCondition(() => received.includes('right after join'), {
      label: 'the seed received the tell', timeoutMs: 3_000,
    });
  });

  test('a stranger is not', async () => {
    const transport = new InMemoryTransport(new NodeAddress('wire-ref-stranger', 'h', 47_401));
    const sent = recordDestinations(transport);
    const node = await startNode('wire-ref-stranger', 'h', 47_401, transport);
    node.system.spawn(RefUser, 'user');
    const sender = new NodeAddress('wire-ref-stranger', 'h', 47_402);

    deliverUse(node, sender, 'reply', marker({ system: 's', host: '169.254.169.254', port: 80 }));
    deliverUse(node, sender, 'watch', marker({ system: 's', host: '169.254.169.254', port: 81 }));

    // The elapsed time IS the assertion: both would have reached the transport
    // from the actor's mailbox within this window.
    await sleep(100);
    expect(sent.filter((line) => line.includes('169.254.169.254'))).toEqual([]);
  });
});

describe('a marker is validated as a node address (#936)', () => {
  test('a marker that names no valid node decodes to Nobody', async () => {
    const node = await startNode('wire-ref-validate', 'h', 47_411, new InMemoryTransport(new NodeAddress('wire-ref-validate', 'h', 47_411)));
    const invalid: ReadonlyArray<Record<string, unknown>> = [
      { $ref: 'actor', path: '/user/x', host: 'h', port: 0, system: 's' },
      { $ref: 'actor', path: '/user/x', host: 'h', port: -1, system: 's' },
      { $ref: 'actor', path: '/user/x', host: 'h', port: 1.5, system: 's' },
      { $ref: 'actor', path: '/user/x', host: 'h', port: '80', system: 's' },
      { $ref: 'actor', path: '/user/x', host: '', port: 80, system: 's' },
      { $ref: 'actor', path: '/user/x', host: 7, port: 80, system: 's' },
      { $ref: 'actor', path: '/user/x', host: 'h', port: 80, system: '' },
      { $ref: 'actor', path: '/user/x', host: 'h', port: 80 },
    ];
    for (const wire of invalid) expect(decodeRefs(wire, node.cluster)).toBe(Nobody);
  });

  test('a valid marker for another node still decodes to a remote ref', async () => {
    const node = await startNode('wire-ref-valid', 'h', 47_421, new InMemoryTransport(new NodeAddress('wire-ref-valid', 'h', 47_421)));
    const decoded = decodeRefs(marker({ system: 's', host: 'elsewhere', port: 2552 }), node.cluster);
    expect(decoded).toBeInstanceOf(RemoteActorRef);
  });
});

describe('how a refusal is reported (#936)', () => {
  test('under a ManualScheduler the first refusal logs and the rest fold until the clock advances', async () => {
    const scheduler = new ManualScheduler();
    const logger = new RecordingLogger();
    const address = new NodeAddress('wire-ref-clock', 'h', 47_441);
    const systemOptions = ActorSystemOptions.create()
      .withLogger(logger)
      .withLogLevel(LogLevel.Debug)
      .withScheduler(scheduler);
    const system = ActorSystem.create('wire-ref-clock', systemOptions);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(47_441)
      .withTransport(new InMemoryTransport(address));
    const cluster = await Cluster.join(system, clusterOptions);
    nodes.push({ system, cluster, address });
    const stranger = new RemoteActorRef(new NodeAddress('s', '169.254.169.254', 80), '/user/x', cluster);
    const refusals = (): string[] => logger.records
      .filter((record) => record.level === 'warn' && record.message.includes('refused to send'))
      .map((record) => record.message);

    stranger.tell('first');
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toContain('refused to send 1 frame(s)');

    stranger.tell('second');
    stranger.tell('third');
    scheduler.advance(OUTBOUND_REFUSAL_REPORT_INTERVAL_MS - 1);
    stranger.tell('fourth');
    expect(refusals()).toHaveLength(1);

    scheduler.advance(1);
    stranger.tell('fifth');
    expect(refusals()).toHaveLength(2);
    expect(refusals()[1]).toContain('refused to send 4 frame(s)');
  });

  test('the line names the host and port however long the system name, escaped', async () => {
    const logger = new RecordingLogger();
    const address = new NodeAddress('wire-ref-render', 'h', 47_451);
    const systemOptions = ActorSystemOptions.create()
      .withLogger(logger)
      .withLogLevel(LogLevel.Debug);
    const system = ActorSystem.create('wire-ref-render', systemOptions);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(47_451)
      .withTransport(new InMemoryTransport(address));
    const cluster = await Cluster.join(system, clusterOptions);
    nodes.push({ system, cluster, address });
    // A system name is the marker author's free choice: long enough to push the
    // host off a single clipped string, with a forged record and an `@` that
    // would make the line name a different host.
    const systemName = `${'s'.repeat(300)}@10.9.9.9:22\r\nWARN forged`;
    new RemoteActorRef(new NodeAddress(systemName, '169.254.169.254', 80), '/user/x', cluster).tell('m');

    const line = logger.records.find((record) => record.message.includes('refused to send'))?.message ?? '';
    expect(line).toContain('@169.254.169.254:80');
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).not.toContain('@10.9.9.9');
    expect(line.length).toBeLessThan(1_000);
  });
});
