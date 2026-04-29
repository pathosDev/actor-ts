/**
 * Unit tests for the CoordinatorState persistence layer (#39).
 *
 * The DD-backed default `DistributedDataCoordinatorStateStore` is
 * exercised end-to-end via the multi-node test
 * (`tests/multi-node/sharding-coordinator-recovery.test.ts`).  Here
 * we cover the pure shape:
 *
 *   1. Round-trip via a hand-rolled in-memory `CoordinatorStateStore`
 *      preserves every field.
 *   2. Empty store: `load()` returns `null`.
 *   3. The DD-backed store reads/writes through the shared
 *      `DistributedDataHandle` correctly.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import {
  DistributedDataCoordinatorStateStore,
  type CoordinatorStateData,
  type CoordinatorStateStore,
} from '../../../../src/cluster/sharding/CoordinatorState.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { DistributedDataId } from '../../../../src/crdt/DistributedData.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';

const sample: CoordinatorStateData = {
  leader: 'sys@h:1234',
  takenAt: 1_000_000,
  regions: [
    {
      key: 'sys@h:1234|/user/r-A',
      node: { systemName: 'sys', host: 'h', port: 1234 },
      path: '/user/r-A',
      proxy: false,
      shards: [0, 1, 2],
    },
    {
      key: 'sys@h:1235|/user/r-B',
      node: { systemName: 'sys', host: 'h', port: 1235 },
      path: '/user/r-B',
      proxy: false,
      shards: [3, 4],
    },
  ],
  shardHome: [
    [0, 'sys@h:1234|/user/r-A'],
    [1, 'sys@h:1234|/user/r-A'],
    [2, 'sys@h:1234|/user/r-A'],
    [3, 'sys@h:1235|/user/r-B'],
    [4, 'sys@h:1235|/user/r-B'],
  ],
};

describe('CoordinatorStateStore', () => {
  test('1. round-trip via an in-memory store preserves every field', async () => {
    // Hand-rolled in-memory store — used by tests that don't need
    // the DD machinery.  Mirrors the contract.
    const records = new Map<string, CoordinatorStateData>();
    const store: CoordinatorStateStore = {
      async load(typeName) { return records.get(typeName) ?? null; },
      async save(typeName, state) { records.set(typeName, state); },
    };

    await store.save('entity', sample);
    const loaded = await store.load('entity');
    expect(loaded).toEqual(sample);
  });

  test('2. empty store returns null on load', async () => {
    const store: CoordinatorStateStore = {
      async load() { return null; },
      async save() { /* no-op */ },
    };
    expect(await store.load('whatever')).toBeNull();
  });

  test('3. DistributedDataCoordinatorStateStore round-trips through DD', async () => {
    const sys = ActorSystem.create('coord-state', {
      logger: new NoopLogger(), logLevel: LogLevel.Off,
    });
    const cluster = await Cluster.join(sys, {
      host: 'h', port: 71_001,
      transport: new InMemoryTransport(new NodeAddress('coord-state', 'h', 71_001)),
      gossipIntervalMs: 80,
    });
    const dd = sys.extension(DistributedDataId).start(cluster, { gossipIntervalMs: 80 });

    const store = new DistributedDataCoordinatorStateStore(
      dd, cluster.selfAddress.toString(),
    );

    expect(await store.load('entity')).toBeNull();

    await store.save('entity', sample);
    // DD writes are funnelled through the actor mailbox; give one tick
    // for the update to land in the in-memory view.
    await Bun.sleep(20);

    const loaded = await store.load('entity');
    expect(loaded).toEqual(sample);

    await cluster.leave();
    await sys.terminate();
  }, 5_000);
});
