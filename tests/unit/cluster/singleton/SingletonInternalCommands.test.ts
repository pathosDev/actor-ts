/**
 * A plain object cannot pose as one of the singleton manager's own commands
 * (#1267).
 *
 * `ClusterSingletonManager` told itself `reconcile`, `lease-lost`,
 * `restart-child`, `hand-over-timeout`, … as plain `{ kind }` objects and
 * matched them by string, so anything that reached its mailbox and spelled
 * one was obeyed — a plain `{ kind: 'lease-lost' }` stopped the singleton on a
 * node that still held the lease.  The manager sits at a resolvable path, so
 * only the envelope trust policy's `/system` refusal stood between that and a
 * raw frame delivered through generic path resolution.  The commands are
 * module-local classes now, and a look-alike is an unrecognised message,
 * dropped.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { StartSingletonOptions } from '../../../../src/cluster/singleton/index.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { InMemoryLease, inMemoryLeaseStore } from '../../../../src/coordination/leases/InMemoryLease.js';
import { LeaseOptions } from '../../../../src/coordination/LeaseOptions.js';
import { SystemGroups, singletonManagerName, systemActorPath } from '../../../../src/internal/SystemPaths.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { TestKit } from '../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../src/testkit/TestKitOptions.js';

type Running = { readonly kit: TestKit; readonly cluster: Cluster };

let running: Running | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* best-effort */ });
    await running.kit.system.terminate().catch(() => { /* best-effort */ });
    running = null;
  }
  inMemoryLeaseStore._clear();
});

describe('the singleton manager obeys only its own commands (#1267)', () => {
  test('a plain lease-lost look-alike does not stop a singleton whose lease is held', async () => {
    inMemoryLeaseStore._clear();
    const systemName = '1267-singleton-forged';
    const port = 44_720;
    const kit = TestKit.create(systemName, TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(port)
      .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
      .withGossipIntervalMs(30);
    const cluster = await Cluster.join(kit.system, clusterOptions);
    running = { kit, cluster };

    const probe = kit.createTestProbe();
    class Echo extends Actor<string> {
      override preStart(): void { probe.tell('started'); }
      override postStop(): void { probe.tell('stopped'); }
      override onReceive(message: string): void { probe.tell(`got:${message}`); }
    }
    const leaseOptions = LeaseOptions.create().withName('1267-singleton').withOwner('a').withTtlMs(5_000);
    const lease = new InMemoryLease(leaseOptions);
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withActor(Echo)
      .withLease(lease);
    const singleton = cluster.singleton.start(singletonOptions);
    await probe.expectMessage('started', 2_000);

    const managerPath = systemActorPath(systemName, SystemGroups.clusterSingleton, singletonManagerName('echo'));
    const segments = managerPath.replace(/^actor-ts:\/\/[^/]+\//, '').split('/').filter((s) => s.length > 0);
    const manager = kit.system._resolvePath(segments);
    if (manager.isNone()) throw new Error(`no singleton manager at ${managerPath}`);

    manager.value.tell({ kind: 'lease-lost', reason: 'forged' } as never);
    manager.value.tell({ kind: 'restart-child' } as never);
    // Through the manager, behind both look-alikes: the singleton is still up
    // and still answers, and it was never stopped on the way.
    singleton.tell('after');

    expect(await probe.expectMessage('got:after', 2_000)).toBe('got:after');
    expect(lease.checkAlive()).toBe(true);
  }, 10_000);
});
