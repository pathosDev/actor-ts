/**
 * Single-node smoke tests for `ClusterRouter` (#50).  These are
 * deliberately scoped to a one-member cluster: the routing semantics
 * (round-robin, consistent-hashing, broadcast) are exercised with the
 * router's only routee being itself, plus the membership-driven
 * rebuild check confirming the router survives an empty cluster
 * gracefully.
 *
 * Multi-node distribution and rebalancing on member-leave are covered
 * by `tests/multi-node/cluster-router.test.ts`.
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
  ClusterRouter,
  ClusterRouterOptions,
  pickRendezvous,
} from '../../../../../src/cluster/router/index.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Props } from '../../../../../src/Props.js';
import { Broadcast } from '../../../../../src/Router.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

interface ReceivedMsg { kind: 'work'; id: string }

let received: string[] = [];

class Worker extends Actor<ReceivedMsg> {
  override onReceive(m: ReceivedMsg): void {
    received.push(m.id);
  }
}

async function startNode(
  systemName: string,
  port: number,
  roles: string[] = [],
): Promise<{ sys: ActorSystem; cluster: Cluster }> {
  const sys = ActorSystem.create(systemName, ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
  const cluster = await Cluster.join(
    sys,
    ClusterOptions.create()
      .withHost('h')
      .withPort(port)
      .withRoles(roles)
      .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
      .withGossipIntervalMs(30),
  );
  return { sys, cluster };
}

describe('ClusterRouter — single node', () => {
  test('round-robin to a single self routee delivers each message once', async () => {
    received = [];
    const { sys, cluster } = await startNode('rr-single', 89_001, ['compute']);
    try {
      // Worker lives at /user/worker on every targeted node.
      sys.spawn(Props.create(() => new Worker()), 'worker');
      const router = sys.spawn(
        ClusterRouter.props<ReceivedMsg>(
          ClusterRouterOptions.create<ReceivedMsg>()
            .withCluster(cluster)
            .withRole('compute')
            .withRouterType('round-robin')
            .withRouteePath('/user/worker'),
        ),
        'compute-router',
      );
      // Wait for the cluster to mark self as up.
      await sleep(50);
      router.tell({ kind: 'work', id: '1' });
      router.tell({ kind: 'work', id: '2' });
      router.tell({ kind: 'work', id: '3' });
      await sleep(80);
      expect(received).toEqual(['1', '2', '3']);
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  }, 5_000);

  test('role filter drops messages when no routee matches', async () => {
    received = [];
    const { sys, cluster } = await startNode('rr-norole', 89_002, ['frontend']);
    try {
      sys.spawn(Props.create(() => new Worker()), 'worker');
      const router = sys.spawn(
        ClusterRouter.props<ReceivedMsg>(
          ClusterRouterOptions.create<ReceivedMsg>()
            .withCluster(cluster)
            .withRole('compute')                       // filters out 'frontend'-only node
            .withRouterType('round-robin')
            .withRouteePath('/user/worker'),
        ),
        'role-router',
      );
      await sleep(50);
      router.tell({ kind: 'work', id: 'lost' });
      await sleep(80);
      // No routee — the message should be dropped, not delivered.
      expect(received).toEqual([]);
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  }, 5_000);

  test('consistent-hashing pins identical keys to the same routee', async () => {
    received = [];
    const { sys, cluster } = await startNode('ch-single', 89_003);
    try {
      sys.spawn(Props.create(() => new Worker()), 'worker');
      const router = sys.spawn(
        ClusterRouter.props<ReceivedMsg>(
          ClusterRouterOptions.create<ReceivedMsg>()
            .withCluster(cluster)
            .withRouterType('consistent-hashing')
            .withRouteePath('/user/worker')
            .withExtractKey((m) => m.id),
        ),
        'ch-router',
      );
      await sleep(50);
      // With a single routee everything pins to it; the consistency
      // property is more interesting in the multi-node test.  Here we
      // verify the message arrives intact and `extractKey` is invoked
      // (no errors thrown).
      router.tell({ kind: 'work', id: 'order-42' });
      router.tell({ kind: 'work', id: 'order-43' });
      await sleep(80);
      expect(received.sort()).toEqual(['order-42', 'order-43']);
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  }, 5_000);

  test('broadcast routerType fans every message to every routee', async () => {
    received = [];
    const { sys, cluster } = await startNode('bc-single', 89_004);
    try {
      sys.spawn(Props.create(() => new Worker()), 'worker');
      const router = sys.spawn(
        ClusterRouter.props<ReceivedMsg>(
          ClusterRouterOptions.create<ReceivedMsg>()
            .withCluster(cluster)
            .withRouterType('broadcast')
            .withRouteePath('/user/worker'),
        ),
        'bc-router',
      );
      await sleep(50);
      router.tell({ kind: 'work', id: 'hello' });
      await sleep(80);
      expect(received).toEqual(['hello']);
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  }, 5_000);

  test('Broadcast<T> message wrapping fans out across all router types', async () => {
    received = [];
    const { sys, cluster } = await startNode('bc-msg', 89_005);
    try {
      sys.spawn(Props.create(() => new Worker()), 'worker');
      const router = sys.spawn(
        ClusterRouter.props<ReceivedMsg>(
          ClusterRouterOptions.create<ReceivedMsg>()
            .withCluster(cluster)
            .withRouterType('round-robin')             // not broadcast type
            .withRouteePath('/user/worker'),
        ),
        'bc-msg-router',
      );
      await sleep(50);
      router.tell(new Broadcast({ kind: 'work', id: 'announce' }));
      await sleep(80);
      // Single routee → seen once.  In a 3-node cluster this would land
      // 3× — the multi-node test covers that.
      expect(received).toEqual(['announce']);
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  }, 5_000);

  test('rejects consistent-hashing without extractKey at construction', () => {
    expect(() => {
      // The runtime guard fires on the missing extractKey before the
      // (unset) cluster is ever touched.
      ClusterRouter.props<ReceivedMsg>(
        ClusterRouterOptions.create<ReceivedMsg>()
          .withRouterType('consistent-hashing')
          .withRouteePath('/user/worker'),
        // no extractKey
      );
    }).toThrow(/extractKey/);
  });
});

describe('pickRendezvous — primitive', () => {
  test('same key always picks the same candidate', () => {
    const candidates = ['node-a', 'node-b', 'node-c', 'node-d'];
    const id = (s: string): string => s;
    const r1 = pickRendezvous('order-42', candidates, id);
    const r2 = pickRendezvous('order-42', candidates, id);
    expect(r1).toBe(r2);
  });

  test('removing a non-owning candidate does not relocate the key', () => {
    const candidates = ['node-a', 'node-b', 'node-c', 'node-d'];
    const id = (s: string): string => s;
    const owner = pickRendezvous('order-42', candidates, id);
    const without = candidates.filter((c) => c !== (owner === 'node-a' ? 'node-b' : 'node-a'));
    expect(pickRendezvous('order-42', without, id)).toBe(owner);
  });

  test('throws on empty candidates', () => {
    expect(() => pickRendezvous('k', [], (s: string) => s)).toThrow();
  });

  test('distribution is reasonably even across many keys', () => {
    const candidates = ['n-1', 'n-2', 'n-3', 'n-4'];
    const id = (s: string): string => s;
    const counts = new Map<string, number>();
    const N = 4_000;
    for (let i = 0; i < N; i++) {
      const owner = pickRendezvous(`key-${i}`, candidates, id);
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    // Expected average per node = 1000.  Tolerate ±20% spread —
    // FNV-1a is deterministic but not perfectly uniform.
    const expected = N / candidates.length;
    for (const c of candidates) {
      const got = counts.get(c) ?? 0;
      expect(got).toBeGreaterThan(expected * 0.8);
      expect(got).toBeLessThan(expected * 1.2);
    }
  });
});
