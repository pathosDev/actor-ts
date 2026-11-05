/**
 * A value of another CRDT kind than the one a replica holds for the same key
 * is kept out of the merge, and the replica keeps the value it has.
 *
 * `merge` takes an argument of its own kind and is not written to check: for
 * most pairs of kinds it throws, an empty `LWWRegister` returns whatever it is
 * merged with, and a few pairs return a value that cannot even be encoded.  An
 * `ORMap` merges the entries both sides hold, so the same happens one level
 * down.  Each place the replicator merges a value it did not produce itself is
 * pinned here — a gossip entry, the value of a write request, a read reply and
 * the combined result of a quorum read, and a durable record reloaded into the
 * view a restart kept — along with the warning that reports it and the rate
 * that warning is held to.
 *
 * The values that are not merged come in through a transport under its own
 * address that speaks the wire directly, or through a second cluster member
 * that answers a read itself, so each route is driven on its own.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { GOSSIP_SKIP_WARN_INTERVAL_MS } from '../../../src/crdt/Constants.js';
import type { DistributedDataHandle } from '../../../src/crdt/DistributedData.js';
import {
  DistributedDataId,
  DistributedDataOptions,
  GCounter,
  LWWRegister,
  ORMap,
  ORSet,
} from '../../../src/crdt/index.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { InMemoryDurableStateStore } from '../../../src/persistence/durable-state-stores/InMemoryDurableStateStore.js';
import { ActorRestarted } from '../../../src/SystemMessages.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { assertCompletesWithin } from '../../util/AsyncAssertions.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];
const transports: InMemoryTransport[] = [];
const unsubscribes: Array<() => void> = [];

afterEach(async () => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  await Promise.all(transports.splice(0).map((t) => t.shutdown().catch(() => {})));
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

type Node = {
  readonly cluster: Cluster;
  readonly log: RecordingLogger;
  /** How often the replicator has restarted so far. */
  readonly restarts: () => number;
};

type NodeSpecification = {
  readonly scheduler?: ManualScheduler;
  readonly seeds?: readonly string[];
};

async function startNode(name: string, port: number, specification: NodeSpecification = {}): Promise<Node> {
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create().withLogger(log);
  if (specification.scheduler !== undefined) systemOptions.withScheduler(specification.scheduler);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  let restarts = 0;
  unsubscribes.push(system.eventStream.subscribeFunction(ActorRestarted, (event) => {
    if (event.actor.path.toString().endsWith('/cluster/crdt/data')) restarts++;
  }));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)));
  if (specification.seeds !== undefined) clusterOptions.withSeeds([...specification.seeds]);
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return { cluster, log, restarts: () => restarts };
}

type WirePeer = {
  readonly transport: InMemoryTransport;
  readonly address: NodeAddress;
  /** Every frame this transport was sent, in arrival order. */
  readonly received: WireMessage[];
};

/** A transport under its own address that speaks the wire directly. */
async function wirePeer(name: string, port: number): Promise<WirePeer> {
  const address = new NodeAddress(name, 'h', port);
  const transport = new InMemoryTransport(address);
  const received: WireMessage[] = [];
  transport.setHandler((_from, message) => { received.push(message); });
  await transport.start();
  transports.push(transport);
  return { transport, address, received };
}

function gossip(peer: WirePeer, to: NodeAddress, entries: Record<string, unknown>): void {
  peer.transport.send(to, {
    kind: 'ddata-gossip',
    from: peer.address.toJSON(),
    entries,
  } as unknown as WireMessage);
}

/**
 * Gossip a fresh key behind everything sent so far and wait until it is in
 * the view.  One transport's frames reach the replicator in the order they
 * were sent and its mailbox keeps that order, so once the marker is there
 * every earlier frame has been handled — what it did is what the test reads.
 */
async function handledSoFar(peer: WirePeer, node: Node, data: DistributedDataHandle, marker: string): Promise<void> {
  gossip(peer, node.cluster.selfAddress, { [marker]: GCounter.empty().increment('marker', 1).toJSON() });
  await awaitCondition(() => data.get(marker) !== undefined, {
    label: `the frames sent before "${marker}" were handled`,
  });
}

/** The warnings that name `key` together with both CRDT kinds. */
function kindWarnings(node: Node, key: string, held: string, received: string): string[] {
  return node.log.records
    .filter((record) => record.level === 'warn')
    .map((record) => record.message)
    .filter((message) => message.includes(`"${key}"`) && message.includes(held) && message.includes(received));
}

function encoded(value: { toJSON(): unknown } | undefined): string {
  return JSON.stringify(value?.toJSON());
}

const anotherKindValue = (): unknown => ORSet.empty<string>().add('elsewhere', 'x').toJSON();

describe('DistributedData: a gossip entry of another CRDT kind', () => {
  test('leaves the held value in place, counts the drop and warns once', async () => {
    const node = await startNode('ddata-kind-gossip', 46_801);
    const registry = node.cluster.system.extension(MetricsExtensionId).enable();
    const data = node.cluster.system.extension(DistributedDataId).start(node.cluster);
    await data.updateAsync<GCounter>('hits', GCounter.empty, (c) => c.increment(data.selfReplicaId(), 2));
    const held = encoded(data.get('hits'));

    const peer = await wirePeer('ddata-kind-gossip-peer', 46_802);
    gossip(peer, node.cluster.selfAddress, { hits: anotherKindValue() });
    gossip(peer, node.cluster.selfAddress, { hits: anotherKindValue() });
    await handledSoFar(peer, node, data, 'marker');

    expect(node.restarts()).toBe(0);
    expect(encoded(data.get('hits'))).toBe(held);
    // Two values dropped, one line about them: the second arrived inside the
    // first one's quiet period.
    expect(kindWarnings(node, 'hits', 'GCounter', 'ORSet')).toHaveLength(1);
    expect(registry.counter('distributed_data_dropped_values_total').value).toBe(2);
  });

  test('is not taken over by an empty register, whose merge would return it', async () => {
    const node = await startNode('ddata-kind-register', 46_803);
    const data = node.cluster.system.extension(DistributedDataId).start(node.cluster);
    // An unassigned register is a value the view holds like any other.
    await data.updateAsync<LWWRegister<string>>('name', LWWRegister.empty, (register) => register);
    const held = encoded(data.get('name'));

    const peer = await wirePeer('ddata-kind-register-peer', 46_804);
    gossip(peer, node.cluster.selfAddress, { name: GCounter.empty().increment('elsewhere', 3).toJSON() });
    await handledSoFar(peer, node, data, 'marker');

    expect(encoded(data.get('name'))).toBe(held);
    expect(kindWarnings(node, 'name', 'LWWRegister', 'GCounter')).toHaveLength(1);
  });

  test('inside an ORMap entry both hold leaves the held map in place', async () => {
    const node = await startNode('ddata-kind-nested', 46_805);
    const data = node.cluster.system.extension(DistributedDataId).start(node.cluster);
    const self = data.selfReplicaId();
    await data.updateAsync<ORMap<string, GCounter>>('totals', ORMap.empty,
      (map) => map.put(self, 'k', GCounter.empty().increment(self, 1)));
    const held = encoded(data.get('totals'));

    const peer = await wirePeer('ddata-kind-nested-peer', 46_806);
    const otherMap = ORMap.empty<string, LWWRegister<string>>()
      .put('elsewhere', 'k', LWWRegister.empty<string>().assign('elsewhere', 'v'));
    gossip(peer, node.cluster.selfAddress, { totals: otherMap.toJSON() });
    await handledSoFar(peer, node, data, 'marker');

    expect(node.restarts()).toBe(0);
    expect(encoded(data.get('totals'))).toBe(held);
    expect(kindWarnings(node, 'totals', 'GCounter', 'LWWRegister')).toHaveLength(1);
  });

  test('inside an ORMap entry is not taken over by an empty register there either', async () => {
    const node = await startNode('ddata-kind-nested-register', 46_807);
    const data = node.cluster.system.extension(DistributedDataId).start(node.cluster);
    const self = data.selfReplicaId();
    await data.updateAsync<ORMap<string, LWWRegister<string>>>('slots', ORMap.empty,
      (map) => map.put(self, 'k', LWWRegister.empty<string>()));
    const held = encoded(data.get('slots'));

    const peer = await wirePeer('ddata-kind-nested-register-peer', 46_808);
    const otherMap = ORMap.empty<string, GCounter>()
      .put('elsewhere', 'k', GCounter.empty().increment('elsewhere', 4));
    gossip(peer, node.cluster.selfAddress, { slots: otherMap.toJSON() });
    await handledSoFar(peer, node, data, 'marker');

    expect(encoded(data.get('slots'))).toBe(held);
    expect(kindWarnings(node, 'slots', 'LWWRegister', 'GCounter')).toHaveLength(1);
  });
});

describe('DistributedData: a write request whose value is of another CRDT kind', () => {
  test('is neither merged nor acknowledged, and the next one still is', async () => {
    const node = await startNode('ddata-kind-write', 46_811);
    const data = node.cluster.system.extension(DistributedDataId).start(node.cluster);
    await data.updateAsync<GCounter>('hits', GCounter.empty, (c) => c.increment(data.selfReplicaId(), 2));

    const peer = await wirePeer('ddata-kind-write-peer', 46_812);
    const writeRequest = (pendingId: string, value: unknown): WireMessage => ({
      kind: 'ddata-write-request',
      from: peer.address.toJSON(),
      pendingId,
      key: 'hits',
      value,
    } as unknown as WireMessage);
    peer.transport.send(node.cluster.selfAddress, writeRequest('write-another-kind', anotherKindValue()));
    peer.transport.send(node.cluster.selfAddress,
      writeRequest('write-same-kind', GCounter.empty().increment('elsewhere', 1).toJSON()));
    const acknowledged = (pendingId: string): boolean => peer.received.some((frame) => {
      const message = frame as unknown as { kind: string; pendingId?: string };
      return message.kind === 'ddata-write-ack' && message.pendingId === pendingId;
    });
    await awaitCondition(() => acknowledged('write-same-kind'), { label: 'the same-kind write was acknowledged' });

    expect(acknowledged('write-another-kind')).toBe(false);
    expect(node.restarts()).toBe(0);
    // Two from this replica, one from the write that could be merged.
    expect(data.get<GCounter>('hits')?.value()).toBe(3);
    expect(kindWarnings(node, 'hits', 'GCounter', 'ORSet')).toHaveLength(1);
  });
});

type CapturedReadRequest = {
  readonly from: NodeAddress;
  readonly pendingId: string;
  readonly key: string;
};

/**
 * A two-member cluster where only the first member runs DistributedData.  The
 * second is a real up-member, so a read at `'all'` waits for its reply, and
 * it answers that reply itself: it keeps the requests it is sent and the test
 * replies with the value it chooses.
 */
async function readCluster(prefix: string, basePort: number): Promise<{
  readonly node: Node;
  readonly member: Node;
  readonly requests: CapturedReadRequest[];
}> {
  const node = await startNode(`${prefix}-a`, basePort);
  const member = await startNode(`${prefix}-b`, basePort + 1, { seeds: [`${prefix}-a@h:${basePort}`] });
  await awaitCondition(() => node.cluster.upMembers().length >= 2, {
    timeoutMs: 4_000,
    intervalMs: 25,
    label: 'the two-member cluster converged',
  });
  const requests: CapturedReadRequest[] = [];
  unsubscribes.push(member.cluster._onWire('ddata-read-request', (message, from) => {
    const request = message as unknown as { pendingId: string; key: string };
    requests.push({ from, pendingId: request.pendingId, key: request.key });
  }));
  return { node, member, requests };
}

function reply(member: Node, request: CapturedReadRequest, value: unknown): void {
  member.cluster.transport.send(request.from, {
    kind: 'ddata-read-response',
    from: member.cluster.selfAddress.toJSON(),
    pendingId: request.pendingId,
    key: request.key,
    value,
  } as unknown as WireMessage);
}

describe('DistributedData: a quorum read', () => {
  test('counts a reply of another CRDT kind as an answer and drops its value', async () => {
    const { node, member, requests } = await readCluster('ddata-kind-read', 46_821);
    const data = node.cluster.system.extension(DistributedDataId).start(node.cluster);
    await data.updateAsync<GCounter>('hits', GCounter.empty, (c) => c.increment(data.selfReplicaId(), 2));
    const held = encoded(data.get('hits'));

    const read = data.getAsync<GCounter>('hits', { consistency: 'all', timeoutMs: 3_000 });
    await awaitCondition(() => requests.length === 1, { label: 'the read request reached the second member' });
    reply(member, requests[0]!, anotherKindValue());
    const value = await assertCompletesWithin(read, 2_000, 'the read settled once its last reply arrived');

    expect(value?.value()).toBe(2);
    expect(node.restarts()).toBe(0);
    expect(encoded(data.get('hits'))).toBe(held);
    expect(kindWarnings(node, 'hits', 'GCounter', 'ORSet')).toHaveLength(1);
  });

  test('whose combined value is of another CRDT kind than the value held by then leaves the held one', async () => {
    const { node, member, requests } = await readCluster('ddata-kind-read-apply', 46_831);
    const data = node.cluster.system.extension(DistributedDataId).start(node.cluster);

    // Nothing is held when the read starts, so the reply alone makes up its
    // value; the key is written here before that reply arrives.
    const read = data.getAsync<GCounter>('hits', { consistency: 'all', timeoutMs: 3_000 });
    await awaitCondition(() => requests.length === 1, { label: 'the read request reached the second member' });
    await data.updateAsync<GCounter>('hits', GCounter.empty, (c) => c.increment(data.selfReplicaId(), 2));
    const held = encoded(data.get('hits'));
    reply(member, requests[0]!, anotherKindValue());
    const value = await assertCompletesWithin(read, 2_000, 'the read settled once its last reply arrived');

    expect(node.restarts()).toBe(0);
    expect(encoded(data.get('hits'))).toBe(held);
    // The read answers with what this replica holds once it has finished.
    expect(encoded(value)).toBe(held);
    expect(kindWarnings(node, 'hits', 'GCounter', 'ORSet')).toHaveLength(1);
  });
});

describe('DistributedData: a durable record with another CRDT kind for a held key', () => {
  test('is reloaded around that key after a restart: the held value stays and the rest of the record arrives', async () => {
    const node = await startNode('ddata-kind-reload', 46_841);
    const store = new InMemoryDurableStateStore();
    const distributedDataOptions = DistributedDataOptions.create().withDurableStore(store);
    const data = node.cluster.system.extension(DistributedDataId).start(node.cluster, distributedDataOptions);
    await data.updateAsync<GCounter>('hits', GCounter.empty, (c) => c.increment(data.selfReplicaId(), 2));
    const held = encoded(data.get('hits'));

    // The record as a build of the application that kept another kind under
    // `hits` would have left it, with a second key after it.
    const persistenceId = `ddata|${node.cluster.selfAddress.toString()}`;
    await awaitCondition(async () => (await store.load(persistenceId)).isSome(), {
      label: 'the first save reached the store',
    });
    const record = await store.load<unknown>(persistenceId);
    if (!record.isSome()) throw new Error('unreachable: the record was there a moment ago');
    await store.upsert(persistenceId, record.value.revision, {
      entries: {
        hits: anotherKindValue(),
        misses: GCounter.empty().increment('earlier', 5).toJSON(),
      },
    });

    // A modifier that throws restarts the replicator, and the restarted one
    // reloads the record into the view it kept.
    data.update<GCounter>('other', GCounter.empty, () => { throw new Error('modifier failed'); });
    await awaitCondition(() => node.restarts() === 1, { label: 'the replicator restarted' });
    // Handled after the restarted instance's preStart, reload included.
    await data.getAsync('hits', { consistency: 'local' });

    expect(encoded(data.get('hits'))).toBe(held);
    expect(data.get<GCounter>('misses')?.value()).toBe(5);
    expect(node.restarts()).toBe(1);
    expect(kindWarnings(node, 'hits', 'GCounter', 'ORSet')).toHaveLength(1);
  });
});

describe('DistributedData: the warning about a value of another CRDT kind', () => {
  test('is held to one per key per quiet period', async () => {
    const scheduler = new ManualScheduler();
    const node = await startNode('ddata-kind-quiet', 46_851, { scheduler });
    const data = node.cluster.system.extension(DistributedDataId).start(node.cluster);
    await data.updateAsync<GCounter>('hits', GCounter.empty, (c) => c.increment(data.selfReplicaId(), 1));
    await data.updateAsync<GCounter>('misses', GCounter.empty, (c) => c.increment(data.selfReplicaId(), 1));

    const peer = await wirePeer('ddata-kind-quiet-peer', 46_852);
    gossip(peer, node.cluster.selfAddress, { hits: anotherKindValue() });
    gossip(peer, node.cluster.selfAddress, { hits: anotherKindValue() });
    gossip(peer, node.cluster.selfAddress, { misses: anotherKindValue() });
    await handledSoFar(peer, node, data, 'marker-1');
    expect(kindWarnings(node, 'hits', 'GCounter', 'ORSet')).toHaveLength(1);
    // Its own quiet period: one key's warning does not silence another's.
    expect(kindWarnings(node, 'misses', 'GCounter', 'ORSet')).toHaveLength(1);

    scheduler.advance(GOSSIP_SKIP_WARN_INTERVAL_MS - 1);
    gossip(peer, node.cluster.selfAddress, { hits: anotherKindValue() });
    await handledSoFar(peer, node, data, 'marker-2');
    expect(kindWarnings(node, 'hits', 'GCounter', 'ORSet')).toHaveLength(1);

    scheduler.advance(1);
    gossip(peer, node.cluster.selfAddress, { hits: anotherKindValue() });
    await handledSoFar(peer, node, data, 'marker-3');
    expect(kindWarnings(node, 'hits', 'GCounter', 'ORSet')).toHaveLength(2);
    expect(node.restarts()).toBe(0);
  });
});

describe('DistributedData: an update whose modifier returns another CRDT kind', () => {
  test('replaces the value without restarting the replicator', async () => {
    const node = await startNode('ddata-kind-local', 46_861);
    const data = node.cluster.system.extension(DistributedDataId).start(node.cluster);
    const self = data.selfReplicaId();
    await data.updateAsync<GCounter>('hits', GCounter.empty, (c) => c.increment(self, 2));

    // Nothing is merged on this path: what the modifier returns is the new
    // value, of whatever kind, exactly as before.
    const toAnotherKind = (() => ORSet.empty<string>().add(self, 'x')) as unknown as (current: GCounter) => GCounter;
    await data.updateAsync<GCounter>('hits', GCounter.empty, toAnotherKind);

    expect(data.get('hits')?.toJSON()).toMatchObject({ kind: 'ORSet' });
    expect(node.restarts()).toBe(0);
  });
});
