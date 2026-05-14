/**
 * ClusterSharding + Lease integration tests (#60).
 *
 * Three single-node scenarios cover the coordinator's lease state
 * machine.  The multi-node split-brain test lives in
 * `tests/multi-node/sharding-lease-split-brain.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { AskTimeoutError } from '../../../../src/SystemMessages.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterSharding } from '../../../../src/cluster/sharding/ClusterSharding.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import {
  InMemoryLease,
  inMemoryLeaseStore,
} from '../../../../src/coordination/leases/InMemoryLease.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import type { ActorRef } from '../../../../src/ActorRef.js';

type Cmd = { id: string; op: 'ping' };

class Entity extends Actor<Cmd> {
  override onReceive(m: Cmd): void {
    if (m.op === 'ping') this.sender.forEach((s) => s.tell('pong'));
  }
}

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
  region: ActorRef<Cmd>;
}

async function startNodeWithLease(
  systemName: string, port: number, lease: InMemoryLease,
): Promise<Node> {
  const sys = ActorSystem.create(systemName, { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const cluster = await Cluster.join(sys, {
    host: 'h', port,
    transport: new InMemoryTransport(new NodeAddress(systemName, 'h', port)),
    gossipIntervalMs: 30,
  });
  const region = cluster.sharding.start<Cmd>({
    typeName: 'entity',
    entityProps: Props.create(() => new Entity()),
    extractEntityId: (m) => m.id,
    numShards: 8,
    rebalanceIntervalMs: 200,
    lease,
    acquireRetryIntervalMs: 100,
  });
  return { sys, cluster, region };
}

async function stop(n: Node): Promise<void> {
  await n.cluster.leave();
  await n.sys.terminate();
}

describe('ClusterSharding + Lease', () => {
  test('1. acquire blocked by another holder → coordinator does not respond to shard requests', async () => {
    inMemoryLeaseStore._clear();
    // Foreign holder owns the lease before the coordinator boots.
    const foreign = new InMemoryLease({
      name: 'sharding-lease-1', owner: 'someone-else', ttlMs: 10_000,
    });
    expect(await foreign.acquire()).toBe(true);

    const lease = new InMemoryLease({
      name: 'sharding-lease-1', owner: 'self', ttlMs: 10_000,
    });
    const a = await startNodeWithLease('shard-lease-1', 60_101, lease);

    // Coordinator can't acquire — region's GetShardHome ask never
    // gets a ShardHome reply, so any user message into the region
    // sits in its buffer.  An ask with a tight timeout therefore
    // times out instead of returning 'pong'.
    await expect(
      a.region.ask<string>({ id: 'e-1', op: 'ping' }, 400)
    ).rejects.toBeInstanceOf(AskTimeoutError);

    // Now release the foreign lease — the coordinator's retry tick
    // (100 ms above) catches it and acquires.  Subsequent ask works.
    await foreign.release();
    await waitFor(() => lease.checkAlive(), 2_000);

    const reply = await a.region.ask<string>({ id: 'e-1', op: 'ping' }, 3_000);
    expect(reply).toBe('pong');

    await stop(a);
  }, 15_000);

  test('2. lost lease stops coordinator activity (asks resume after re-acquire)', async () => {
    inMemoryLeaseStore._clear();
    const lease = new InMemoryLease({
      name: 'sharding-lease-2', owner: 'self', ttlMs: 10_000,
      renewalIntervalMs: 60,
    });
    const a = await startNodeWithLease('shard-lease-2', 60_102, lease);

    // Initial ask succeeds — coordinator acquired the lease cleanly.
    await waitFor(() => lease.checkAlive(), 2_000);
    expect(await a.region.ask<string>({ id: 'e-1', op: 'ping' }, 2_000)).toBe('pong');

    // Force the lease away by clearing the store + having a usurper
    // take it.  The InMemoryLease's renewal loop will fail and fire
    // onLost, which the coordinator handles by stepping down.
    inMemoryLeaseStore._clear();
    const usurper = new InMemoryLease({
      name: 'sharding-lease-2', owner: 'usurper', ttlMs: 10_000,
    });
    expect(await usurper.acquire()).toBe(true);

    // Wait for the local lease renewal to detect the loss + the
    // coordinator's step-down handler to clear regions.
    await waitFor(() => !lease.checkAlive(), 2_000);

    // While the usurper still holds, asks fail — the coordinator
    // is passive even though it's still the cluster leader.
    await expect(
      a.region.ask<string>({ id: 'e-2', op: 'ping' }, 400)
    ).rejects.toBeInstanceOf(AskTimeoutError);

    // Hand the lease back; the coordinator's retry tick re-acquires.
    await usurper.release();
    await waitFor(() => lease.checkAlive(), 3_000);
    expect(await a.region.ask<string>({ id: 'e-3', op: 'ping' }, 3_000)).toBe('pong');

    await stop(a);
  }, 20_000);

  test('3. graceful coordinator stop releases the lease', async () => {
    inMemoryLeaseStore._clear();
    const lease = new InMemoryLease({
      name: 'sharding-lease-3', owner: 'self', ttlMs: 10_000,
    });
    const a = await startNodeWithLease('shard-lease-3', 60_103, lease);

    await waitFor(() => lease.checkAlive(), 2_000);
    expect(lease.checkAlive()).toBe(true);

    await a.cluster.leave();
    await a.sys.terminate();

    // postStop releases the lease; allow a tick for the async release.
    await waitFor(() => !lease.checkAlive(), 2_000);
    expect(lease.checkAlive()).toBe(false);
  }, 10_000);
});
