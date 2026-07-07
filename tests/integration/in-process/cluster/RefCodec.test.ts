import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Actor } from '../../../../src/Actor.js';
import { Props } from '../../../../src/Props.js';
import { Nobody } from '../../../../src/ActorRef.js';
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

class Noop extends Actor<unknown> { override onReceive(): void {} }

async function buildCluster(
  sysName: string,
  port: number,
): Promise<{ system: ActorSystem; cluster: Cluster }> {
  const system = ActorSystem.create(sysName, ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
  const cluster = await Cluster.join(
    system,
    ClusterOptions.create()
      .withHost('h')
      .withPort(port)
      .withTransport(new InMemoryTransport(new NodeAddress(sysName, 'h', port)))
      .withGossipIntervalMs(50),
  );
  return { system, cluster };
}

describe('RefCodec — encodeRefs', () => {
  const from = new NodeAddress('sys', 'host', 1234);

  test('primitives pass through untouched', () => {
    expect(encodeRefs(42, from)).toBe(42);
    expect(encodeRefs('hello', from)).toBe('hello');
    expect(encodeRefs(true, from)).toBe(true);
    expect(encodeRefs(null, from)).toBe(null);
    expect(encodeRefs(undefined, from)).toBe(undefined);
  });

  test('non-ref objects recurse without interference', () => {
    const msg = { kind: 'hello', n: 1, nested: { a: [1, 2, 3] } };
    const encoded = encodeRefs(msg, from);
    expect(encoded).toEqual(msg);
  });

  test('top-level Nobody encodes to the nobody sentinel', () => {
    const encoded = encodeRefs(Nobody, from) as WireActorRef;
    expect(isWireActorRef(encoded)).toBe(true);
    expect(encoded.path).toBe('nobody');
    expect(encoded.host).toBeUndefined();
  });

  test('local refs carry the sender node address', async () => {
    const sys = ActorSystem.create('enc-local', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const ref = sys.spawn(Props.create(() => new Noop()), 'foo');
      const encoded = encodeRefs(ref, from) as WireActorRef;
      expect(isWireActorRef(encoded)).toBe(true);
      expect(encoded.path).toContain('foo');
      expect(encoded.host).toBe('host');
      expect(encoded.port).toBe(1234);
      expect(encoded.system).toBe('sys');
    } finally {
      await sys.terminate();
    }
  });

  test('already-remote refs keep their own target address, not the sender node', async () => {
    const { system, cluster } = await buildCluster('enc-remote', 51_100);
    try {
      const remote = new RemoteActorRef(
        new NodeAddress('other-sys', 'elsewhere', 9999),
        'actor-ts://other-sys/user/targetActor',
        cluster,
      );
      const encoded = encodeRefs(remote, from) as WireActorRef;
      expect(encoded.host).toBe('elsewhere');
      expect(encoded.port).toBe(9999);
      expect(encoded.system).toBe('other-sys');
      expect(encoded.path).toBe('actor-ts://other-sys/user/targetActor');
    } finally {
      await cluster.leave();
      await system.terminate();
    }
  });

  test('nested refs inside arrays and objects all get encoded', async () => {
    const sys = ActorSystem.create('enc-nested', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const a = sys.spawn(Props.create(() => new Noop()), 'a');
      const b = sys.spawn(Props.create(() => new Noop()), 'b');
      const msg = {
        kind: 'introduce',
        peers: [a, b],
        meta: { primary: a },
        ignore: Nobody,
      };
      const encoded = encodeRefs(msg, from) as Record<string, unknown>;
      expect(Array.isArray(encoded.peers)).toBe(true);
      const peers = encoded.peers as WireActorRef[];
      expect(peers).toHaveLength(2);
      expect(peers[0]!.path).toContain('a');
      expect(peers[1]!.path).toContain('b');
      expect(isWireActorRef((encoded.meta as Record<string, unknown>).primary)).toBe(true);
      expect((encoded.ignore as WireActorRef).path).toBe('nobody');
    } finally {
      await sys.terminate();
    }
  });

  test('Date and Uint8Array pass through without being walked', () => {
    const d = new Date(1_700_000_000_000);
    const bytes = new Uint8Array([1, 2, 3]);
    const encoded = encodeRefs({ d, bytes }, from) as Record<string, unknown>;
    expect(encoded.d).toBe(d);
    expect(encoded.bytes).toBe(bytes);
  });

  test('cyclic structures do not infinite-loop (cycle replaced with null)', () => {
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', other: a };
    a.other = b; // cycle
    const encoded = encodeRefs(a, from) as Record<string, unknown>;
    expect(encoded.name).toBe('a');
    // one side of the cycle gets nulled out once the other is in `seen`
    expect(((encoded.other as Record<string, unknown>).other as unknown)).toBeNull();
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
    const local = system.spawn(Props.create(() => new Noop()), 'target');
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
    const r = decoded as RemoteActorRef;
    expect(r.targetNode.host).toBe('other-host');
    expect(r.targetNode.port).toBe(9999);
    expect(r.targetPath).toBe('actor-ts://elsewhere/user/remote-actor');
  });

  test('nested markers inside arrays and objects are all restored', () => {
    const local = system.spawn(Props.create(() => new Noop()), 'nested-target');
    const self = cluster.selfAddress;
    const mkWire = (path: string): WireActorRef => ({
      $ref: 'actor', path, host: self.host, port: self.port, system: self.systemName,
    });
    const wireMsg = {
      kind: 'introduce',
      peers: [mkWire(local.path.toString()), { $ref: 'actor', path: 'nobody' }],
      meta: { primary: mkWire(local.path.toString()) },
    };
    const decoded = decodeRefs(wireMsg, cluster) as Record<string, unknown>;
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
      const local = system.spawn(Props.create(() => new Noop()), 'rt-actor');
      const msg = { kind: 'ping', replyTo: local, bag: [local, Nobody] };

      // Simulate the wire path: encode, JSON round-trip, decode.
      const encoded = encodeRefs(msg, cluster.selfAddress);
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
