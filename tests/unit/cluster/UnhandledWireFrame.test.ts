/**
 * The cluster's share of #1178: the three drop sites a peer can reach.
 *
 * `Cluster.onUnhandledWire` is the one the issue calls the frightening one.
 * Every frame kind the core match has no arm for lands there — each
 * extension's kinds arrive and are dispatched from the handler registry — and
 * when nothing is registered the method used to `return` without so much as a
 * log line.  A peer speaking a protocol this build has never heard of was
 * therefore indistinguishable from a healthy cluster with nothing to say,
 * which is exactly the shape a rolling upgrade produces.
 *
 * It is also the awkward one.  `Cluster` is a plain class, not an `Actor`, so
 * `this.unhandled(...)` does not exist there — and `DeadLetter.recipient` is
 * non-nullable, so a frame nobody claimed has no addressee to name.  The half
 * that does apply is the counter, and these cases pin that split: the counter
 * moves with every frame, no dead letter is produced, and the log line is one
 * per kind rather than one per frame.
 *
 * The mediator and the singleton manager are ordinary actors and take the
 * ordinary route; they are here because reaching either needs a cluster.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import {
  MAX_LOGGED_WIRE_KIND_LENGTH,
  MAX_REPORTED_UNCLAIMED_WIRE_KINDS,
} from '../../../src/cluster/Constants.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { DistributedPubSubId } from '../../../src/cluster/pubsub/index.js';
import { StartSingletonOptions } from '../../../src/cluster/singleton/index.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import type { MetricsRegistry } from '../../../src/metrics/Metrics.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import type { TestProbe } from '../../../src/testkit/TestProbe.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

type Node = {
  readonly kit: TestKit;
  readonly cluster: Cluster;
  readonly log: RecordingLogger;
  readonly registry: MetricsRegistry;
  readonly probe: TestProbe;
};

const nodes: Node[] = [];
const peers: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(peers.splice(0).map((t) => t.shutdown().catch(() => {})));
  for (const node of nodes.splice(0)) {
    await node.cluster.leave().catch(() => {});
    await node.kit.system.terminate().catch(() => {});
  }
});

const address = (name: string, port: number): NodeAddress => new NodeAddress(name, 'h', port);

async function startNode(name: string, port: number): Promise<Node> {
  const log = new RecordingLogger();
  const kit = TestKit.create(name, TestKitOptions.create().withLogger(log));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(address(name, port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  const registry = kit.system.extension(MetricsExtensionId).enable();
  const probe = kit.createTestProbe();
  kit.system.eventStream.subscribe(probe, DeadLetter);
  const node: Node = { kit, cluster, log, registry, probe };
  nodes.push(node);
  return node;
}

/** A bare transport that speaks the wire under its own identity. */
async function bystanderPeer(name: string, port: number): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport(address(name, port));
  transport.setHandler(() => {});
  await transport.start();
  peers.push(transport);
  return transport;
}

function countFor(registry: MetricsRegistry, className: string): number {
  return registry.collect()
    .filter((s) => s.name === 'actor_unhandled_total' && s.labels['class'] === className)
    .reduce((total, sample) => total + sample.value, 0);
}

const warningsMentioning = (node: Node, needle: string): string[] =>
  node.log.records.filter((r) => r.level === 'warn' && r.message.includes(needle))
    .map((r) => r.message);

describe('Cluster — a wire frame no handler claimed (#1178)', () => {
  test('every frame is counted, and the kind is named once', async () => {
    const receiver = await startNode('wire-unclaimed', 53_901);
    const sender = await bystanderPeer('wire-unclaimed-peer', 53_902);
    const to = address('wire-unclaimed', 53_901);

    // Unknown kinds pass `validateWireFrame` on purpose — its `default` arm is
    // what lets an extension define frames the core knows nothing about — so
    // this really does reach `handleWire` and fall through the match.
    for (let i = 0; i < 3; i += 1) {
      sender.send(to, { kind: 'from-the-future' } as never);
    }

    await awaitCondition(() => countFor(receiver.registry, 'Cluster') === 3, {
      timeoutMs: 4_000,
      label: 'all three unclaimed frames were counted',
    });
    // One line for three frames: a drift storm arrives at message rate, and
    // the counter is what carries the rate.
    expect(warningsMentioning(receiver, "'from-the-future'")).toHaveLength(1);
    // No dead letter: there is no recipient ref to name for a frame nobody
    // claimed, and `DeadLetter.recipient` is not weakened to fit.
    await receiver.probe.expectNoMessage(200);
  });

  test('a second unknown kind gets its own line', async () => {
    const receiver = await startNode('wire-two-kinds', 53_911);
    const sender = await bystanderPeer('wire-two-kinds-peer', 53_912);
    const to = address('wire-two-kinds', 53_911);

    sender.send(to, { kind: 'kind-a' } as never);
    sender.send(to, { kind: 'kind-b' } as never);

    await awaitCondition(() => countFor(receiver.registry, 'Cluster') === 2, {
      timeoutMs: 4_000,
      label: 'both unclaimed kinds were counted',
    });
    expect(warningsMentioning(receiver, "'kind-a'")).toHaveLength(1);
    expect(warningsMentioning(receiver, "'kind-b'")).toHaveLength(1);
  });

  test('the remembered set is capped, because the kind comes off the wire', async () => {
    const receiver = await startNode('wire-cap', 53_921);
    const sender = await bystanderPeer('wire-cap-peer', 53_922);
    const to = address('wire-cap', 53_921);

    // A peer inventing a fresh kind per frame is the memory-growth shape the
    // cap exists for.  Twice the cap in, at most the cap named.
    const sent = MAX_REPORTED_UNCLAIMED_WIRE_KINDS * 2;
    for (let i = 0; i < sent; i += 1) sender.send(to, { kind: `invented-${i}` } as never);

    await awaitCondition(() => countFor(receiver.registry, 'Cluster') === sent, {
      timeoutMs: 4_000,
      label: 'every invented frame was counted',
    });
    // The counter is deliberately not capped with the log — suppressing the
    // rate signal is #1179's business, not this one's.
    expect(countFor(receiver.registry, 'Cluster')).toBe(sent);
    expect(warningsMentioning(receiver, 'no handler for wire frame'))
      .toHaveLength(MAX_REPORTED_UNCLAIMED_WIRE_KINDS);
    // And the last line it does emit says it is the last one.
    expect(warningsMentioning(receiver, 'further ones are counted but not named'))
      .toHaveLength(1);
  });

  test('the kind is escaped and clipped before it is logged or remembered', async () => {
    // `isWireFrame` enforces only "a string", so the kind reaching the log is
    // arbitrary sender-controlled text.  A CR/LF in it would forge as many
    // additional records as the sender likes — the same forgery
    // `sanitizeWireLogContext` closes one field to the left (#573) — and an
    // unbounded length would let one frame write an unbounded line.
    const receiver = await startNode('wire-forgery', 53_961);
    const sender = await bystanderPeer('wire-forgery-peer', 53_962);
    const to = address('wire-forgery', 53_961);

    const forged = 'benign\n2026-01-01 INFO  cluster - node joined';
    const overlong = 'x'.repeat(MAX_LOGGED_WIRE_KIND_LENGTH + 40);
    sender.send(to, { kind: forged } as never);
    sender.send(to, { kind: overlong } as never);

    await awaitCondition(() => countFor(receiver.registry, 'Cluster') === 2, {
      timeoutMs: 4_000,
      label: 'both hostile frames were counted',
    });
    const lines = warningsMentioning(receiver, 'no handler for wire frame');
    expect(lines).toHaveLength(2);
    // One record per frame, still — the newline travelled as an escape.
    expect(lines.some((line) => line.includes('\n'))).toBe(false);
    expect(lines.some((line) => line.includes('benign\\u000a'))).toBe(true);
    // And the long one is clipped rather than printed whole.
    expect(lines.some((line) => line.includes(`${'x'.repeat(MAX_LOGGED_WIRE_KIND_LENGTH)}…'`)))
      .toBe(true);
    expect(lines.some((line) => line.includes('x'.repeat(MAX_LOGGED_WIRE_KIND_LENGTH + 1))))
      .toBe(false);
  });

  test('a registered handler still runs, and is neither counted nor warned about', async () => {
    // The half that must not change: an extension's frames arrive here too,
    // and they are handled rather than declined.
    const receiver = await startNode('wire-registered', 53_931);
    const sender = await bystanderPeer('wire-registered-peer', 53_932);
    const to = address('wire-registered', 53_931);

    const seen: string[] = [];
    receiver.cluster._onWire('an-extensions-frame', (message) => { seen.push(message.kind); });
    sender.send(to, { kind: 'an-extensions-frame' } as never);

    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the registered handler received its frame',
    });
    expect(countFor(receiver.registry, 'Cluster')).toBe(0);
    expect(warningsMentioning(receiver, 'no handler for wire frame')).toHaveLength(0);
  });
});

describe('cluster actors that used to drop in silence (#1178)', () => {
  test('the pub-sub mediator keeps its dead letter and gains the counter', async () => {
    // This handler already dead-lettered by hand (#155) — it was the prototype
    // for `Actor.unhandled`.  Converting it must not change the letter, and
    // must add the count, which matters most here: version skew produces these
    // at message rate and the dead-letter store is `off` by default.
    const node = await startNode('pubsub-unhandled', 53_941);
    const mediator = node.kit.system.extension(DistributedPubSubId).start(node.cluster);
    node.probe.clearInbox();

    mediator.tell({ kind: 'pubsub-from-the-future' } as never);

    const letter = await node.probe.receiveOne(1_000) as DeadLetter;
    expect(letter.message).toEqual({ kind: 'pubsub-from-the-future' });
    expect(letter.recipient.path.toString()).toBe(mediator.path.toString());
    expect(warningsMentioning(node, 'pubsub-from-the-future')).toHaveLength(1);
    expect(countFor(node.registry, 'DistributedPubSubMediator')).toBe(1);
  });

  test('the singleton manager keeps its warn and now dead-letters the message too', async () => {
    const node = await startNode('singleton-unhandled', 53_951);
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withActor(Echo);
    node.cluster.singleton.start(singletonOptions);
    const manager = node.cluster.singleton.managerFor('echo').toNullable() as ActorRef;
    expect(manager).not.toBeNull();
    node.probe.clearInbox();

    manager.tell({ kind: 'singleton.FromTheFuture' } as never);

    const letter = await node.probe.receiveOne(1_000) as DeadLetter;
    expect(letter.message).toEqual({ kind: 'singleton.FromTheFuture' });
    expect(letter.recipient.path.toString()).toBe(manager.path.toString());
    expect(warningsMentioning(node, 'singleton manager: dropping')).toHaveLength(1);
    expect(countFor(node.registry, 'ClusterSingletonManager')).toBe(1);
  });
});

class Echo extends Actor<string> {
  override onReceive(_message: string): void { /* the singleton needs a body, not a behaviour */ }
}
