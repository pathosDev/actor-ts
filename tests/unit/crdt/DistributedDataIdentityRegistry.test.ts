/**
 * The per-key identity registry `DistributedDataActor` keeps (#766).
 *
 * `DistributedDataDecodeIdentity.test.ts` covers the decoders and the four
 * wire call sites — the half of #766 that says *what identity a frame is
 * decoded under*.  This file covers the bookkeeping around it: when the
 * registry is written, when it is read a second time, when it is dropped, and
 * what a repair is allowed to do on its way into the view.
 *
 * Each of these is a whole branch rather than a value, and each was removable
 * with the suite green — a guard, a fallback, a delete and a fan-out, all of
 * them arguing for themselves at length in their own JSDoc and none of them
 * asserted anywhere.
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
  GCounter,
  ORSet,
} from '../../../src/crdt/index.js';
import type { Crdt, CrdtIdentityFunction, ReplicaId } from '../../../src/crdt/index.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

type Item = { readonly sku: string; readonly price: number };

const BOOK_10: Item = { sku: 'book-1', price: 10 };
const BOOK_12: Item = { sku: 'book-1', price: 12 };
const COFFEE: Item = { sku: 'coffee-1', price: 4 };

const bySku = (item: Item): string => item.sku;
const cartFactory = (): ORSet<Item> => ORSet.empty<Item>({ identity: bySku });

/** The strict variant from the decode-identity suite: it refuses a shapeless element. */
const bySkuStrict = (item: Item): string => {
  if (typeof (item as { sku?: unknown } | null)?.sku !== 'string') {
    throw new TypeError(`cart element carries no sku: ${JSON.stringify(item)}`);
  }
  return item.sku;
};
const strictCartFactory = (): ORSet<Item> => ORSet.empty<Item>({ identity: bySkuStrict });

/** A peer-supplied element `bySkuStrict` cannot name. */
const SHAPELESS = { price: 7 } as unknown as Item;

/* ============================== fixtures ================================ */

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];
const transports: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.shutdown().catch(() => {})));
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

async function startNode(name: string, port: number): Promise<Cluster> {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return cluster;
}

/** A bare transport that speaks the wire under its own identity. */
async function peerTransport(name: string, port: number): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport(new NodeAddress(name, 'h', port));
  transport.setHandler(() => {});
  await transport.start();
  transports.push(transport);
  return transport;
}

/* ===================== the identity is learned once ===================== */

describe('learnIdentity — once per key', () => {
  test("the caller's factory is not invoked again once the key is known", async () => {
    // The guard's own doc makes the claim this asserts: "`update` for a key we
    // already know returns on the first line, so the common path costs a map
    // lookup and the caller's factory is not invoked a second time".  Without
    // it every `update` rebuilds a throwaway CRDT to ask it a question whose
    // answer is already in hand, and re-runs the encode/decode repair behind
    // it — on a key holding an element the callback refuses, that is also a
    // warning per update for the life of the key.
    let factoryInvocations = 0;
    const countingCartFactory = (): ORSet<Item> => {
      factoryInvocations++;
      return cartFactory();
    };

    const victim = await startNode('ddata-registry-a', 48_401);
    const data = victim.system.extension(DistributedDataId).start(victim);
    // A startup settle with no state to poll: `start()` registers the wire
    // handlers synchronously and buffers frames in the actor's mailbox until
    // `preStart` has run, so there is nothing observable to wait on here.
    await sleep(80);

    data.update<ORSet<Item>>('cart', countingCartFactory,
      (cart) => cart.add(data.selfReplicaId(), BOOK_10));
    await awaitCondition(() => data.get<ORSet<Item>>('cart') !== undefined, {
      label: 'the first update created the cart and taught its identity',
    });
    const afterFirstUpdate = factoryInvocations;

    data.update<ORSet<Item>>('cart', countingCartFactory,
      (cart) => cart.add(data.selfReplicaId(), COFFEE));
    await awaitCondition(() => (data.get<ORSet<Item>>('cart')?.size ?? 0) === 2, {
      label: 'the second update was applied to the existing cart',
    });

    expect(factoryInvocations).toBe(afterFirstUpdate);
  });
});

/* ============== a factory that cannot name an identity ================== */

/**
 * A CRDT whose `customIdentity` throws.
 *
 * The distinction the registry's try/catch turns on is not obvious, and it is
 * the reason a plainly-throwing *factory* would prove nothing here: that one
 * escapes anyway, from `onUpdate`'s own `factory()` call one line later, with
 * or without the catch.  Only a factory that **succeeds** and hands back a
 * value whose identity accessor throws isolates the branch — and it is the
 * realistic shape too, because the accessor is where an application's own
 * `Crdt` implementation gets to compute something.
 */
class UnnameableIdentityCounter implements Crdt<UnnameableIdentityCounter> {
  constructor(private readonly inner: GCounter = GCounter.empty()) {}

  merge(other: UnnameableIdentityCounter): UnnameableIdentityCounter {
    return new UnnameableIdentityCounter(this.inner.merge(other.inner));
  }

  toJSON(): unknown { return this.inner.toJSON(); }

  customIdentity(): CrdtIdentityFunction | undefined {
    throw new Error('this value cannot say what its identity is');
  }

  increment(replica: ReplicaId): UnnameableIdentityCounter {
    return new UnnameableIdentityCounter(this.inner.increment(replica, 1));
  }

  value(): number { return this.inner.value(); }
}

describe('learnIdentity — deriving the identity is allowed to fail', () => {
  test('an identity accessor that throws costs the update nothing', async () => {
    // A throw out of here is an actor failure, and twelve of those exhaust the
    // restart budget and terminate DistributedData for the life of the process
    // (#699, #721).  So the derivation is caught and the key simply stays on
    // the default dedup — the update itself still lands.
    const victim = await startNode('ddata-registry-b', 48_411);
    const data = victim.system.extension(DistributedDataId).start(victim);
    // The same startup settle as above.
    await sleep(80);

    data.update<UnnameableIdentityCounter>('hits', () => new UnnameableIdentityCounter(),
      (counter) => counter.increment(data.selfReplicaId()));
    await awaitCondition(() => data.get<UnnameableIdentityCounter>('hits')?.value() === 1, {
      label: 'the update was applied even though its identity could not be derived',
    });

    // And the actor is still the same one, still serving: an escape would have
    // failed it and lost this second update with the first.
    data.update<UnnameableIdentityCounter>('hits', () => new UnnameableIdentityCounter(),
      (counter) => counter.increment(data.selfReplicaId()));
    await awaitCondition(() => data.get<UnnameableIdentityCounter>('hits')?.value() === 2, {
      label: 'a later update on the same key is still served',
    });
  });
});

/* ================= a repair is a merge like any other =================== */

describe('repairKeying — a repair reaches the subscribers', () => {
  test('the collapse a repair performs is published, not written behind the view', async () => {
    // The method's doc argues the point at length: two entries the sender kept
    // apart can collapse into one, "and that has to reach the subscribers and
    // the durable record like any other merge would".  Writing the repaired
    // value straight into the view instead skips both, and every existing
    // assertion still passes, because the *next* thing that happens is the
    // update's own fan-out carrying the same collapsed value.
    const victim = await startNode('ddata-registry-c', 48_421);
    const data = victim.system.extension(DistributedDataId).start(victim);
    // The same startup settle as above.
    await sleep(80);

    const peer = await peerTransport('ddata-registry-peer-c', 48_422);
    peer.send(victim.selfAddress, {
      kind: 'ddata-gossip',
      from: new NodeAddress('ddata-registry-peer-c', 'h', 48_422).toJSON(),
      entries: {
        cart: ORSet.empty<Item>().add('peer', BOOK_10).add('peer', BOOK_12).toJSON(),
      },
    } as unknown as WireMessage);
    await awaitCondition(() => data.get<ORSet<Item>>('cart')?.size === 2, {
      label: "the peer's two prices for one SKU landed under JSON.stringify",
    });

    const publishedSizes: number[] = [];
    data.subscribe<ORSet<Item>>('cart', (cart) => publishedSizes.push(cart.size));
    expect(publishedSizes).toEqual([2]);

    data.update<ORSet<Item>>('cart', cartFactory,
      (cart) => cart.add(data.selfReplicaId(), COFFEE));
    await awaitCondition(
      () => (data.get<ORSet<Item>>('cart')?.value() ?? []).some((item) => item.sku === 'coffee-1'),
      { label: 'the local add was applied on top of the repaired cart' },
    );

    // Replay, then the repair collapsing two entries into one, then the add.
    // A repair written straight into the view shows up here as `[2, 2]`.
    expect(publishedSizes).toEqual([2, 1, 2]);
  });
});

/* ============ a delete takes the learned identity with it =============== */

describe('onDelete — the identity goes with the value', () => {
  test('a deleted key does not keep refusing frames under its old identity', async () => {
    // The registry is keyed by user key and nothing else prunes it, so a
    // delete that left the identity behind would both grow it without bound
    // and — the part that costs data — keep applying a rule to a key this
    // replica no longer holds.  A peer re-introducing that key gossips it
    // under whatever identity *it* has; the strict callback would refuse the
    // frame, `decodeOrDrop` would drop it, and the key would never come back.
    const victim = await startNode('ddata-registry-d', 48_431);
    const data = victim.system.extension(DistributedDataId).start(victim);
    // The same startup settle as above.
    await sleep(80);

    data.update<ORSet<Item>>('cart', strictCartFactory,
      (cart) => cart.add(data.selfReplicaId(), BOOK_12));
    await awaitCondition(() => data.get<ORSet<Item>>('cart') !== undefined, {
      label: 'the cart exists and `bySkuStrict` has been learned for it',
    });

    data.delete('cart');
    await awaitCondition(() => data.get<ORSet<Item>>('cart') === undefined, {
      label: 'the local cart was forgotten',
    });

    // Both entries travel in one frame, and the second is what makes this
    // assert rather than wait: entries are decoded in order, so a `canary`
    // that has landed proves the `cart` entry was already answered — dropped
    // or applied.
    const peer = await peerTransport('ddata-registry-peer-d', 48_432);
    peer.send(victim.selfAddress, {
      kind: 'ddata-gossip',
      from: new NodeAddress('ddata-registry-peer-d', 'h', 48_432).toJSON(),
      entries: {
        cart: ORSet.empty<Item>().add('peer', SHAPELESS).toJSON(),
        canary: GCounter.empty().increment('peer', 1).toJSON(),
      },
    } as unknown as WireMessage);
    await awaitCondition(() => data.get<GCounter>('canary') !== undefined, {
      label: "the follow-up entry was processed, so the peer's cart was too",
    });

    expect(data.get<ORSet<Item>>('cart')?.size).toBe(1);
  });
});
