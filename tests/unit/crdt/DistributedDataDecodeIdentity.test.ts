/**
 * A custom `identity` survives the trip through a decoder (#766).
 *
 * The defect had two halves and the existing identity tests could see
 * neither, for the same reason: every one of them encodes *and* decodes with
 * the same custom identity, so the element key on the wire is already the key
 * the decoder wanted and nothing has to be re-filed.  The failing shape is
 * asymmetric — a value **encoded under the default identity** and **decoded
 * under a custom one** — which is exactly what a peer's gossip and a durable
 * record hand `DistributedData`, and what `CrdtProperties.test.ts`'s
 * round-trip never produces.
 *
 * So every decoder test below starts from `ORSet.empty<Item>()` — no options,
 * `JSON.stringify` keys — and asks the decoder for `identity: (i) => i.sku`.
 *
 * The other half is that `decodeCrdt` had no way to be told an identity at
 * all, and its four call sites — gossip, quorum write, quorum read, and the
 * durable load — therefore could not pass one.  The identity is derived from
 * the `factory` `update` already carries, so a key materialised *before* the
 * application first names it (a gossip that arrives first, a durable reload)
 * is re-keyed on that first `update`; the tests at the bottom drive both.
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
  DistributedDataOptions,
  DurableDistributedDataStore,
  GCounter,
  GCounterMap,
  GSet,
  LWWMap,
  ORMap,
  ORSet,
  decodeCrdt,
} from '../../../src/crdt/index.js';
import type {
  CrdtIdentityFunction, CrdtJson, ORMapJson, ORSetJson,
} from '../../../src/crdt/index.js';
import { CrdtDecodeError } from '../../../src/crdt/CrdtWireValidation.js';
import { InMemoryDurableStateStore } from '../../../src/persistence/durable-state-stores/InMemoryDurableStateStore.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

type Item = { readonly sku: string; readonly price: number };

const BOOK_10: Item = { sku: 'book-1', price: 10 };
const BOOK_12: Item = { sku: 'book-1', price: 12 };
const COFFEE: Item = { sku: 'coffee-1', price: 4 };

/** The documented cart-by-SKU pattern, and the one thing that was inert. */
const bySku = (item: Item): string => item.sku;
const cartFactory = (): ORSet<Item> => ORSet.empty<Item>({ identity: bySku });

/* ============ the accessor an identity is derived from ================== */

/**
 * `customIdentity()` is the only bridge from an application's factory to a
 * decoder — the function itself is a closure and cannot travel on the wire,
 * so `DistributedDataActor.learnIdentity` builds a fresh instance from the
 * factory and asks *it*.  An implementation that answered `undefined` would
 * put #766 straight back for that type, silently: the extension would file
 * every entry under `JSON.stringify` again and nothing downstream would
 * notice, because a value with no identity is exactly what a value that never
 * had one looks like.
 *
 * Only `ORSet`'s implementation was covered, and only indirectly, because
 * every extension-level test in this file drives an `ORSet`.  The consequence
 * of the accessor is a few blocks down, under `decodeCrdt`; these four
 * assertions pin the accessor itself, so a type that stops reporting its
 * identity fails here rather than in whichever integration test happens to
 * use it.
 */
describe('customIdentity — what learnIdentity reads off a factory', () => {
  test('GSet reports the configured function, and undefined on the default', () => {
    expect(GSet.empty<Item>({ identity: bySku }).customIdentity()).toBe(bySku);
    expect(GSet.empty<Item>().customIdentity()).toBeUndefined();
  });

  test('GCounterMap reports the configured function, and undefined on the default', () => {
    expect(GCounterMap.empty<Item>({ identity: bySku }).customIdentity()).toBe(bySku);
    expect(GCounterMap.empty<Item>().customIdentity()).toBeUndefined();
  });

  test('LWWMap reports the configured function, and undefined on the default', () => {
    expect(LWWMap.empty<Item, string>({ identity: bySku }).customIdentity()).toBe(bySku);
    expect(LWWMap.empty<Item, string>().customIdentity()).toBeUndefined();
  });

  test('ORMap reports the configured function, and undefined on the default', () => {
    expect(ORMap.empty<Item, GCounter>({ identity: bySku }).customIdentity()).toBe(bySku);
    expect(ORMap.empty<Item, GCounter>().customIdentity()).toBeUndefined();
  });
});

/* ==================== the four decoders re-key on the way in ============ */

describe('ORSet.fromJSON — files elements under the caller identity', () => {
  test("a default-identity frame decodes into the caller's dedup rule", () => {
    // The maintainer's reproduction on #766, verbatim.  Forwarding the option
    // to `fromJSON` is what the issue title asks for and is not sufficient on
    // its own: the decoded entry used to keep the sender's `JSON.stringify`
    // key, so the custom identity governed only *later* operations and the
    // element that came off the wire stayed a separate entry forever.
    const remote = ORSet.empty<Item>().add('peer', BOOK_10);
    const decoded = ORSet.fromJSON<Item>(remote.toJSON(), { identity: bySku });

    expect(decoded.add('local', BOOK_12).size).toBe(1);
    expect(decoded.has(BOOK_12)).toBe(true);
  });

  test('entries that collapse onto one key union their tags', () => {
    const remote = ORSet.empty<Item>().add('peer', BOOK_10).add('peer', BOOK_12);
    expect(Object.keys(remote.toJSON().elements)).toHaveLength(2);

    const decoded = ORSet.fromJSON<Item>(remote.toJSON(), { identity: bySku });
    expect(decoded.size).toBe(1);
    // Both of the sender's tags are on the surviving entry — dropping one
    // would make the element vanish on the first `remove` that only saw the
    // other, which is the OR-Set invariant the collapse must not break.
    expect(decoded.toJSON().elements['book-1']).toHaveLength(2);
    expect(decoded.remove(BOOK_10).has(BOOK_10)).toBe(false);
  });

  test('the entry already filed keeps its element instance', () => {
    // One SKU, two prices: the collapse has to pick an instance, and it keeps
    // the incumbent — the same preference `merge` states outright when it
    // writes `ours?.element ?? theirs?.element`.  Only the tags carry CRDT
    // meaning; the instance is what `value()` hands back, so the choice is
    // still observable and still a choice.
    const remote = ORSet.empty<Item>().add('peer', BOOK_10).add('peer', BOOK_12);
    const decoded = ORSet.fromJSON<Item>(remote.toJSON(), { identity: bySku });

    expect(decoded.size).toBe(1);
    expect(decoded.value()).toEqual([BOOK_10]);
  });

  test('two tombstone buckets that re-key together are unioned, not overwritten', () => {
    // One SKU under two prices, each removed and then re-added: on the wire
    // that is two element keys and two tombstone buckets, and under `bySku`
    // both collapse onto `book-1`.  Keeping one bucket and dropping the other
    // loses the veto on the dropped tag, and the next merge with a peer still
    // holding the pre-remove state brings that tag — and with it a removed
    // element — back from the dead.
    const before = ORSet.empty<Item>().add('peer', BOOK_10).add('peer', BOOK_12);
    const after = before
      .remove(BOOK_10).remove(BOOK_12)
      .add('peer', BOOK_10).add('peer', BOOK_12);
    expect(Object.keys(after.toJSON().tombstones)).toHaveLength(2);

    const decoded = ORSet.fromJSON<Item>(after.toJSON(), { identity: bySku });
    expect(decoded.toJSON().tombstones['book-1']).toHaveLength(2);

    // The slow peer re-offers both of the removed tags.  Both are vetoed, so
    // only the two re-add tags survive; a lost bucket shows up here as three.
    const stale = ORSet.fromJSON<Item>(before.toJSON(), { identity: bySku });
    expect(decoded.merge(stale).toJSON().elements['book-1']).toHaveLength(2);
  });

  test('a tombstone follows the element it belongs to across the re-key', () => {
    const first = ORSet.empty<Item>().add('peer', BOOK_10);
    const reAdded = first.remove(BOOK_10).add('peer', BOOK_10);
    const decoded = ORSet.fromJSON<Item>(reAdded.toJSON(), { identity: bySku });
    expect(Object.keys(decoded.toJSON().tombstones)).toEqual(['book-1']);

    // A slow peer still holding the pre-remove state re-offers the removed
    // tag.  The tombstone that travelled with the element is what refuses it;
    // left under the sender's key it would have vetoed nothing.
    const stale = ORSet.fromJSON<Item>(first.toJSON(), { identity: bySku });
    expect(decoded.merge(stale).toJSON().elements['book-1']).toHaveLength(1);
  });

  test('the default path is byte-identical to what it always was', () => {
    const set = ORSet.empty<string>().add('a', 'apple').add('b', 'banana')
      .remove('apple').add('c', 'apple');
    const json = set.toJSON();
    expect(ORSet.fromJSON<string>(json).toJSON()).toEqual(json);
  });

  test("a decoder given no identity leaves the sender's keys where they are", () => {
    // The re-key is deliberately conditional, and this is why: an element
    // moves to its new key, and a tombstone whose element was *removed* has
    // no instance left to move with it.  Re-keying unconditionally would
    // therefore separate a live tag from the tombstone that vetoes it, and a
    // removed element would come back — so a replica that was told no
    // identity files the sender's keys verbatim rather than imposing
    // `JSON.stringify` on a frame that was never written under it.
    const shared = ORSet.empty<Item>({ identity: bySku }).add('peer', BOOK_10);
    const removedThere = shared.remove(BOOK_10);

    const seenRemoved = ORSet.fromJSON<Item>(removedThere.toJSON());
    const seenStale = ORSet.fromJSON<Item>(shared.toJSON());
    expect(seenRemoved.merge(seenStale).size).toBe(0);
  });
});

describe('GCounterMap.fromJSON — files entries under the caller identity', () => {
  type Tag = { readonly name: string; readonly color: string };
  const byName = (tag: Tag): string => tag.name;

  test('collapsing entries merge their counters', () => {
    // Two replicas, because a grow-only counter merges componentwise by
    // maximum: two increments from one replica would collapse to 3, and the
    // test would then be asserting `Math.max` rather than the join.
    const remote = GCounterMap.empty<Tag>()
      .increment('peer-a', { name: 'urgent', color: 'red' }, 2)
      .increment('peer-b', { name: 'urgent', color: 'orange' }, 3);
    expect(remote.size).toBe(2);

    const decoded = GCounterMap.fromJSON<Tag>(remote.toJSON(), { identity: byName });
    expect(decoded.size).toBe(1);
    expect(decoded.value({ name: 'urgent', color: 'whatever' })).toBe(5);
  });

  test('the default path is byte-identical to what it always was', () => {
    const json = GCounterMap.empty<string>().increment('a', 'k1', 5).toJSON();
    expect(GCounterMap.fromJSON<string>(json).toJSON()).toEqual(json);
  });
});

describe('LWWMap.fromJSON — files entries under the caller identity', () => {
  type UserId = { readonly tenant: string; readonly id: string };
  const byTenantAndId = (user: UserId): string => `${user.tenant}:${user.id}`;

  test('collapsing entries merge their registers, newest write winning', () => {
    // The two literals differ only in property order, which `JSON.stringify`
    // preserves and the custom identity does not — the everyday way one
    // logical key arrives as two on the default dedup.
    const remote = LWWMap.empty<UserId, string>()
      .put('peer', { tenant: 'acme', id: '1' }, 'dark', 100)
      .put('peer', { id: '1', tenant: 'acme' }, 'light', 200);
    const other: UserId = { id: '1', tenant: 'acme' };
    expect(remote.size).toBe(2);

    const decoded = LWWMap.fromJSON<UserId, string>(remote.toJSON(), { identity: byTenantAndId });
    expect(decoded.size).toBe(1);
    expect(decoded.get(other)).toBe('light');
  });

  test('the register join, not the wire order, decides a collapse', () => {
    // The case above cannot tell a join from a plain overwrite: its newer
    // write is second on the wire, so last-wins and the join agree on
    // 'light'.  Reversing the frame — newer first, older second — separates
    // them, and it is the ordinary shape, because nothing orders a peer's
    // entries by timestamp.
    const remote = LWWMap.empty<UserId, string>()
      .put('peer', { id: '1', tenant: 'acme' }, 'light', 200)
      .put('peer', { tenant: 'acme', id: '1' }, 'dark', 100);
    expect(Object.keys(remote.toJSON().registers)).toHaveLength(2);

    const decoded = LWWMap.fromJSON<UserId, string>(remote.toJSON(), { identity: byTenantAndId });
    expect(decoded.size).toBe(1);
    expect(decoded.get({ tenant: 'acme', id: '1' })).toBe('light');
  });

  test('the default path is byte-identical to what it always was', () => {
    const json = LWWMap.empty<string, number>().put('a', 'theme', 1, 1_000).toJSON();
    expect(LWWMap.fromJSON<string, number>(json).toJSON()).toEqual(json);
  });
});

describe('ORMap.fromJSON — re-keys entries and keyset together', () => {
  type Tenant = { readonly id: string; readonly label: string };
  const byId = (tenant: Tenant): string => tenant.id;
  const decodeCounter = (inner: unknown): GCounter => GCounter.fromJSON(inner as never);

  test('membership, reads and writes all agree after the re-key', () => {
    const remote = ORMap.empty<Tenant, GCounter>()
      .put('peer', { id: 't-1', label: 'first' }, GCounter.empty().increment('peer', 3));
    const decoded = ORMap.fromJSON<Tenant, GCounter>(remote.toJSON(), decodeCounter, { identity: byId });

    // `keyset` indexes the same ids as `entries`; re-keying one without the
    // other leaves `has` consulting a membership set filed under ids that no
    // longer exist, which reads as "the key is gone".
    const sameTenant: Tenant = { id: 't-1', label: 'renamed' };
    expect(decoded.has(sameTenant)).toBe(true);
    expect(decoded.get(sameTenant)?.value()).toBe(3);
    expect(decoded.size).toBe(1);

    const grown = decoded.update('local', sameTenant, () => GCounter.empty(),
      (counter) => counter.increment('local', 4));
    expect(grown.size).toBe(1);
    expect(grown.get(sameTenant)?.value()).toBe(7);
  });

  test('a removed key stays removed across the re-key', () => {
    const remote = ORMap.empty<Tenant, GCounter>()
      .put('peer', { id: 't-1', label: 'first' }, GCounter.empty().increment('peer', 1))
      .remove({ id: 't-1', label: 'first' });
    const decoded = ORMap.fromJSON<Tenant, GCounter>(remote.toJSON(), decodeCounter, { identity: byId });

    expect(decoded.has({ id: 't-1', label: 'anything' })).toBe(false);
    expect(decoded.size).toBe(0);
  });

  test('inner CRDTs merge when two entry ids collapse onto one key', () => {
    // Two replicas, because a grow-only counter merges componentwise by
    // maximum: two increments from one replica would collapse to `Math.max`
    // and an overwrite would be indistinguishable from the join.
    const remote = ORMap.empty<Tenant, GCounter>()
      .put('peer-a', { id: 't-1', label: 'first' }, GCounter.empty().increment('peer-a', 2))
      .put('peer-b', { id: 't-1', label: 'second' }, GCounter.empty().increment('peer-b', 3));
    expect(Object.keys(remote.toJSON().values)).toHaveLength(2);

    const decoded = ORMap.fromJSON<Tenant, GCounter>(remote.toJSON(), decodeCounter, { identity: byId });
    expect(decoded.size).toBe(1);
    expect(decoded.get({ id: 't-1', label: 'either' })?.value()).toBe(5);
  });

  test('a keyset frame from a pre-elementValues peer still re-keys', () => {
    // `elementValues` is optional for backwards compat, which is why the remap
    // writes it for *every* element key rather than patching the ones the
    // sender supplied.  A v0 frame carries none, and `ORSet` would then fall
    // back to parsing the element key — the wire id, not the local one — so
    // the keyset would index ids `entries` no longer holds and `has` would
    // answer "gone" for a key plainly there.
    const frame = ORMap.empty<Tenant, GCounter>()
      .put('peer', { id: 't-1', label: 'first' }, GCounter.empty().increment('peer', 4))
      .toJSON();
    const legacyKeyset: ORSetJson = {
      kind: 'ORSet',
      elements: frame.keyset.elements,
      tombstones: frame.keyset.tombstones,
    };

    const decoded = ORMap.fromJSON<Tenant, GCounter>(
      { ...frame, keyset: legacyKeyset }, decodeCounter, { identity: byId },
    );
    const renamed: Tenant = { id: 't-1', label: 'renamed' };
    expect(decoded.has(renamed)).toBe(true);
    expect(decoded.get(renamed)?.value()).toBe(4);
  });

  test('a malformed keyset is reported by the decoder that owns it', () => {
    // The remap runs before `ORSet.fromJSON` gets a look at the frame, so it
    // has to survive a hostile `elements` on its own: unguarded,
    // `Object.keys(null)` throws a bare `TypeError` from inside a helper the
    // caller has never heard of.  Guarded, the frame passes through untouched
    // and `ORSet` names the field it rejected.  (An array or a string is
    // caught downstream either way — `null` is the half that carries the
    // guard, and the only one a JSON payload can actually express.)
    const frame = ORMap.empty<Tenant, GCounter>()
      .put('peer', { id: 't-1', label: 'first' }, GCounter.empty().increment('peer', 1))
      .toJSON();
    const hostile: ORMapJson = {
      ...frame,
      keyset: { ...frame.keyset, elements: null as unknown as Record<string, string[]> },
    };

    expect(() => ORMap.fromJSON<Tenant, GCounter>(hostile, decodeCounter, { identity: byId }))
      .toThrow(CrdtDecodeError);
  });

  test('a keyset element value that is not JSON does not throw out of the remap', () => {
    // The remap parses each element key back to the wire id it stands for.  A
    // value that will not parse is left exactly as it arrived, so the frame
    // reaches `ORSet` and is refused there, in words that name the field —
    // rather than as a `SyntaxError` raised while rewriting it.
    const frame = ORMap.empty<Tenant, GCounter>()
      .put('peer', { id: 't-1', label: 'first' }, GCounter.empty().increment('peer', 1))
      .toJSON();
    const hostile: ORMapJson = {
      ...frame,
      keyset: {
        kind: 'ORSet',
        elements: { 'bad-key': 'not-an-array' as unknown as string[] },
        elementValues: { 'bad-key': 'not json at all' },
        tombstones: {},
      },
    };

    let thrown: unknown;
    try {
      ORMap.fromJSON<Tenant, GCounter>(hostile, decodeCounter, { identity: byId });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(CrdtDecodeError);
    expect((thrown as Error).message).toContain("ORSet.elements['bad-key']");
  });

  test('the default path is byte-identical to what it always was', () => {
    const json = ORMap.empty<string, GCounter>()
      .put('a', 'k', GCounter.empty().increment('a', 1)).toJSON();
    expect(ORMap.fromJSON<string, GCounter>(json, decodeCounter).toJSON()).toEqual(json);
  });
});

/* ========================= decodeCrdt forwards it ======================= */

describe('decodeCrdt — the identity reaches every kind that has one', () => {
  test('an ORSet decoded through the dispatcher dedupes by the given identity', () => {
    const json = ORSet.empty<Item>().add('peer', BOOK_10).toJSON() as CrdtJson;

    const blind = decodeCrdt(json) as ORSet<Item>;
    expect(blind.add('local', BOOK_12).size).toBe(2);

    const told = decodeCrdt(json, bySku as CrdtIdentityFunction) as ORSet<Item>;
    expect(told.add('local', BOOK_12).size).toBe(1);
  });

  test('a GSet decoded through the dispatcher dedupes by the given identity', () => {
    const json = GSet.empty<Item>().add(BOOK_10).toJSON() as CrdtJson;

    expect((decodeCrdt(json) as GSet<Item>).add(BOOK_12).size).toBe(2);
    expect((decodeCrdt(json, bySku as CrdtIdentityFunction) as GSet<Item>).add(BOOK_12).size).toBe(1);
  });

  test('a GCounterMap decoded through the dispatcher files entries by the given identity', () => {
    const json = GCounterMap.empty<Item>()
      .increment('peer-a', BOOK_10, 2)
      .increment('peer-b', BOOK_12, 3)
      .toJSON() as CrdtJson;

    expect((decodeCrdt(json) as GCounterMap<Item>).size).toBe(2);
    const told = decodeCrdt(json, bySku as CrdtIdentityFunction) as GCounterMap<Item>;
    expect(told.size).toBe(1);
    expect(told.value(BOOK_12)).toBe(5);
  });

  test('an LWWMap decoded through the dispatcher files entries by the given identity', () => {
    const json = LWWMap.empty<Item, string>()
      .put('peer', BOOK_10, 'in-cart', 100)
      .put('peer', BOOK_12, 'wishlist', 200)
      .toJSON() as CrdtJson;

    expect((decodeCrdt(json) as LWWMap<Item, string>).size).toBe(2);
    const told = decodeCrdt(json, bySku as CrdtIdentityFunction) as LWWMap<Item, string>;
    expect(told.size).toBe(1);
    expect(told.get(BOOK_10)).toBe('wishlist');
  });

  test('an ORMap decoded through the dispatcher files entries by the given identity', () => {
    // A **two-field** key, deliberately.  With a single-field key the wire id
    // is already `JSON.stringify({ id })` — the very string the identity
    // answers — so nothing has to move and the assertion holds whether or not
    // the dispatcher forwards anything.
    type Tenant = { readonly id: string; readonly label: string };
    const json = ORMap.empty<Tenant, GCounter>()
      .put('peer', { id: 't-1', label: 'first' }, GCounter.empty().increment('peer', 3))
      .toJSON() as CrdtJson;
    const renamed: Tenant = { id: 't-1', label: 'renamed' };

    expect((decodeCrdt(json) as ORMap<Tenant, GCounter>).has(renamed)).toBe(false);
    const told = decodeCrdt(
      json, ((tenant: Tenant) => tenant.id) as CrdtIdentityFunction,
    ) as ORMap<Tenant, GCounter>;
    expect(told.has(renamed)).toBe(true);
    expect(told.get(renamed)?.value()).toBe(3);
  });

  test('a kind with no element identity ignores it', () => {
    const json = GCounter.empty().increment('peer', 4).toJSON() as CrdtJson;
    expect((decodeCrdt(json, bySku as CrdtIdentityFunction) as GCounter).value()).toBe(4);
  });

  test("the outer identity does not leak into an ORMap's nested values", () => {
    // An `ORMap<Tenant, ORSet<Item>>` keys its entries by tenant and its
    // inner sets by SKU — two different functions over two different types.
    // Passing the outer one down the recursion would file every item under
    // `item.id`, which is `undefined` for all of them, collapsing a whole
    // cart to a single entry.  The nested identity is not recoverable here
    // (nothing in the frame carries it, and an empty template has no inner
    // instance to read it from), so it stays on the default.
    type Tenant = { readonly id: string };
    const cart = ORSet.empty<Item>().add('peer', BOOK_10).add('peer', COFFEE);
    const outer = ORMap.empty<Tenant, ORSet<Item>>().put('peer', { id: 't-1' }, cart);

    const decoded = decodeCrdt(
      outer.toJSON() as CrdtJson,
      ((tenant: Tenant) => tenant.id) as CrdtIdentityFunction,
    ) as ORMap<Tenant, ORSet<Item>>;

    expect(decoded.get({ id: 't-1' })?.size).toBe(2);
  });
});

/* ===================== the extension's four call sites ================== */

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

/** A bare transport that speaks the wire under its own identity — as in `DistributedDataAuthority`. */
async function peerTransport(name: string, port: number): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport(new NodeAddress(name, 'h', port));
  transport.setHandler(() => {});
  await transport.start();
  transports.push(transport);
  return transport;
}

describe('DistributedData — a peer frame reaches the caller identity', () => {
  test('a key gossiped before the first local update is re-keyed by it', async () => {
    const victim = await startNode('ddata-identity-a', 48_301);
    const data = victim.system.extension(DistributedDataId).start(victim);
    // A startup settle with no state to poll: `start()` registers the wire
    // handlers synchronously and buffers frames in the actor's mailbox until
    // `preStart` has run, so there is nothing observable to wait on here.
    await sleep(80);

    const peer = await peerTransport('ddata-identity-peer-a', 48_302);
    peer.send(victim.selfAddress, {
      kind: 'ddata-gossip',
      from: new NodeAddress('ddata-identity-peer-a', 'h', 48_302).toJSON(),
      entries: { cart: ORSet.empty<Item>().add('peer', BOOK_10).toJSON() },
    } as unknown as WireMessage);
    await awaitCondition(() => data.get<ORSet<Item>>('cart') !== undefined, {
      label: "the peer's cart landed before any local update",
    });

    // Only now does the application say what the identity is — and it says it
    // the only way there is, through `update`'s factory.
    data.update<ORSet<Item>>('cart', cartFactory,
      (cart) => cart.add(data.selfReplicaId(), BOOK_12));
    await awaitCondition(
      () => (data.get<ORSet<Item>>('cart')?.value() ?? []).some((item) => item.price === 12),
      { label: 'the local add was applied on top of the gossiped cart' },
    );

    expect(data.get<ORSet<Item>>('cart')!.size).toBe(1);
  });

  test('a gossip frame arriving after the identity is known merges into one entry', async () => {
    const victim = await startNode('ddata-identity-b', 48_311);
    const data = victim.system.extension(DistributedDataId).start(victim);
    // The same startup settle — nothing observable to poll before the first
    // frame or the first update lands.
    await sleep(80);

    data.update<ORSet<Item>>('cart', cartFactory,
      (cart) => cart.add(data.selfReplicaId(), BOOK_10));
    await awaitCondition(() => data.get<ORSet<Item>>('cart') !== undefined, {
      label: 'the local cart exists and its identity has been learned',
    });
    const before = JSON.stringify(data.get<ORSet<Item>>('cart')!.toJSON());

    // A peer that does not know the identity — every peer, since it never
    // travels — gossips the same SKU at a different price.
    const peer = await peerTransport('ddata-identity-peer-b', 48_312);
    peer.send(victim.selfAddress, {
      kind: 'ddata-gossip',
      from: new NodeAddress('ddata-identity-peer-b', 'h', 48_312).toJSON(),
      entries: { cart: ORSet.empty<Item>().add('peer', BOOK_12).toJSON() },
    } as unknown as WireMessage);
    await awaitCondition(
      () => JSON.stringify(data.get<ORSet<Item>>('cart')!.toJSON()) !== before,
      { label: "the peer's frame was merged into the local cart" },
    );

    expect(data.get<ORSet<Item>>('cart')!.size).toBe(1);
    expect(data.get<ORSet<Item>>('cart')!.has(COFFEE)).toBe(false);
  });

  test('a map-shaped value is repaired by the same route as a set', async () => {
    // Every other extension test here drives an `ORSet`, so `ORSet` was the
    // only `customIdentity` implementation the whole chain — factory,
    // registry, dispatcher, decoder — ever ran end to end.  An `LWWMap` takes
    // exactly the same route: the gossip lands under `JSON.stringify`, the
    // first `update` names the identity, and the sender's two spellings of
    // one key collapse with their registers joined.
    type UserId = { readonly tenant: string; readonly id: string };
    const byTenantAndId = (user: UserId): string => `${user.tenant}:${user.id}`;
    const themesFactory = (): LWWMap<UserId, string> =>
      LWWMap.empty<UserId, string>({ identity: byTenantAndId });

    const victim = await startNode('ddata-identity-f', 48_341);
    const data = victim.system.extension(DistributedDataId).start(victim);
    // The same startup settle — see the first test in this block.
    await sleep(80);

    const peer = await peerTransport('ddata-identity-peer-f', 48_342);
    peer.send(victim.selfAddress, {
      kind: 'ddata-gossip',
      from: new NodeAddress('ddata-identity-peer-f', 'h', 48_342).toJSON(),
      entries: {
        themes: LWWMap.empty<UserId, string>()
          .put('peer', { tenant: 'acme', id: '1' }, 'dark', 100)
          .put('peer', { id: '1', tenant: 'acme' }, 'light', 200)
          .toJSON(),
      },
    } as unknown as WireMessage);
    await awaitCondition(() => data.get<LWWMap<UserId, string>>('themes')?.size === 2, {
      label: "the peer's two spellings of one key landed under JSON.stringify",
    });

    data.update<LWWMap<UserId, string>>('themes', themesFactory,
      (themes) => themes.put(data.selfReplicaId(), { tenant: 'acme', id: '2' }, 'dark', 300));
    await awaitCondition(
      () => data.get<LWWMap<UserId, string>>('themes')!.has({ tenant: 'acme', id: '2' }),
      { label: 'the local write landed on the repaired map' },
    );

    const themes = data.get<LWWMap<UserId, string>>('themes')!;
    expect(themes.size).toBe(2);
    expect(themes.get({ tenant: 'acme', id: '1' })).toBe('light');
  });

  test('a quorum write-request is decoded under the same identity as gossip', async () => {
    const victim = await startNode('ddata-identity-c', 48_321);
    const data = victim.system.extension(DistributedDataId).start(victim);
    // The same startup settle — see the first test in this block.
    await sleep(80);

    data.update<ORSet<Item>>('cart', cartFactory,
      (cart) => cart.add(data.selfReplicaId(), BOOK_10));
    await awaitCondition(() => data.get<ORSet<Item>>('cart') !== undefined, {
      label: 'the local cart exists and its identity has been learned',
    });
    const before = JSON.stringify(data.get<ORSet<Item>>('cart')!.toJSON());

    const peer = await peerTransport('ddata-identity-peer-c', 48_322);
    peer.send(victim.selfAddress, {
      kind: 'ddata-write-request',
      from: new NodeAddress('ddata-identity-peer-c', 'h', 48_322).toJSON(),
      pendingId: 'pending-1',
      key: 'cart',
      value: ORSet.empty<Item>().add('peer', BOOK_12).toJSON(),
    } as unknown as WireMessage);
    await awaitCondition(
      () => JSON.stringify(data.get<ORSet<Item>>('cart')!.toJSON()) !== before,
      { label: "the peer's quorum write was merged into the local cart" },
    );

    expect(data.get<ORSet<Item>>('cart')!.size).toBe(1);
  });
});

/* ============================ the durable path ========================== */

describe('DurableDistributedDataStore.load — decodes under a supplied identity', () => {
  test('a record written on the default identity is re-keyed when the caller says so', async () => {
    const store = new InMemoryDurableStateStore();
    const view = new Map([['cart', ORSet.empty<Item>().add('replica-a', BOOK_10)]]);
    await new DurableDistributedDataStore(store, 'replica-a').save(view as never);

    const blind = await new DurableDistributedDataStore(store, 'replica-a').load();
    expect((blind.get('cart') as ORSet<Item>).add('replica-a', BOOK_12).size).toBe(2);

    const told = await new DurableDistributedDataStore(store, 'replica-a')
      .load((key) => (key === 'cart' ? (bySku as CrdtIdentityFunction) : undefined));
    expect((told.get('cart') as ORSet<Item>).add('replica-a', BOOK_12).size).toBe(1);
  });
});

describe('DistributedData — a durable reload keeps the caller identity', () => {
  test('a reloaded key dedupes by SKU again on the first update after the restart', async () => {
    const durable = new InMemoryDurableStateStore();
    const options = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableStore(durable);

    const first = await startNode('ddata-identity-durable', 75_401);
    const dataFirst = first.system.extension(DistributedDataId).start(first, options);
    dataFirst.update<ORSet<Item>>('cart', cartFactory,
      (cart) => cart.add(dataFirst.selfReplicaId(), BOOK_10));
    await awaitCondition(
      async () => (await durable.load(`ddata|${dataFirst.selfReplicaId()}`)).isSome(),
      { label: 'the pre-restart cart reached the durable store', timeoutMs: 3_000 },
    );
    await first.leave();
    await first.system.terminate();
    clusters.length = 0;
    systems.length = 0;

    // Same address, so the restarted replica reads the same durable record.
    // Nothing in that record says how its elements deduplicate — an identity
    // is a closure — so the reload decodes blind and the first `update` is
    // what puts it right.
    const second = await startNode('ddata-identity-durable', 75_401);
    const dataSecond = second.system.extension(DistributedDataId).start(second, options);
    await awaitCondition(() => dataSecond.get<ORSet<Item>>('cart') !== undefined, {
      label: 'the restarted replica loaded its durable view',
    });

    dataSecond.update<ORSet<Item>>('cart', cartFactory,
      (cart) => cart.add(dataSecond.selfReplicaId(), BOOK_12));
    await awaitCondition(
      () => (dataSecond.get<ORSet<Item>>('cart')?.value() ?? []).some((item) => item.price === 12),
      { label: 'the post-restart add was applied' },
    );

    expect(dataSecond.get<ORSet<Item>>('cart')!.size).toBe(1);
  }, 10_000);
});

/* ============ an element the identity refuses must not unlearn it ======= */

/**
 * The realistic shape of an application identity: it asserts the shape it was
 * written for.  #766's own note says the callback now runs over peer-supplied
 * values, so this is the callback meeting the input this subsystem exists to
 * survive — an element of a shape the application never produced.
 */
const bySkuStrict = (item: Item): string => {
  if (typeof (item as { sku?: unknown } | null)?.sku !== 'string') {
    throw new TypeError(`cart element carries no sku: ${JSON.stringify(item)}`);
  }
  return item.sku;
};
const strictCartFactory = (): ORSet<Item> => ORSet.empty<Item>({ identity: bySkuStrict });

/** A peer-supplied element `bySkuStrict` cannot name. */
const SHAPELESS = { price: 7 } as unknown as Item;

describe('DistributedData — an element the identity refuses keeps the identity', () => {
  test('a peer element that makes the callback throw does not unlearn the key', async () => {
    const victim = await startNode('ddata-identity-e', 48_331);
    const data = victim.system.extension(DistributedDataId).start(victim);
    // The same startup settle as the block above — nothing observable to poll
    // before the first frame lands.
    await sleep(80);

    // The frame arrives before any local update, so it decodes on the default
    // identity and the shapeless element enters the view unexamined.  That is
    // the only way in: once the identity is known, `decodeOrDrop` refuses a
    // frame the callback throws on.
    const peer = await peerTransport('ddata-identity-peer-e', 48_332);
    peer.send(victim.selfAddress, {
      kind: 'ddata-gossip',
      from: new NodeAddress('ddata-identity-peer-e', 'h', 48_332).toJSON(),
      entries: { cart: ORSet.empty<Item>().add('peer', SHAPELESS).toJSON() },
    } as unknown as WireMessage);
    await awaitCondition(() => data.get<ORSet<Item>>('cart') !== undefined, {
      label: "the peer's shapeless element landed before any local update",
    });

    // Two updates, and the second is the point.  The first is what teaches the
    // identity, and it is the one that trips over the shapeless element while
    // re-keying the value already in the view.  The second proves the trip did
    // not cost the key its identity: both books share a SKU, so under the
    // configured rule they are one entry and under `JSON.stringify` they are
    // two.
    data.update<ORSet<Item>>('cart', strictCartFactory,
      (cart) => cart.add(data.selfReplicaId(), BOOK_10));
    await awaitCondition(
      () => (data.get<ORSet<Item>>('cart')?.value() ?? []).some((item) => item?.price === 10),
      { label: 'the first local add was applied' },
    );
    data.update<ORSet<Item>>('cart', strictCartFactory,
      (cart) => cart.add(data.selfReplicaId(), BOOK_12));
    await awaitCondition(
      () => (data.get<ORSet<Item>>('cart')?.value() ?? []).some((item) => item?.price === 12),
      { label: 'the second local add was applied' },
    );

    const cart = data.get<ORSet<Item>>('cart')!;
    expect(cart.value().filter((item) => item?.sku === 'book-1')).toHaveLength(1);
    // Nothing was dropped to get there: the element that could not be re-keyed
    // is still in the set, under the key it arrived with.
    expect(cart.value().some((item) => item?.price === 7)).toBe(true);
    expect(cart.size).toBe(2);
  });
});
