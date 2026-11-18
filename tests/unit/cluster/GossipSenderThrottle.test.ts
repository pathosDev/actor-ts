/**
 * #1105 — a per-sender budget on gossip frames.
 *
 * The member-map caps (#138) bound what sticks, not the work a frame costs:
 * every record in a frame of up to `maxFrameBytes` runs through
 * `Member.fromData`, `maySpeakFor`, the version cap and the cap accounting,
 * even when each one is refused in the end.  `gossipFramesPerSecondPerSender`
 * bounds how often one connection may hand this node that work.  A frame over
 * the budget is discarded whole, before any record is decoded; the connection
 * stays, as it does for the caps.
 *
 * Pinned here: a sender above the budget is cut to it and a sender below it
 * passes unchanged, the budget refills with time, senders do not share a
 * budget, normal gossip at a reasonable budget never touches it, a budget of
 * 50 frames a second is on by default, and `0` turns it off.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions, ClusterOptionsValidator } from '../../../src/cluster/ClusterOptions.js';
import { GOSSIP_SENDER_BUDGET_SWEEP_THRESHOLD } from '../../../src/cluster/Constants.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

interface ClusterInternals {
  handleWire(from: NodeAddress, message: WireMessage): void;
  readonly members: Map<string, Member>;
  readonly refusalCounts: Record<string, number>;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

let nodes: NodeHandle[] = [];

afterEach(async () => {
  setSystemTime();
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

type StartOptions = {
  readonly budget?: number;
  readonly seeds?: string[];
  readonly gossipIntervalMs?: number;
  readonly logger?: RecordingLogger;
};

async function startNode(systemName: string, port: number, options: StartOptions = {}): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, 'h', port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(options.logger ?? new NoopLogger())
    .withLogLevel(options.logger === undefined ? LogLevel.Off : LogLevel.Warn);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(options.seeds ?? [])
    .withTransport(new InMemoryTransport(address))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 2_000, downAfterMs: 4_000 })
    .withGossipIntervalMs(options.gossipIntervalMs ?? 60_000);
  if (options.budget !== undefined) clusterOptions.withGossipFramesPerSecondPerSender(options.budget);
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, address };
  nodes.push(node);
  return node;
}

/**
 * `count` frames from `sender`, back to back, each announcing the sender
 * itself one version higher than the last.  A self-announcement needs no
 * standing, so every frame that is not throttled moves the sender's record:
 * its final version says how many got through.
 */
function burst(node: NodeHandle, sender: NodeAddress, count: number, firstVersion: number): void {
  const sequenceBase = Date.now();
  for (let index = 0; index < count; index += 1) {
    internals(node.cluster).handleWire(sender, {
      kind: 'gossip',
      from: sender.toJSON(),
      sequence: sequenceBase + index,
      members: [{ address: sender.toJSON(), status: 'up', version: firstVersion + index, roles: [] }],
    });
  }
}

function framesAdmitted(node: NodeHandle, sender: NodeAddress, firstVersion: number): number {
  const record = internals(node.cluster).members.get(sender.toString());
  return record === undefined ? 0 : record.version - firstVersion + 1;
}

describe('#1105 — gossip frames are budgeted per sender', () => {
  test('a sender above the budget is cut to it; the rest of the burst is discarded and counted', async () => {
    const node = await startNode('gossip-throttle-over', 9_851, { budget: 3 });
    const sender = new NodeAddress('gossip-throttle-over', '10.0.105.1', 9_901);
    const firstVersion = Date.now() - 1_000;
    burst(node, sender, 10, firstVersion);
    expect(framesAdmitted(node, sender, firstVersion)).toBe(3);
    expect(internals(node.cluster).refusalCounts['rate-limit']).toBe(7);
  });

  test('a sender below the budget passes unchanged', async () => {
    const node = await startNode('gossip-throttle-under', 9_852, { budget: 5 });
    const sender = new NodeAddress('gossip-throttle-under', '10.0.105.1', 9_901);
    const firstVersion = Date.now() - 1_000;
    burst(node, sender, 5, firstVersion);
    expect(framesAdmitted(node, sender, firstVersion)).toBe(5);
    expect(internals(node.cluster).refusalCounts['rate-limit']).toBe(0);
  });

  test('the budget refills with time', async () => {
    const node = await startNode('gossip-throttle-refill', 9_853, { budget: 2 });
    const sender = new NodeAddress('gossip-throttle-refill', '10.0.105.1', 9_901);
    const firstVersion = Date.now() - 10_000;
    burst(node, sender, 4, firstVersion);
    expect(framesAdmitted(node, sender, firstVersion)).toBe(2);

    // Half a second at two frames per second earns one frame back, not two.
    setSystemTime(new Date(Date.now() + 500));
    burst(node, sender, 2, firstVersion + 2);
    expect(framesAdmitted(node, sender, firstVersion)).toBe(3);
  });

  test('a long-idle sender bursts to exactly one second\'s worth, and no further', async () => {
    const node = await startNode('gossip-throttle-burst-cap', 9_861, { budget: 5 });
    const sender = new NodeAddress('gossip-throttle-burst-cap', '10.0.105.1', 9_901);
    const firstVersion = Date.now() - 60_000;
    const start = Date.now();
    setSystemTime(new Date(start));
    burst(node, sender, 5, firstVersion);
    expect(framesAdmitted(node, sender, firstVersion)).toBe(5);

    // Ten idle seconds would earn fifty frames; the bucket holds five.
    setSystemTime(new Date(start + 10_000));
    burst(node, sender, 6, firstVersion + 5);
    expect(framesAdmitted(node, sender, firstVersion)).toBe(10);
    expect(internals(node.cluster).refusalCounts['rate-limit']).toBe(1);
  });

  test('a clock stepped backwards earns nothing, and leaves no debt behind', async () => {
    const node = await startNode('gossip-throttle-clock-step', 9_860, { budget: 2 });
    const sender = new NodeAddress('gossip-throttle-clock-step', '10.0.105.1', 9_901);
    const firstVersion = Date.now() - 60_000;
    const start = Date.now();
    setSystemTime(new Date(start));
    burst(node, sender, 2, firstVersion);
    expect(framesAdmitted(node, sender, firstVersion)).toBe(2);

    // Ten seconds back: no frame earned.  Sequences stay fresh — the frame
    // budget is checked before the replay guard.
    setSystemTime(new Date(start - 10_000));
    burst(node, sender, 1, firstVersion + 2);
    expect(framesAdmitted(node, sender, firstVersion)).toBe(2);

    // One second on from there refills the budget in full, as for any sender.
    setSystemTime(new Date(start - 9_000));
    expect(internals(node.cluster).refusalCounts['rate-limit']).toBe(1);
    internals(node.cluster).handleWire(sender, {
      kind: 'gossip',
      from: sender.toJSON(),
      sequence: start + 1_000,
      members: [{ address: sender.toJSON(), status: 'up', version: firstVersion + 2, roles: [] }],
    });
    expect(internals(node.cluster).refusalCounts['rate-limit']).toBe(1);
  });

  test('an episode logs one WARN as it starts and one with the totals as it ends, not one per frame', async () => {
    const logger = new RecordingLogger();
    const node = await startNode('gossip-throttle-episode', 9_858, { budget: 3, logger });
    const sender = new NodeAddress('gossip-throttle-episode', '10.0.105.1', 9_901);
    const firstVersion = Date.now() - 10_000;
    const throttleWarnings = (): string[] => logger.records
      .filter((record) => record.level === 'warn' && record.message.includes('gossipFramesPerSecondPerSender'))
      .map((record) => record.message);

    burst(node, sender, 10, firstVersion);
    expect(throttleWarnings()).toHaveLength(1);
    expect(throttleWarnings()[0]).toContain('discarding');

    setSystemTime(new Date(Date.now() + 1_000));
    burst(node, sender, 1, firstVersion + 3);
    expect(throttleWarnings()).toHaveLength(2);
    expect(throttleWarnings()[1]).toContain('7 frame(s) carrying 7 member record(s)');
  });

  test('budgets of senders idle for a second are swept once the table is large', async () => {
    const node = await startNode('gossip-throttle-sweep', 9_859, { budget: 1 });
    const budgets = (): number =>
      (node.cluster as unknown as { readonly gossipSenderBudgets: Map<string, unknown> }).gossipSenderBudgets.size;
    const firstVersion = Date.now() - 1_000;
    // Frozen, so "a second later" is exactly one second: the boundary is part
    // of what is pinned.
    setSystemTime(new Date(Date.now()));
    for (let index = 0; index < GOSSIP_SENDER_BUDGET_SWEEP_THRESHOLD; index += 1) {
      burst(node, new NodeAddress('gossip-throttle-sweep', '10.0.106.1', 10_000 + index), 1, firstVersion);
    }
    expect(budgets()).toBe(GOSSIP_SENDER_BUDGET_SWEEP_THRESHOLD);

    setSystemTime(new Date(Date.now() + 1_000));
    burst(node, new NodeAddress('gossip-throttle-sweep', '10.0.106.2', 9_999), 1, firstVersion);
    expect(budgets()).toBe(1);
  });

  test('senders do not share a budget', async () => {
    const node = await startNode('gossip-throttle-senders', 9_854, { budget: 2 });
    const loud = new NodeAddress('gossip-throttle-senders', '10.0.105.1', 9_901);
    const quiet = new NodeAddress('gossip-throttle-senders', '10.0.105.2', 9_902);
    const firstVersion = Date.now() - 1_000;
    burst(node, loud, 10, firstVersion);
    burst(node, quiet, 2, firstVersion);
    expect(framesAdmitted(node, loud, firstVersion)).toBe(2);
    expect(framesAdmitted(node, quiet, firstVersion)).toBe(2);
  });

  test('0 turns the budget off', async () => {
    const node = await startNode('gossip-throttle-off', 9_855, { budget: 0 });
    const sender = new NodeAddress('gossip-throttle-off', '10.0.105.1', 9_901);
    const firstVersion = Date.now() - 1_000;
    burst(node, sender, 120, firstVersion);
    expect(framesAdmitted(node, sender, firstVersion)).toBe(120);
    expect(internals(node.cluster).refusalCounts['rate-limit']).toBe(0);
  });

  test('a default-configured node holds a sender to 50 frames a second', async () => {
    // The maintainer's default (#1105): on, at a rate far above any normal
    // gossip interval.  No budget is set here, so this is the shipped number.
    const node = await startNode('gossip-throttle-default', 9_862);
    const loud = new NodeAddress('gossip-throttle-default', '10.0.105.1', 9_901);
    const quiet = new NodeAddress('gossip-throttle-default', '10.0.105.2', 9_902);
    const firstVersion = Date.now() - 60_000;
    const start = Date.now();
    setSystemTime(new Date(start));

    // Eighty frames in one instant: the first fifty pass, the rest do not.
    burst(node, loud, 80, firstVersion);
    expect(framesAdmitted(node, loud, firstVersion)).toBe(50);
    expect(internals(node.cluster).refusalCounts['rate-limit']).toBe(30);

    // A sender at ten frames a second — ten times the shipped interval's
    // rate — for three seconds is never refused.
    for (let second = 0; second < 3; second += 1) {
      for (let frame = 0; frame < 10; frame += 1) {
        setSystemTime(new Date(start + second * 1_000 + frame * 100));
        burst(node, quiet, 1, firstVersion + second * 10 + frame);
      }
    }
    expect(framesAdmitted(node, quiet, firstVersion)).toBe(30);
    expect(internals(node.cluster).refusalCounts['rate-limit']).toBe(30);
  });

  test('normal gossip between two nodes never touches a budget set well above its rate', async () => {
    const systemName = 'gossip-throttle-normal';
    // 40 ms rounds: 25 frames a second at most from either side, against 100.
    const first = await startNode(systemName, 9_856, { budget: 100, gossipIntervalMs: 40 });
    const second = await startNode(systemName, 9_857, {
      budget: 100, gossipIntervalMs: 40, seeds: [first.address.toString()],
    });
    const upIn = (viewer: NodeHandle): number =>
      viewer.cluster.getMembers().filter((member) => member.status === 'up').length;
    await awaitCondition(() => upIn(first) === 2 && upIn(second) === 2, {
      timeoutMs: 4_000, label: 'both nodes up in both views',
    });
    expect(internals(first.cluster).refusalCounts['rate-limit']).toBe(0);
    expect(internals(second.cluster).refusalCounts['rate-limit']).toBe(0);
  });

  test('the budget must be a non-negative integer', () => {
    const validate = (budget: number): void =>
      new ClusterOptionsValidator().validate({ gossipFramesPerSecondPerSender: budget });
    expect(() => validate(0)).not.toThrow();
    expect(() => validate(20)).not.toThrow();
    expect(() => validate(-1)).toThrow(/gossipFramesPerSecondPerSender/);
    expect(() => validate(1.5)).toThrow(/gossipFramesPerSecondPerSender/);
  });
});
