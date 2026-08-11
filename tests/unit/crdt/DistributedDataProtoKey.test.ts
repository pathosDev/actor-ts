/**
 * A `__proto__` store key gossips and persists like any other (#767).
 *
 * `JSON.parse` makes `__proto__` an own enumerable property, and every decode
 * target here is a `Map`, so the key went in fine.  Every re-encode built a
 * fresh object literal and assigned into it — and for that one key an
 * assignment invokes `Object.prototype`'s inherited setter instead of creating
 * a property, so the entry vanished from the outbound frame and from the
 * durable snapshot while `get`/`keys` still reported it locally.  A replica
 * silently out of step with the cluster, with nothing logged anywhere.
 *
 * Store keys are the exposed layer because they are raw application strings —
 * an application deriving one from untrusted input (a username, a tenant id)
 * is the realistic trigger, not a planted frame.  `Object.entries` over the
 * encoded payload is what makes the loss visible, so that is what these assert.
 *
 * Same forging harness as `DistributedDataAuthority.test.ts` and
 * `DistributedDataDecodeIsolation.test.ts`: a plain `InMemoryTransport` under
 * its own address, speaking the wire directly.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  DistributedDataId,
  DurableDistributedDataStore,
  GCounter,
  GCounterMap,
  LWWMap,
  ORMap,
  ORSet,
} from '../../../src/crdt/index.js';
import { CrdtDecodeError } from '../../../src/crdt/CrdtWireValidation.js';
import { InMemoryDurableStateStore } from '../../../src/persistence/durable-state-stores/InMemoryDurableStateStore.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];
const transports: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.shutdown().catch(() => {})));
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

async function startNode(name: string, port: number, seeds?: string[]): Promise<Cluster> {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(60);
  if (seeds !== undefined) clusterOptions.withSeeds(seeds);
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return cluster;
}

async function attacker(name: string, port: number): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport(new NodeAddress(name, 'h', port));
  transport.setHandler(() => {});
  await transport.start();
  transports.push(transport);
  return transport;
}

/**
 * A frame as it comes off the wire, from JSON *text*.
 *
 * The text matters: `{ __proto__: … }` written in source sets the object's
 * prototype rather than creating the key, and `JSON.stringify` then emits an
 * empty object — a frame built that way carries nothing and reproduces
 * nothing.  Only `JSON.parse` creates `__proto__` as an own property, which is
 * exactly why the decode side of this defect was reachable in the first place.
 */
function parsedFrame(json: string): WireMessage {
  return JSON.parse(json) as WireMessage;
}

describe('DistributedData — a `__proto__` store key (#767)', () => {
  test('reaches the peer it is gossiped to', async () => {
    const a = await startNode('proto-a', 47_301);
    const b = await startNode('proto-b', 47_302, ['proto-a@h:47301']);
    await waitFor(() => a.upMembers().length >= 2 && b.upMembers().length >= 2);

    const dataA = a.system.extension(DistributedDataId).start(a);
    const dataB = b.system.extension(DistributedDataId).start(b);
    await sleep(60);

    // The one key an application can hold and never replicate.  It was also
    // the only key here, which used to trip `Object.keys(entries).length === 0`
    // and suppress the whole tick — A stopped gossiping rather than gossiping
    // an incomplete frame.
    dataA.update('__proto__', GCounter.empty, (c) => c.increment(dataA.selfReplicaId(), 4));
    await waitFor(() => dataB.keys().includes('__proto__'));

    expect(dataB.get<GCounter>('__proto__')?.value()).toBe(4);
  });

  test('survives a durable save/load round-trip', async () => {
    const store = new InMemoryDurableStateStore();
    const durable = new DurableDistributedDataStore(store, 'replica-a');

    const view = new Map<string, GCounter>();
    view.set('__proto__', GCounter.empty().increment('replica-a', 9));
    view.set('ordinary', GCounter.empty().increment('replica-a', 1));
    await durable.save(view as never);

    // Straight at the persisted record: the encode is where the key was lost,
    // so asserting only on the decoded view would pass against the defect.
    const record = await store.load<{ entries: Record<string, unknown> }>('ddata|replica-a');
    expect(record.isNone()).toBe(false);
    const persisted = record.isNone() ? {} : record.value.state.entries;
    expect(Object.entries(persisted).map(([key]) => key).sort()).toEqual(['__proto__', 'ordinary']);

    const reloaded = await durable.load();
    expect((reloaded.get('__proto__') as GCounter | undefined)?.value()).toBe(9);
  });

  test('arriving from a peer, it is re-gossiped rather than absorbed', async () => {
    // The exploit walkthrough end to end: a hostile frame plants the key on
    // one replica, which then holds it, reports it through `keys()`, and never
    // tells anyone else — converging nowhere while looking healthy.
    const a = await startNode('proto-relay-a', 47_311);
    const b = await startNode('proto-relay-b', 47_312, ['proto-relay-a@h:47311']);
    await waitFor(() => a.upMembers().length >= 2 && b.upMembers().length >= 2);

    const dataA = a.system.extension(DistributedDataId).start(a);
    const dataB = b.system.extension(DistributedDataId).start(b);
    await sleep(60);

    const evil = await attacker('proto-evil', 47_313);
    const from = JSON.stringify(new NodeAddress('proto-evil', 'h', 47_313).toJSON());
    const planted = JSON.stringify(GCounter.empty().increment('proto-evil', 6).toJSON());
    evil.send(a.selfAddress, parsedFrame(
      `{"kind":"ddata-gossip","from":${from},"entries":{"__proto__":${planted}}}`,
    ));

    await waitFor(() => dataA.keys().includes('__proto__'));
    await waitFor(() => dataB.keys().includes('__proto__'));
    expect(dataB.get<GCounter>('__proto__')?.value()).toBe(6);
  });
});

describe('CRDT collections — a `__proto__` entry id (#767)', () => {
  /**
   * Entry ids are identity-function output.  The default identity JSON-stringifies,
   * which quotes the key and can never produce a bare `__proto__` — but a
   * custom identity can, and that is the whole point of the option.
   */
  const identity = (key: string): string => key;

  test('is carried by every collection encoder rather than dropped', () => {
    const orSet = ORSet.empty<string>({ identity }).add('replica-a', '__proto__');
    expect(Object.keys(orSet.toJSON().elements)).toEqual(['__proto__']);
    expect(Object.keys(orSet.toJSON().elementValues ?? {})).toEqual(['__proto__']);
    // Tombstones travel through their own encoder, `mapOfSetsToObject`.
    expect(Object.keys(orSet.remove('__proto__').toJSON().tombstones)).toEqual(['__proto__']);

    const lwwMap = LWWMap.empty<string, number>({ identity }).put('replica-a', '__proto__', 1, 1_000);
    expect(Object.keys(lwwMap.toJSON().registers)).toEqual(['__proto__']);

    const counterMap = GCounterMap.empty<string>({ identity }).increment('replica-a', '__proto__', 3);
    expect(Object.keys(counterMap.toJSON().counters)).toEqual(['__proto__']);

    const orMap = ORMap.empty<string, GCounter>({ identity })
      .put('replica-a', '__proto__', GCounter.empty().increment('replica-a', 2));
    expect(Object.keys(orMap.toJSON().values)).toEqual(['__proto__']);
  });

  test('is rejected loudly by the decoders that could not re-encode it', () => {
    // `ORSet` already refused one; `LWWMap` and `ORMap` decoded it and then
    // dropped it on the way back out, which is the silent half of the defect.
    const lwwMapJson = JSON.parse(
      '{"kind":"LWWMap","registers":{"__proto__":'
      + '{"kind":"LWWRegister","value":1,"timestamp":1000,"replica":"r"}}}',
    );
    expect(() => LWWMap.fromJSON(lwwMapJson)).toThrow(CrdtDecodeError);

    const orMapJson = JSON.parse(
      '{"kind":"ORMap","keyset":{"kind":"ORSet","elements":{},"elementValues":{},'
      + '"tombstones":{},"counters":{}},"values":{"__proto__":{"kind":"GCounter","state":{}}}}',
    );
    expect(() => ORMap.fromJSON(orMapJson, (inner) => GCounter.fromJSON(inner as never)))
      .toThrow(CrdtDecodeError);
  });
});
