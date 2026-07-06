/**
 * Wiring tests for #61 — DowningProvider plugged into Cluster
 * failure-detection.  Covers:
 *
 *   1. Without `downing` configured: existing heartbeat-only behaviour
 *      stays unchanged (regression guard).
 *   2. Custom DowningProvider gets called on partition view changes,
 *      its decision is applied (members force-downed regardless of
 *      failure-detector elapsed-time state).
 *   3. Self-down — provider asking us to down ourselves triggers
 *      `cluster.leave()`.
 *   4. Throwing provider doesn't crash the cluster (error logged,
 *      no decision applied).
 *
 * The strategies themselves (KeepMajority etc.) are pure-function
 * tested elsewhere; this file exercises the wiring path only with
 * a hand-rolled deterministic stub provider.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { Cluster, ClusterOptions } from '../../../../../src/cluster/Cluster.js';
import { addrKey } from '../../../../../src/cluster/downing/index.js';
import type {
  ClusterPartitionView,
  DowningProvider,
} from '../../../../../src/cluster/downing/index.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs = 3_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(stepMs);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface Node {
  sys: ActorSystem;
  cluster: Cluster;
}

async function startNode(
  systemName: string, port: number, opts: {
    seeds?: string[];
    downing?: DowningProvider;
  } = {},
): Promise<Node> {
  const sys = ActorSystem.create(systemName, { logger: new NoopLogger(), logLevel: LogLevel.Off });
  let clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 4_000 })
    .withGossipIntervalMs(80);
  if (opts.seeds !== undefined) clusterOptions = clusterOptions.withSeeds(opts.seeds);
  if (opts.downing !== undefined) clusterOptions = clusterOptions.withDowning(opts.downing);
  const cluster = await Cluster.join(sys, clusterOptions);
  return { sys, cluster };
}

async function stop(n: Node): Promise<void> {
  try { await n.cluster.leave(); } catch { /* may already be left */ }
  await n.sys.terminate();
}

describe('Cluster + DowningProvider — wiring', () => {
  test('without downing: cluster behaves exactly as before (regression)', async () => {
    const sysName = 'no-down';
    const seed = await startNode(sysName, 64_001);
    const peer = await startNode(sysName, 64_002, { seeds: [`${sysName}@h:64001`] });

    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);

    // Crash the peer's transport → seed sees it unreachable, eventually down via FD.
    await peer.cluster.transport.shutdown();
    // With downAfterMs = 4s this is slow on purpose — we're not testing
    // the timeout itself, just that nothing throws.
    await sleep(300);
    expect(seed.cluster.getMembers().some((m) => m.status === 'unreachable')).toBe(true);

    await stop(seed);
    await peer.sys.terminate();
  }, 10_000);

  test('downing provider invoked on partition; decision applied (others)', async () => {
    const sysName = 'down-others';
    let invocations = 0;
    let lastView: ClusterPartitionView | null = null;
    const provider: DowningProvider = {
      decide(view) {
        invocations++;
        lastView = view;
        // Force-down anything we see as unreachable.
        return new Set(view.allMembers
          .filter((m) => view.unreachable.has(addrKey(m)))
          .map(addrKey));
      },
    };

    const seed = await startNode(sysName, 64_011, { downing: provider });
    const peer = await startNode(sysName, 64_012, { seeds: [`${sysName}@h:64011`] });
    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);

    // Reset counter — initial join may have fingerprint changes that
    // legitimately invoke decide() before the partition.
    invocations = 0;

    // Crash peer → seed marks it unreachable → provider decides to down it.
    await peer.cluster.transport.shutdown();

    // Provider should fire and force a down/removed transition long
    // before the FD's downAfterMs (4s) would.
    await waitFor(() => seed.cluster.upMembers().length === 1, 2_000);
    expect(invocations).toBeGreaterThan(0);
    expect(lastView).not.toBeNull();
    expect(lastView!.unreachable.size).toBeGreaterThan(0);

    await stop(seed);
    await peer.sys.terminate();
  }, 10_000);

  test('downing provider asking for self-down triggers cluster.leave', async () => {
    const sysName = 'down-self';
    const provider: DowningProvider = {
      decide(view) {
        if (view.unreachable.size > 0) {
          // Down ourselves.
          return new Set([view.self.toString()]);
        }
        return new Set();
      },
    };

    const seed = await startNode(sysName, 64_021, { downing: provider });
    const peer = await startNode(sysName, 64_022, { seeds: [`${sysName}@h:64021`] });
    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);

    // Crash peer so seed sees an unreachable, provider decides to
    // self-down on seed.  `leave()` runs internally — the seed's
    // own membership status flips to 'leaving' and the timers stop.
    await peer.cluster.transport.shutdown();

    await waitFor(() => {
      const me = seed.cluster.getMembers().find(
        (m) => m.address.equals(seed.cluster.selfAddress),
      );
      // After `leave()` runs, self is either marked 'leaving' or has
      // been GC'd from the members map entirely (downing path
      // depending on race).
      return !me || me.status === 'leaving' || me.status === 'removed';
    }, 5_000);

    await seed.sys.terminate();
    await peer.sys.terminate();
  }, 15_000);

  test('downing provider that throws — error logged, cluster keeps running', async () => {
    const sysName = 'down-throws';
    const provider: DowningProvider = {
      decide() { throw new Error('boom'); },
    };

    const seed = await startNode(sysName, 64_031, { downing: provider });
    const peer = await startNode(sysName, 64_032, { seeds: [`${sysName}@h:64031`] });
    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);

    await peer.cluster.transport.shutdown();
    // Even though provider throws, the cluster keeps running — peer
    // stays unreachable but is not force-downed (no decision applied).
    await sleep(400);
    expect(seed.cluster.getMembers().some((m) => m.status === 'unreachable')).toBe(true);
    // We're still alive.
    expect(seed.cluster.upMembers().length).toBeGreaterThanOrEqual(1);

    await stop(seed);
    await peer.sys.terminate();
  }, 10_000);
});
