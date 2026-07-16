import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import {
  Find,
  Listing,
  Receptionist,
  ReceptionistId,
  ReceptionistOptions,
  Register,
  ServiceKey,
  Subscribe,
  Unsubscribe,
} from '../../../src/discovery/index.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Props } from '../../../src/Props.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import type { ActorRef } from '../../../src/ActorRef.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
async function waitFor(pred: () => boolean, timeoutMs = 2_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(stepMs);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

class Service extends Actor<string> {
  override onReceive(): void {}
}

describe('Receptionist — local', () => {
  test('Register → Find returns the registered ref', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('recp-local', kitOptions);
    const probe = kit.createTestProbe<Listing<string>>();
    const receptionist = kit.system.extension(ReceptionistId).start(null);

    const svc = kit.system.spawn(Props.create(() => new Service()), 'svc');
    const key = ServiceKey.of<string>('echo');
    receptionist.tell(new Register(key, svc));

    receptionist.tell(new Find(key, probe));
    const listing = await probe.expectMessageType(Listing, 500) as Listing<string>;
    expect(listing.key.id).toBe('echo');
    expect(listing.refs.map(r => r.path.toString())).toEqual([svc.path.toString()]);
    await kit.system.terminate();
  });

  test('Subscribe receives initial listing and future updates', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('recp-sub', kitOptions);
    const probe = kit.createTestProbe<Listing<string>>();
    const receptionist = kit.system.extension(ReceptionistId).start(null);

    const key = ServiceKey.of<string>('workers');
    receptionist.tell(new Subscribe(key, probe));
    const l0 = await probe.expectMessageType(Listing, 500) as Listing<string>;
    expect(l0.refs.length).toBe(0);

    const first = kit.system.spawn(Props.create(() => new Service()), 'a');
    receptionist.tell(new Register(key, first));
    const l1 = await probe.expectMessageType(Listing, 500) as Listing<string>;
    expect(l1.refs.length).toBe(1);

    const second = kit.system.spawn(Props.create(() => new Service()), 'b');
    receptionist.tell(new Register(key, second));
    const l2 = await probe.expectMessageType(Listing, 500) as Listing<string>;
    expect(l2.refs.length).toBe(2);

    receptionist.tell(new Unsubscribe(key, probe));
    await kit.system.terminate();
  });

  test('Registered reply arrives when Register supplies replyTo', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('recp-ack', kitOptions);
    const probe = kit.createTestProbe();
    const receptionist = kit.system.extension(ReceptionistId).start(null);

    const svc = kit.system.spawn(Props.create(() => new Service()), 'svc');
    const key = ServiceKey.of<string>('ack-key');
    receptionist.tell(new Register(key, svc, probe));

    const { Registered } = await import('../../../src/discovery/index.js');
    const ack = await probe.expectMessageType(Registered, 500);
    expect(ack.key.id).toBe('ack-key');
    await kit.system.terminate();
  });

  test('Deregister removes the ref and notifies subscribers', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('recp-dereg', kitOptions);
    const probe = kit.createTestProbe<Listing<string>>();
    const receptionist = kit.system.extension(ReceptionistId).start(null);

    const svc = kit.system.spawn(Props.create(() => new Service()), 'svc');
    const key = ServiceKey.of<string>('temp');

    receptionist.tell(new Subscribe(key, probe));
    await probe.expectMessageType(Listing, 500); // initial empty
    receptionist.tell(new Register(key, svc));
    await probe.expectMessageType(Listing, 500); // with svc

    const { Deregister } = await import('../../../src/discovery/index.js');
    receptionist.tell(new Deregister(key, svc));
    const empty = await probe.expectMessageType(Listing, 500) as Listing<string>;
    expect(empty.refs.length).toBe(0);
    await kit.system.terminate();
  });
});

describe('Receptionist — cluster-wide', () => {
  interface NodeContext { system: ActorSystem; cluster: Cluster; kit: TestKit; receptionist: ActorRef<unknown>; }

  async function startNode(sys: string, host: string, port: number, seeds: string[] = []): Promise<NodeContext> {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create(sys, kitOptions);
    const clusterOptions = ClusterOptions.create()
      .withHost(host)
      .withPort(port)
      .withSeeds(seeds)
      .withTransport(new InMemoryTransport(new NodeAddress(sys, host, port)))
      .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
      .withGossipIntervalMs(80);
    const cluster = await Cluster.join(
      kit.system,
      clusterOptions,
    );
    const receptionistOptions = ReceptionistOptions.create()
      .withGossipIntervalMs(80);
    const receptionist = kit.system.extension(ReceptionistId).start(
      cluster,
      receptionistOptions,
    );
    return { system: kit.system, cluster, kit, receptionist };
  }

  test('refs registered on node A are visible on node B via gossip', async () => {
    const first = await startNode('recp-cluster', 'h', 54001);
    const second = await startNode('recp-cluster', 'h', 54002, ['recp-cluster@h:54001']);
    await waitFor(() =>
      first.cluster.upMembers().length === 2 && second.cluster.upMembers().length === 2,
    );

    const aSvc = first.system.spawn(Props.create(() => new Service()), 'svc-on-a');
    const key = ServiceKey.of<string>('shared');
    first.receptionist.tell(new Register(key, aSvc) as never);

    // Wait for gossip to propagate.
    await sleep(300);

    const probe = second.kit.createTestProbe<Listing<string>>();
    second.receptionist.tell(new Find(key, probe) as never);
    const listing = await probe.expectMessageType(Listing, 1_500) as Listing<string>;
    expect(listing.refs.length).toBe(1);
    // Remote refs return the full path via toString (node + path).
    expect(listing.refs[0]!.toString()).toContain('svc-on-a');

    await first.cluster.leave(); await first.system.terminate();
    await second.cluster.leave(); await second.system.terminate();
  });

  test('node leaving removes its refs from peer listings', async () => {
    const first = await startNode('recp-leave', 'h', 54101);
    const second = await startNode('recp-leave', 'h', 54102, ['recp-leave@h:54101']);
    await waitFor(() =>
      first.cluster.upMembers().length === 2 && second.cluster.upMembers().length === 2,
    );

    const aSvc = first.system.spawn(Props.create(() => new Service()), 'svc-leave');
    const key = ServiceKey.of<string>('leaving');
    first.receptionist.tell(new Register(key, aSvc) as never);

    await sleep(300);

    const probe = second.kit.createTestProbe<Listing<string>>();
    second.receptionist.tell(new Subscribe(key, probe) as never);
    let last = await probe.expectMessageType(Listing, 1_500) as Listing<string>;
    expect(last.refs.length).toBe(1);

    await first.cluster.leave(); await first.system.terminate();

    // Consume listings until we observe an empty one (bounded).
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      try {
        last = await probe.expectMessageType(Listing, 300) as Listing<string>;
        if (last.refs.length === 0) break;
      } catch { break; }
    }
    expect(last.refs.length).toBe(0);

    await second.cluster.leave(); await second.system.terminate();
  });
});
