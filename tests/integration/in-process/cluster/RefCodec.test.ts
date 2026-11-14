import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Actor } from '../../../../src/Actor.js';
import { AskResponseRef, Nobody } from '../../../../src/ActorRef.js';
import { AskTimeoutError } from '../../../../src/SystemMessages.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { RemoteActorRef } from '../../../../src/cluster/RemoteActorRef.js';
import {
  encodeRefs,
  decodeRefs,
  isWireActorRef,
  type WireActorRef,
} from '../../../../src/cluster/RefCodec.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { BidirectionalMap } from '../../../../src/util/BidirectionalMap.js';
import { BidirectionalMultiMap } from '../../../../src/util/BidirectionalMultiMap.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

class Noop extends Actor<unknown> { override onReceive(): void {} }

/** The per-path envelope-handler map `Cluster._registerEnvelopeHandler` writes to. */
type ClusterInternals = { readonly _envelopeHandlersByPath: Map<string, unknown> };

/**
 * Read that map directly, the same reach-into-privates shape
 * `tests/unit/devtools/ClusterFederation.test.ts` uses.
 *
 * The registration tests below it infer the entry's fate from the catch-all
 * handler, which is a fair proxy but one hop removed.  #765 turns on the map
 * itself not growing, so the #765 cases read the map.
 */
const envelopeHandlersOf = (cluster: Cluster): Map<string, unknown> =>
  (cluster as unknown as ClusterInternals)._envelopeHandlersByPath;

async function buildCluster(
  sysName: string,
  port: number,
): Promise<{ system: ActorSystem; cluster: Cluster }> {
  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(sysName, sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(sysName, 'h', port)))
    .withGossipIntervalMs(50);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster };
}

describe('RefCodec — encodeRefs', () => {
  let system: ActorSystem;
  let cluster: Cluster;

  beforeEach(async () => {
    ({ system, cluster } = await buildCluster('enc-test', 51_090));
  });

  afterEach(async () => {
    await cluster.leave();
    await system.terminate();
  });

  test('primitives pass through untouched', () => {
    expect(encodeRefs(42, cluster)).toBe(42);
    expect(encodeRefs('hello', cluster)).toBe('hello');
    expect(encodeRefs(true, cluster)).toBe(true);
    expect(encodeRefs(null, cluster)).toBe(null);
    expect(encodeRefs(undefined, cluster)).toBe(undefined);
  });

  test('non-ref objects recurse without interference', () => {
    const message = { kind: 'hello', n: 1, nested: { refA: [1, 2, 3] } };
    const encoded = encodeRefs(message, cluster);
    expect(encoded).toEqual(message);
  });

  test('top-level Nobody encodes to the nobody sentinel', () => {
    const encoded = encodeRefs(Nobody, cluster) as WireActorRef;
    expect(isWireActorRef(encoded)).toBe(true);
    expect(encoded.path).toBe('nobody');
    expect(encoded.host).toBeUndefined();
  });

  test('local refs carry the sender node address', () => {
    const ref = system.spawn(Noop, 'foo');
    const encoded = encodeRefs(ref, cluster) as WireActorRef;
    expect(isWireActorRef(encoded)).toBe(true);
    expect(encoded.path).toContain('foo');
    expect(encoded.host).toBe('h');
    expect(encoded.port).toBe(51_090);
    expect(encoded.system).toBe('enc-test');
  });

  test('already-remote refs keep their own target address, not the sender node', () => {
    const remote = new RemoteActorRef(
      new NodeAddress('other-sys', 'elsewhere', 9999),
      'actor-ts://other-sys/user/targetActor',
      cluster,
    );
    const encoded = encodeRefs(remote, cluster) as WireActorRef;
    expect(encoded.host).toBe('elsewhere');
    expect(encoded.port).toBe(9999);
    expect(encoded.system).toBe('other-sys');
    expect(encoded.path).toBe('actor-ts://other-sys/user/targetActor');
  });

  test('nested refs inside arrays and objects all get encoded', () => {
    const refA = system.spawn(Noop, 'a');
    const refB = system.spawn(Noop, 'b');
    const message = {
      kind: 'introduce',
      peers: [refA, refB],
      meta: { primary: refA },
      ignore: Nobody,
    };
    const encoded = encodeRefs(message, cluster) as Record<string, unknown>;
    expect(Array.isArray(encoded.peers)).toBe(true);
    const peers = encoded.peers as WireActorRef[];
    expect(peers).toHaveLength(2);
    expect(peers[0]!.path).toContain('a');
    expect(peers[1]!.path).toContain('b');
    expect(isWireActorRef((encoded.meta as Record<string, unknown>).primary)).toBe(true);
    expect((encoded.ignore as WireActorRef).path).toBe('nobody');
  });

  test('Date and Uint8Array pass through without being walked', () => {
    const decoder = new Date(1_700_000_000_000);
    const bytes = new Uint8Array([1, 2, 3]);
    const encoded = encodeRefs({ decoder, bytes }, cluster) as Record<string, unknown>;
    expect(encoded.decoder).toBe(decoder);
    expect(encoded.bytes).toBe(bytes);
  });

  // #450 — the walker used to end in a generic `Object.entries` rebuild, which
  // is destructive for every value whose data is not own-enumerable.  It ran
  // *before* the frame codec, so tagging these on the wire would have carried
  // a faithful copy of `{}`.
  test('values whose data is not own-enumerable pass through by reference', () => {
    const pattern = /^ab+c$/giu;
    const url = new URL('https://example.test/a?b=1');
    const failure = new Error('boom');
    const counters = new Int32Array([7, 8, 9]);
    const encoded = encodeRefs({ pattern, url, failure, counters }, cluster) as Record<string, unknown>;
    expect(encoded.pattern).toBe(pattern);
    expect(encoded.url).toBe(url);
    expect(encoded.failure).toBe(failure);
    expect(encoded.counters).toBe(counters);
  });

  test('the framework collections keep their class and their embedded refs', () => {
    const ref = system.spawn(Noop, 'collection-target');
    const oneToOne = new BidirectionalMap<string, unknown>([['a', ref]]);
    const manyToMany = new BidirectionalMultiMap<string, unknown>([['left', ref]]);
    const encoded = encodeRefs({ oneToOne, manyToMany }, cluster) as Record<string, unknown>;

    const encodedOneToOne = encoded.oneToOne as BidirectionalMap<string, unknown>;
    expect(encodedOneToOne).toBeInstanceOf(BidirectionalMap);
    expect(isWireActorRef(encodedOneToOne.get('a'))).toBe(true);

    const encodedManyToMany = encoded.manyToMany as BidirectionalMultiMap<string, unknown>;
    expect(encodedManyToMany).toBeInstanceOf(BidirectionalMultiMap);
    expect([...encodedManyToMany.get('left')].every((entry) => isWireActorRef(entry))).toBe(true);
  });

  test('cyclic structures do not infinite-loop (cycle replaced with null)', () => {
    const refA: Record<string, unknown> = { name: 'a' };
    const refB: Record<string, unknown> = { name: 'b', other: refA };
    refA.other = refB; // cycle
    const encoded = encodeRefs(refA, cluster) as Record<string, unknown>;
    expect(encoded.name).toBe('a');
    // the back-edge to an ancestor still on the current path becomes null
    expect(((encoded.other as Record<string, unknown>).other as unknown)).toBeNull();
  });

  // #517 — an ask-response ref is not an actor, so unless encoding registers
  // it the reply comes back addressed to something nothing can resolve.
  describe('ask-response refs (#517)', () => {
    test('encode to a named path under /temp, not the bare system root', () => {
      const ref = new AskResponseRef<string>('enc-test', 'askResp-0123456789ab', 0, 'target');
      const encoded = encodeRefs({ replyTo: ref }, cluster) as Record<string, unknown>;
      const wire = encoded.replyTo as WireActorRef;
      expect(wire.path).toBe('actor-ts://enc-test/temp/askResp-0123456789ab');
      expect(wire.host).toBe('h');
      expect(wire.port).toBe(51_090);
      expect(wire.system).toBe('enc-test');
    });

    test('encoding registers the ref, so a reply to that path reaches it', async () => {
      const ref = new AskResponseRef<string>('enc-test', 'askResp-aaaaaaaaaaaa', 0, 'target');
      const wire = (encodeRefs({ replyTo: ref }, cluster) as Record<string, unknown>).replyTo as WireActorRef;

      // Same path the replying node would address, arriving the same way.
      const remote = new RemoteActorRef<string>(cluster.selfAddress, wire.path, cluster);
      remote.tell('pong');

      expect(await ref.promise).toBe('pong');
    });

    test('settling drops the registration — the handler map does not grow per ask', async () => {
      const ref = new AskResponseRef<string>('enc-test', 'askResp-bbbbbbbbbbbb', 0, 'target');
      const wire = (encodeRefs({ replyTo: ref }, cluster) as Record<string, unknown>).replyTo as WireActorRef;

      // The catch-all only sees what no per-path registration claimed, which
      // makes it a direct read on whether the ask ref is still registered.
      const unrouted: unknown[] = [];
      cluster._setEnvelopeHandler((envelope) => { unrouted.push(envelope.body); });
      const loopback = new RemoteActorRef<string>(cluster.selfAddress, wire.path, cluster);

      loopback.tell('pong');
      expect(await ref.promise).toBe('pong');
      expect(unrouted).toEqual([]);

      loopback.tell('late');
      await awaitCondition(() => unrouted.length > 0, {
        label: 'the late reply falls through to the catch-all',
      });
      expect(unrouted).toEqual(['late']);
    });

    // #765 — the whole cross-node half of that issue rests on `_onSettled`
    // removing the entry, and until now nothing asserted on the map itself in
    // either direction.  These three do: two settle paths that must clear it,
    // and the one that cannot, which is why `ActorRef.ask` refuses a deadline
    // it could not arm a timer for.
    describe('teardown of the per-path registration (#765)', () => {
      const encodeAskRef = (ref: AskResponseRef<string>): string =>
        ((encodeRefs({ replyTo: ref }, cluster) as Record<string, unknown>).replyTo as WireActorRef).path;

      test('a reply drops the entry', async () => {
        const ref = new AskResponseRef<string>('enc-test', 'askResp-cccccccccccc', 1_000, 'target');
        const path = encodeAskRef(ref);
        const handlers = envelopeHandlersOf(cluster);
        expect(handlers.has(path)).toBe(true);

        new RemoteActorRef<string>(cluster.selfAddress, path, cluster).tell('pong');
        expect(await ref.promise).toBe('pong');
        expect(handlers.has(path)).toBe(false);
      });

      test('an expiring deadline drops the entry too — the only other settle path', async () => {
        const ref = new AskResponseRef<string>('enc-test', 'askResp-dddddddddddd', 20, 'target');
        const path = encodeAskRef(ref);
        const handlers = envelopeHandlersOf(cluster);
        expect(handlers.has(path)).toBe(true);

        let caught: unknown = null;
        try { await ref.promise; } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(AskTimeoutError);
        expect(handlers.has(path)).toBe(false);
      });

      test('a ref with no deadline keeps its entry — the leak ask() now refuses to create', async () => {
        // Stated against the primitive because `ActorRef.ask` no longer lets a
        // caller reach this state: a non-positive `timeoutMs` arms no timer, so
        // nothing runs the teardown and the entry outlives the ask.  Keeping the
        // negative case here is what makes the guard's reason legible from the
        // cluster side rather than only from the unit suite.
        const ref = new AskResponseRef<string>('enc-test', 'askResp-eeeeeeeeeeee', 0, 'target');
        const path = encodeAskRef(ref);
        const handlers = envelopeHandlersOf(cluster);
        expect(handlers.has(path)).toBe(true);

        // The elapsed time IS the assertion, so this cannot become an
        // `awaitCondition`: the claim is that the entry is still there after
        // time has passed, and there is no TTL sweep whose tick could be
        // polled for instead.
        await sleep(60);
        expect(handlers.has(path)).toBe(true);

        // Settle it by hand — the ref is otherwise immortal, and so is its entry.
        ref.tell('drain');
        expect(handlers.has(path)).toBe(false);
      });
    });
  });
});

describe('RefCodec — decodeRefs', () => {
  let system: ActorSystem;
  let cluster: Cluster;

  beforeEach(async () => {
    ({ system, cluster } = await buildCluster('dec-test', 51_200));
  });

  afterEach(async () => {
    await cluster.leave();
    await system.terminate();
  });

  test('nobody marker decodes to the Nobody ref', () => {
    const wire: WireActorRef = { $ref: 'actor', path: 'nobody' };
    expect(decodeRefs(wire, cluster)).toBe(Nobody);
  });

  test('marker pointing at a live local actor resolves to that local ref', () => {
    const local = system.spawn(Noop, 'target');
    const self = cluster.selfAddress;
    const wire: WireActorRef = {
      $ref: 'actor',
      path: local.path.toString(),
      host: self.host,
      port: self.port,
      system: self.systemName,
    };
    const decoded = decodeRefs(wire, cluster);
    expect(decoded).toBe(local);
  });

  test('marker pointing at a dead/unknown local path falls back to Nobody', () => {
    const self = cluster.selfAddress;
    const wire: WireActorRef = {
      $ref: 'actor',
      path: 'actor-ts://dec-test/user/does-not-exist',
      host: self.host,
      port: self.port,
      system: self.systemName,
    };
    expect(decodeRefs(wire, cluster)).toBe(Nobody);
  });

  test('marker pointing at a different node yields a RemoteActorRef', () => {
    const wire: WireActorRef = {
      $ref: 'actor',
      path: 'actor-ts://elsewhere/user/remote-actor',
      host: 'other-host',
      port: 9999,
      system: 'elsewhere',
    };
    const decoded = decodeRefs(wire, cluster);
    expect(decoded).toBeInstanceOf(RemoteActorRef);
    const ref = decoded as RemoteActorRef;
    expect(ref.targetNode.host).toBe('other-host');
    expect(ref.targetNode.port).toBe(9999);
    expect(ref.targetPath).toBe('actor-ts://elsewhere/user/remote-actor');
  });

  test('nested markers inside arrays and objects are all restored', () => {
    const local = system.spawn(Noop, 'nested-target');
    const self = cluster.selfAddress;
    const mkWire = (path: string): WireActorRef => ({
      $ref: 'actor', path, host: self.host, port: self.port, system: self.systemName,
    });
    const wireMessage = {
      kind: 'introduce',
      peers: [mkWire(local.path.toString()), { $ref: 'actor', path: 'nobody' }],
      meta: { primary: mkWire(local.path.toString()) },
    };
    const decoded = decodeRefs(wireMessage, cluster) as Record<string, unknown>;
    const peers = decoded.peers as unknown[];
    expect(peers[0]).toBe(local);
    expect(peers[1]).toBe(Nobody);
    expect((decoded.meta as Record<string, unknown>).primary).toBe(local);
  });

  // #450 — the decode direction was the lossier of the two: `walk` rebuilt a
  // `Map` as a `Map`, but `walkDecode` had no container branch at all, so
  // every collection that survived encode, the transport and the frame codec
  // was flattened to `{}` on arrival.
  test('containers survive the decode walk instead of flattening to {}', () => {
    const local = system.spawn(Noop, 'container-target');
    const self = cluster.selfAddress;
    const wire: WireActorRef = {
      $ref: 'actor',
      path: local.path.toString(),
      host: self.host,
      port: self.port,
      system: self.systemName,
    };
    const wireMessage = {
      byName: new Map<string, unknown>([['primary', wire]]),
      seen: new Set<unknown>([wire]),
      oneToOne: new BidirectionalMap<string, unknown>([['a', wire]]),
      manyToMany: new BidirectionalMultiMap<string, unknown>([['left', wire]]),
    };
    const decoded = decodeRefs(wireMessage, cluster) as Record<string, unknown>;

    const byName = decoded.byName as Map<string, unknown>;
    expect(byName).toBeInstanceOf(Map);
    expect(byName.get('primary')).toBe(local);

    const seen = decoded.seen as Set<unknown>;
    expect(seen).toBeInstanceOf(Set);
    expect([...seen]).toEqual([local]);

    const oneToOne = decoded.oneToOne as BidirectionalMap<string, unknown>;
    expect(oneToOne).toBeInstanceOf(BidirectionalMap);
    expect(oneToOne.get('a')).toBe(local);

    const manyToMany = decoded.manyToMany as BidirectionalMultiMap<string, unknown>;
    expect(manyToMany).toBeInstanceOf(BidirectionalMultiMap);
    expect([...manyToMany.get('left')]).toEqual([local]);
  });

  test('values whose data is not own-enumerable arrive intact', () => {
    const pattern = /^ab+c$/giu;
    const url = new URL('https://example.test/a?b=1');
    const counters = new Int32Array([7, 8, 9]);
    const decoded = decodeRefs({ pattern, url, counters }, cluster) as Record<string, unknown>;
    expect(decoded.pattern).toBe(pattern);
    expect(decoded.url).toBe(url);
    expect(decoded.counters).toBe(counters);
  });
});

describe('RefCodec — round-trip through JSON.stringify', () => {
  test('encoded refs survive JSON.stringify → JSON.parse and decode back', async () => {
    const { system, cluster } = await buildCluster('rt-test', 51_300);
    try {
      const local = system.spawn(Noop, 'rt-actor');
      const message = { kind: 'ping', replyTo: local, bag: [local, Nobody] };

      // Simulate the wire path: encode, JSON round-trip, decode.
      const encoded = encodeRefs(message, cluster);
      const json = JSON.stringify(encoded);
      const parsed = JSON.parse(json);
      const decoded = decodeRefs(parsed, cluster) as Record<string, unknown>;

      expect(decoded.kind).toBe('ping');
      expect(decoded.replyTo).toBe(local);
      const bag = decoded.bag as unknown[];
      expect(bag[0]).toBe(local);
      expect(bag[1]).toBe(Nobody);
    } finally {
      await cluster.leave();
      await system.terminate();
    }
  });

  test('a body field named __proto__ is copied as data on the way out, refs inside it included', async () => {
    // Any body built by `JSON.parse` can carry an own `__proto__` key.  The
    // decode side already keeps it as data; the encode side's copy has to as
    // well, or the field never reaches the frame.
    const { system, cluster } = await buildCluster('rt-proto-test', 51_310);
    try {
      const local = system.spawn(Noop, 'rt-proto-actor');
      const message: Record<string, unknown> = { kind: 'ping' };
      Object.defineProperty(message, '__proto__', {
        value: { note: 'data', replyTo: local }, enumerable: true, writable: true, configurable: true,
      });
      message.after = 1;

      const encoded = encodeRefs(message, cluster) as Record<string, unknown>;
      expect(Object.keys(encoded)).toEqual(['kind', '__proto__', 'after']);
      expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype);
      expect(encoded.note).toBeUndefined();
      const field = Object.getOwnPropertyDescriptor(encoded, '__proto__')?.value as Record<string, unknown>;
      expect(field.note).toBe('data');
      expect(isWireActorRef(field.replyTo)).toBe(true);

      const decoded = decodeRefs(JSON.parse(JSON.stringify(encoded)), cluster) as Record<string, unknown>;
      expect(Object.keys(decoded)).toEqual(['kind', '__proto__', 'after']);
      expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
      const decodedField = Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value as Record<string, unknown>;
      expect(decodedField.note).toBe('data');
      expect(decodedField.replyTo).toBe(local);
    } finally {
      await cluster.leave();
      await system.terminate();
    }
  });
});

/**
 * #946 — both walkers guarded against cycles with a `WeakSet` they only ever
 * added to.  That is visited-detection: it cannot tell "this object is its own
 * ancestor" from "this object appears twice in the tree", so the second
 * occurrence of every shared sub-object crossed the wire as `null`.  The guard
 * is now an ancestor set — a value is in it only while its subtree is being
 * walked — so a shared value arrives in every position and a genuine cycle is
 * still cut at its back-edge.
 */
describe('RefCodec — shared sub-objects are not cycles (#946)', () => {
  let system: ActorSystem;
  let cluster: Cluster;

  beforeEach(async () => {
    ({ system, cluster } = await buildCluster('share-test', 51_320));
  });

  afterEach(async () => {
    await cluster.leave();
    await system.terminate();
  });

  const shared = (): { id: string; n: number } => ({ id: 'S', n: 1 });

  test('encode keeps a shared object in two fields and twice in one array', () => {
    const value = shared();
    const encoded = encodeRefs({ a: value, b: value, list: [value, value] }, cluster);
    expect(encoded).toEqual({ a: value, b: value, list: [value, value] });
  });

  test('encode keeps a shared object as two Map values and as a member of two Sets', () => {
    const value = shared();
    const encoded = encodeRefs({
      map: new Map([['p', value], ['q', value]]),
      first: new Set([value]),
      second: new Set([value]),
    }, cluster) as { map: Map<string, unknown>; first: Set<unknown>; second: Set<unknown> };
    expect(encoded.map.get('p')).toEqual(value);
    expect(encoded.map.get('q')).toEqual(value);
    expect([...encoded.first]).toEqual([value]);
    expect([...encoded.second]).toEqual([value]);
  });

  test('a shared object holding a ref encodes the ref in every position', () => {
    const local = system.spawn(Noop, 'shared-target');
    const header = { replyTo: local };
    const encoded = encodeRefs({ first: header, second: header }, cluster) as Record<string, { replyTo: unknown }>;
    expect(isWireActorRef(encoded.first!.replyTo)).toBe(true);
    expect(isWireActorRef(encoded.second!.replyTo)).toBe(true);
    // And the ref itself, twice in one body, is a valid marker both times.
    const twice = encodeRefs({ x: local, y: local }, cluster) as Record<string, unknown>;
    expect(isWireActorRef(twice.x)).toBe(true);
    expect(twice.y).toEqual(twice.x);
  });

  test('decode keeps a shared object in two fields, twice in an array and as two Map values', () => {
    const value = shared();
    const decoded = decodeRefs({
      a: value, b: value, list: [value, value], map: new Map([['p', value], ['q', value]]),
    }, cluster) as { a: unknown; b: unknown; list: unknown[]; map: Map<string, unknown> };
    expect(decoded.a).toEqual(value);
    expect(decoded.b).toEqual(value);
    expect(decoded.list).toEqual([value, value]);
    expect(decoded.map.get('q')).toEqual(value);
  });

  test('a body with shared sub-objects round-trips encode → JSON → decode intact', () => {
    const local = system.spawn(Noop, 'shared-round-trip');
    const user = { name: 'u', inbox: local };
    const decoded = decodeRefs(
      JSON.parse(JSON.stringify(encodeRefs({ author: user, reviewer: user }, cluster))),
      cluster,
    ) as Record<string, { name: string; inbox: unknown }>;
    expect(decoded.author!.name).toBe('u');
    expect(decoded.reviewer!.name).toBe('u');
    expect(decoded.author!.inbox).toBe(local);
    expect(decoded.reviewer!.inbox).toBe(local);
  });

  test('a genuine cycle still terminates on both sides, cut at the back-edge', () => {
    const node: Record<string, unknown> = { name: 'cyc' };
    node.self = node;
    expect(encodeRefs(node, cluster)).toEqual({ name: 'cyc', self: null });
    expect(decodeRefs(node, cluster)).toEqual({ name: 'cyc', self: null });

    // A cycle through an array, with a shared sibling beside it: the sibling
    // survives in both places, the back-edge alone is cut.
    const value = shared();
    const list: unknown[] = [value];
    const root: Record<string, unknown> = { list, again: value };
    list.push(root);
    const encoded = encodeRefs(root, cluster) as { list: unknown[]; again: unknown };
    expect(encoded.again).toEqual(value);
    expect(encoded.list).toEqual([value, null]);
    const decoded = decodeRefs(root, cluster) as { list: unknown[]; again: unknown };
    expect(decoded.again).toEqual(value);
    expect(decoded.list).toEqual([value, null]);
  });
});
