import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { DowningProvider } from '../../../src/cluster/downing/index.js';
import type { FailureDetectorOptionsType } from '../../../src/cluster/FailureDetectorOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { CoordinatedShutdownId, Phases, type Reason } from '../../../src/CoordinatedShutdown.js';
import { LogLevel } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/**
 * `actor-ts.cluster.run-coordinated-shutdown-when-down` (#1456), from the two
 * sides the switch's own suite leaves open.
 *
 * The survivor: a node whose decision downs only its peers must keep running
 * with the switch on — the switch answers this node's own removal, and a
 * winner that stood down whenever it downed a loser would end the whole
 * cluster on any partition.  And the halt: a run the downing started that a
 * `recover = false` phase stops short of the terminator must neither surface
 * as an unhandled rejection, which ends a Node process with the task's stack,
 * nor leave the downed node's actors running beside the side that won — the
 * second writer the switch exists to stop.
 *
 * A stub provider throughout, as in the switch's own suite: what happens after
 * the decision must not depend on whether a real strategy arrives at one.
 * Two in-memory nodes; the peer goes silent by closing its transport.
 */

/** Fast enough to see the peer go unreachable inside a test; `down-after` stays out of reach. */
const DETECTOR: FailureDetectorOptionsType = { heartbeatIntervalMs: 40, unreachableAfterMs: 160, downAfterMs: 4_000 };

type Node = { readonly system: ActorSystem; readonly cluster: Cluster; readonly log: RecordingLogger };

async function startNode(
  systemName: string,
  port: number,
  options: {
    readonly seeds?: string[];
    readonly downing?: DowningProvider;
    readonly runCoordinatedShutdownWhenDown?: boolean;
    readonly config?: ConfigObject;
  } = {},
): Promise<Node> {
  const log = new RecordingLogger();
  let systemOptions = ActorSystemOptions.create()
    .withLogger(log)
    .withLogLevel(LogLevel.Info);
  if (options.config !== undefined) systemOptions = systemOptions.withConfig(options.config);
  const system = ActorSystem.create(systemName, systemOptions);
  // Auto-down off and a stability window shorter than one detector round, so
  // a peer stays unreachable until the stub decides, and the stub decides at
  // once (auto-down ships on since #1426).
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withFailureDetector(DETECTOR)
    .withFailureDetectorAutoDown(false)
    .withSplitBrainResolver({ stableAfterMs: 1 })
    .withGossipIntervalMs(80);
  if (options.seeds !== undefined) clusterOptions.withSeeds(options.seeds);
  if (options.downing !== undefined) clusterOptions.withDowning(options.downing);
  if (options.runCoordinatedShutdownWhenDown !== undefined) {
    clusterOptions.withRunCoordinatedShutdownWhenDown(options.runCoordinatedShutdownWhenDown);
  }
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, log };
}

/** `seed` with `seedOptions`, and a plain peer that joins through it; resolved once both see two `up` members. */
async function formPair(
  systemName: string,
  seedPort: number,
  seedOptions: Parameters<typeof startNode>[2],
): Promise<{ seed: Node; peer: Node }> {
  const seed = await startNode(systemName, seedPort, seedOptions);
  const peer = await startNode(systemName, seedPort + 1, { seeds: [`${systemName}@h:${seedPort}`] });
  await awaitCondition(
    () => seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2,
    { timeoutMs: 3_000, intervalMs: 25, label: 'both nodes saw a two-member cluster' },
  );
  return { seed, peer };
}

function selfStatusOf(node: Node): MemberStatus | undefined {
  return node.cluster.getMembers().find((member) => member.address.equals(node.cluster.selfAddress))?.status;
}

/** The reason of every pipeline run on `node`, as its first phase saw it. */
function recordRuns(node: Node): Reason[] {
  const reasons: Reason[] = [];
  node.system.extension(CoordinatedShutdownId).addTask(Phases.BeforeServiceUnbind, 'record-the-reason', (reason) => {
    reasons.push(reason);
  });
  return reasons;
}

describe('run-coordinated-shutdown-when-down, beyond the self-down (#1456)', () => {
  test('the survivor: a decision that downs only the peer leaves this node up, with no leave and no run', async () => {
    const downsTheUnreachable: DowningProvider = { decide: (view) => new Set(view.unreachable) };
    const { seed, peer } = await formPair('when-down-survivor', 64_411, {
      downing: downsTheUnreachable,
      runCoordinatedShutdownWhenDown: true,
    });
    const reasons = recordRuns(seed);
    const peerKey = peer.cluster.selfAddress.toString();

    await peer.cluster.transport.shutdown();
    // Gone from the view is the decision applied: it downs and tombstones the
    // peer in one step, and a self-down in the same step would already show.
    await awaitCondition(
      () => !seed.cluster.getMembers().some((member) => member.address.toString() === peerKey),
      { timeoutMs: 4_000, intervalMs: 20, label: 'the seed downed and removed the silent peer' },
    );

    expect(selfStatusOf(seed)).toBe('up');
    expect(reasons).toEqual([]);
    expect(seed.system.extension(CoordinatedShutdownId).isRunning).toBe(false);
    expect(seed.system.isTerminated).toBe(false);

    await seed.system.terminate();
    await peer.system.terminate();
  }, 15_000);

  test('a halted run: reported at error, never an unhandled rejection, and still ends in the teardown', async () => {
    const downsItself: DowningProvider = {
      decide: (view) => (view.unreachable.size > 0 ? new Set([view.self.toString()]) : new Set()),
    };
    const { seed, peer } = await formPair('when-down-halted', 64_421, {
      downing: downsItself,
      runCoordinatedShutdownWhenDown: true,
      config: { 'actor-ts': { 'coordinated-shutdown': { phases: { 'service-stop': { recover: false } } } } },
    });
    seed.system.extension(CoordinatedShutdownId).addTask(Phases.ServiceStop, 'close-the-broker', () => {
      throw new Error('the broker would not close');
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    try {
      await peer.cluster.transport.shutdown();
      await awaitCondition(() => seed.system.isTerminated, {
        timeoutMs: 4_000,
        intervalMs: 20,
        label: 'the downed node\'s halted run still ended in the teardown',
      });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(seed.log.records.some((record) => record.level === 'error' && record.message.includes('halted'))).toBe(true);

    await peer.system.terminate();
  }, 15_000);
});
