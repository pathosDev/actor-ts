import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Actor } from '../../../../src/Actor.js';
import { AskResponseRef, Nobody } from '../../../../src/ActorRef.js';
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
import { awaitCondition } from '../../../util/AwaitCondition.js';

class Noop extends Actor<unknown> { override onReceive(): void {} }

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

  test('cyclic structures do not infinite-loop (cycle replaced with null)', () => {
    const refA: Record<string, unknown> = { name: 'a' };
    const refB: Record<string, unknown> = { name: 'b', other: refA };
    refA.other = refB; // cycle
    const encoded = encodeRefs(refA, cluster) as Record<string, unknown>;
    expect(encoded.name).toBe('a');
    // one side of the cycle gets nulled out once the other is in `seen`
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
});
