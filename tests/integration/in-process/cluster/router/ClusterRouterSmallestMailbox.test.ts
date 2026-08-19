/**
 * The wire half of cluster `smallest-mailbox` routing (#69): a routee node
 * answering how deep its routee's mailbox is, and a router choosing on the
 * answer.
 *
 * Two real in-process nodes, because the whole point of the lane is that the
 * depth crosses a node boundary — the routee is an ordinary user actor that
 * knows nothing about being measured, and the framework agent on its node
 * answers for it.  The selection scan itself is unit-tested in
 * `tests/unit/cluster/ClusterRouterSmallestMailbox.test.ts`; what is here is
 * everything that needs a transport.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import {
  ClusterMailboxDepthAgent,
  ClusterRouter,
  ClusterRouterOptions,
} from '../../../../../src/cluster/router/index.js';
import { MailboxDepthProbe } from '../../../../../src/cluster/router/MailboxDepthProbe.js';
import type { MailboxDepthReportMessage } from '../../../../../src/cluster/router/MailboxDepthProtocol.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

const ROUTEE_PATH = '/user/worker';

type WorkMessage = { kind: 'work'; id: string };

type Node = {
  readonly sys: ActorSystem;
  readonly cluster: Cluster;
};

async function startNode(systemName: string, port: number, seeds: string[] = []): Promise<Node> {
  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create(systemName, sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(sys, clusterOptions);
  return { sys, cluster };
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave();
  await node.sys.terminate();
}

/** Both nodes Up on `node`'s view — routees are only built from up-members. */
function awaitMembers(node: Node, count: number, what: string): Promise<void> {
  return awaitCondition(() => node.cluster.upMembers().length === count, {
    timeoutMs: 4_000, label: `${what}: ${count} up-members`,
  });
}

/**
 * A sink for depth reports on the asking node.
 *
 * Reports are addressed to the *asking router's own actor path*, so a probe
 * driven from a test needs some actor to be that path.  The forwarding
 * indirection exists because the probe needs the sink's path at construction
 * and the sink needs the probe — one of the two has to be filled in after.
 */
let onReport: (report: MailboxDepthReportMessage) => void = () => {};

class ReportSink extends Actor<MailboxDepthReportMessage> {
  override onReceive(report: MailboxDepthReportMessage): void {
    onReport(report);
  }
}

describe('mailbox-depth agent — over the wire (#69)', () => {
  test('reports the routee\'s real queue depth to the asking node', async () => {
    const a = await startNode('depth-ask', 89_101);
    const b = await startNode('depth-ask', 89_102, ['depth-ask@h:89101']);
    let started = 0;
    let release = (): void => {};
    const parked = new Promise<void>((resolve) => { release = resolve; });
    // Parks on its first message and never finishes it, so everything told
    // afterwards stays queued and the depth is an exact number rather than a
    // race against the dispatcher.
    class ParkingWorker extends Actor<WorkMessage> {
      override async onReceive(): Promise<void> {
        started++;
        await parked;
      }
    }
    let probe: MailboxDepthProbe | null = null;
    try {
      const routee = b.sys.spawn(ParkingWorker, 'worker');
      const stopServing = ClusterMailboxDepthAgent.serve(b.cluster);
      await awaitMembers(a, 2, 'depth query');

      // One message in flight (the worker is parked on it), four queued.
      routee.tell({ kind: 'work', id: 'in-flight' });
      await awaitCondition(() => started === 1, {
        timeoutMs: 4_000, label: 'the routee parked on its first message',
      });
      for (let i = 0; i < 4; i++) routee.tell({ kind: 'work', id: `queued-${i}` });

      const sink = a.sys.spawn(ReportSink, 'depth-sink');
      probe = new MailboxDepthProbe(a.cluster, sink.path.toString(), ROUTEE_PATH, 0);
      onReport = (report) => probe?.record(report);
      probe.start(40, () => [b.cluster.selfAddress]);

      const addressB = b.cluster.selfAddress.toString();
      await awaitCondition(() => probe?._depthOf(addressB) === 4, {
        timeoutMs: 4_000,
        label: `node B reported its routee's depth (saw ${probe?._depthOf(addressB)})`,
      });

      stopServing();
    } finally {
      probe?.stop();
      onReport = () => {};
      release();
      await stopNode(a);
      await stopNode(b);
    }
  }, 10_000);

  test('a node with no routee at the path stays silent rather than reporting zero', async () => {
    // Reporting 0 would read as "idle, send me everything" and pull the whole
    // load onto a node with nothing to receive it.
    const a = await startNode('depth-silent', 89_103);
    const b = await startNode('depth-silent', 89_104, ['depth-silent@h:89103']);
    let probe: MailboxDepthProbe | null = null;
    try {
      const stopServing = ClusterMailboxDepthAgent.serve(b.cluster);
      await awaitMembers(a, 2, 'silent node');

      const sink = a.sys.spawn(ReportSink, 'depth-sink');
      let reports = 0;
      probe = new MailboxDepthProbe(a.cluster, sink.path.toString(), ROUTEE_PATH, 0);
      onReport = (report) => { reports++; probe?.record(report); };
      probe.start(20, () => [b.cluster.selfAddress]);

      // Several refresh rounds' worth of opportunity to answer.
      const addressB = b.cluster.selfAddress.toString();
      for (let round = 0; round < 5; round++) probe.refreshNow();
      await awaitCondition(() => a.cluster.upMembers().length === 2, {
        timeoutMs: 4_000, label: 'membership settled',
      });
      expect(reports).toBe(0);
      expect(probe._depthOf(addressB)).toBeNull();

      stopServing();
    } finally {
      probe?.stop();
      onReport = () => {};
      await stopNode(a);
      await stopNode(b);
    }
  }, 10_000);
});

describe('ClusterRouter — smallest-mailbox (#69)', () => {
  test('routes to the node that answers, not to the one that cannot', async () => {
    // Only node A hosts the routee.  Both nodes serve depths, so node B's
    // silence is "nothing at that path", not "nobody listening" — and a node
    // with no reading is skipped.  Round-robin would keep dealing node B its
    // turn and lose half the traffic, which the control case below shows.
    const a = await startNode('sm-route', 89_105);
    const b = await startNode('sm-route', 89_106, ['sm-route@h:89105']);
    const received: string[] = [];
    class Worker extends Actor<WorkMessage> {
      override onReceive(message: WorkMessage): void { received.push(message.id); }
    }
    let probe: MailboxDepthProbe | null = null;
    try {
      a.sys.spawn(Worker, 'worker');
      const stopServingB = ClusterMailboxDepthAgent.serve(b.cluster);
      await awaitMembers(a, 2, 'smallest-mailbox routing');

      const routerOptions = ClusterRouterOptions.create<WorkMessage>()
        .withCluster(a.cluster)
        .withRouterType('smallest-mailbox')
        .withRouteePath(ROUTEE_PATH)
        .withMailboxDepthRefreshMs(25)
        .withMailboxDepthStaleAfterMs(0);
      const router = a.sys.spawn(ClusterRouter.factory<WorkMessage>(routerOptions), 'sm-router');

      // Warm-up is observable rather than slept on: a side probe started
      // *after* the router asks the same agents over the same transport, so a
      // reading here means the router's own reply was enqueued ahead of it —
      // and ahead of every message this test sends next, since a mailbox is
      // FIFO.
      const sink = a.sys.spawn(ReportSink, 'depth-sink');
      probe = new MailboxDepthProbe(a.cluster, sink.path.toString(), ROUTEE_PATH, 0);
      onReport = (report) => probe?.record(report);
      probe.start(25, () => [a.cluster.selfAddress, b.cluster.selfAddress]);
      const addressA = a.cluster.selfAddress.toString();
      await awaitCondition(() => probe?._depthOf(addressA) !== null, {
        timeoutMs: 4_000, label: 'node A reported a depth',
      });
      expect(probe._depthOf(b.cluster.selfAddress.toString())).toBeNull();

      received.length = 0;
      for (let i = 0; i < 20; i++) router.tell({ kind: 'work', id: `w-${i}` });
      await awaitCondition(() => received.length === 20, {
        timeoutMs: 4_000, label: `all 20 messages reached node A (saw ${received.length})`,
      });

      stopServingB();
    } finally {
      probe?.stop();
      onReport = () => {};
      await stopNode(a);
      await stopNode(b);
    }
  }, 10_000);

  test('control: round-robin over the same topology loses the silent node\'s share', async () => {
    // Proves the assertion above is not vacuous — the strategy is what makes
    // the difference, not the topology.
    const a = await startNode('rr-control', 89_107);
    const b = await startNode('rr-control', 89_108, ['rr-control@h:89107']);
    const received: string[] = [];
    class Worker extends Actor<WorkMessage> {
      override onReceive(message: WorkMessage): void { received.push(message.id); }
    }
    try {
      a.sys.spawn(Worker, 'worker');
      await awaitMembers(a, 2, 'round-robin control');

      const routerOptions = ClusterRouterOptions.create<WorkMessage>()
        .withCluster(a.cluster)
        .withRouterType('round-robin')
        .withRouteePath(ROUTEE_PATH);
      const router = a.sys.spawn(ClusterRouter.factory<WorkMessage>(routerOptions), 'rr-router');

      for (let i = 0; i < 20; i++) router.tell({ kind: 'work', id: `w-${i}` });
      await awaitCondition(() => received.length === 10, {
        timeoutMs: 4_000, label: `round-robin delivered its half (saw ${received.length})`,
      });
      // Fixed wait on purpose: the claim is that the other ten never arrive,
      // and an absence has nothing to poll for.
      await sleep(80);
      expect(received.length).toBe(10);
    } finally {
      await stopNode(a);
      await stopNode(b);
    }
  }, 10_000);

  test('serves depths on its own node while it lives, and stops when it does', async () => {
    // The homogeneous deployment — a router on every node — needs no routee-side
    // setup at all because of this.  The registration is reference-counted, so
    // a second router on the node keeps it alive.
    const a = await startNode('sm-serve', 89_109);
    try {
      a.sys.spawn(class extends Actor<WorkMessage> {
        override onReceive(): void {}
      }, 'worker');
      await awaitMembers(a, 1, 'agent lifecycle');
      expect(ClusterMailboxDepthAgent._isServing(a.cluster)).toBe(false);

      const routerOptions = ClusterRouterOptions.create<WorkMessage>()
        .withCluster(a.cluster)
        .withRouterType('smallest-mailbox')
        .withRouteePath(ROUTEE_PATH);
      const first = a.sys.spawn(ClusterRouter.factory<WorkMessage>(routerOptions), 'sm-router-1');
      const second = a.sys.spawn(ClusterRouter.factory<WorkMessage>(routerOptions), 'sm-router-2');
      await awaitCondition(() => ClusterMailboxDepthAgent._isServing(a.cluster), {
        timeoutMs: 4_000, label: 'the router started serving depths',
      });

      first.stop();
      await awaitCondition(() => ClusterMailboxDepthAgent._isServing(a.cluster), {
        timeoutMs: 4_000, label: 'the second router still holds the agent',
      });
      expect(ClusterMailboxDepthAgent._isServing(a.cluster)).toBe(true);

      second.stop();
      await awaitCondition(() => !ClusterMailboxDepthAgent._isServing(a.cluster), {
        timeoutMs: 4_000, label: 'the last router released the agent',
      });
    } finally {
      await stopNode(a);
    }
  }, 10_000);
});
