import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { RemoteActorRef } from '../../../../src/cluster/RemoteActorRef.js';
import { decodeRefs, type WireActorRef } from '../../../../src/cluster/RefCodec.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';

/**
 * Regression cover for #515.
 *
 * `RemoteActorRef` used to build its path as `new ActorPath(lastSegment, null,
 * systemName)` — a *root*, which `ActorPath` renders as `actor-ts://<system>/`
 * with the name dropped.  So `.path` was the same address-less string for every
 * remote ref, and since `ActorRef.equals` compares `path.toString()`, any two
 * remote refs compared equal no matter what they pointed at.
 */

const NODE_A = new NodeAddress('remote-path-sys', 'host-a', 9001);
const NODE_B = new NodeAddress('remote-path-sys', 'host-b', 9002);

let system: ActorSystem;
let cluster: Cluster;

beforeAll(async () => {
  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  system = ActorSystem.create('remote-path-sys', sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(51_400)
    .withTransport(new InMemoryTransport(new NodeAddress('remote-path-sys', 'h', 51_400)))
    .withGossipIntervalMs(50);
  cluster = await Cluster.join(system, clusterOptions);
});

afterAll(async () => {
  await cluster.leave();
  await system.terminate();
});

const refTo = (node: NodeAddress, path: string): RemoteActorRef =>
  new RemoteActorRef(node, path, cluster);

describe('RemoteActorRef.path (#515)', () => {
  test('renders the target actor path, not a bare system root', () => {
    const ref = refTo(NODE_A, 'actor-ts://remote-path-sys/user/alpha');
    expect(ref.path.toString()).toBe('actor-ts://remote-path-sys/user/alpha');
  });

  test('round-trips an arbitrarily deep path', () => {
    const deep = 'actor-ts://remote-path-sys/user/parent/child/grandchild';
    expect(refTo(NODE_A, deep).path.toString()).toBe(deep);
  });

  test('exposes the real hierarchy, not one flattened segment', () => {
    const ref = refTo(NODE_A, 'actor-ts://remote-path-sys/user/parent/child');
    // Leading '' is the synthetic root that `render` skips.
    expect(ref.path.elements()).toEqual(['', 'user', 'parent', 'child']);
    expect(ref.path.name).toBe('child');
    expect(ref.path.parent?.name).toBe('parent');
  });

  test('a target with no segments stays a bare root instead of throwing', () => {
    // `parsePathSegments` yields [] here; the ref must still be constructible.
    const ref = refTo(NODE_A, 'actor-ts://remote-path-sys/');
    expect(ref.path.toString()).toBe('actor-ts://remote-path-sys/');
  });

  test('toString() keeps its node-qualified rendering', () => {
    const ref = refTo(NODE_A, 'actor-ts://remote-path-sys/user/alpha');
    expect(ref.toString()).toBe(`${NODE_A}actor-ts://remote-path-sys/user/alpha`);
  });
});

describe('RemoteActorRef.equals (#515)', () => {
  test('refs to different actors are no longer equal', () => {
    const alpha = refTo(NODE_A, 'actor-ts://remote-path-sys/user/alpha');
    const beta = refTo(NODE_A, 'actor-ts://remote-path-sys/user/beta');
    expect(alpha.equals(beta)).toBe(false);
    expect(beta.equals(alpha)).toBe(false);
  });

  test('refs to the same actor stay equal across separate instances', () => {
    const one = refTo(NODE_A, 'actor-ts://remote-path-sys/user/alpha');
    const two = refTo(NODE_A, 'actor-ts://remote-path-sys/user/alpha');
    expect(one).not.toBe(two);
    expect(one.equals(two)).toBe(true);
  });

  test('a sibling under a shared parent is distinguished', () => {
    const child = refTo(NODE_A, 'actor-ts://remote-path-sys/user/parent/child');
    const sibling = refTo(NODE_A, 'actor-ts://remote-path-sys/user/parent/sibling');
    expect(child.equals(sibling)).toBe(false);
  });

  test('KNOWN LIMITATION — the same path on two nodes still compares equal', () => {
    // `ActorPath` carries a system name but no host/port, and every member of a
    // cluster shares one system name — so the node cannot enter the comparison.
    // Closing this needs an authority on `ActorPath` itself; asserted here so
    // that a future fix has to change this expectation deliberately rather than
    // discovering it as a surprise.  `toString()` is the node-aware rendering.
    const onA = refTo(NODE_A, 'actor-ts://remote-path-sys/user/worker');
    const onB = refTo(NODE_B, 'actor-ts://remote-path-sys/user/worker');
    expect(onA.equals(onB)).toBe(true);
    expect(onA.toString()).not.toBe(onB.toString());
  });
});

describe('remote refs as map keys (#515)', () => {
  test('distinct remote refs no longer collapse onto one path key', () => {
    // The receptionist (`Receptionist.onRegister`) and the pub-sub mediator
    // (`DistributedPubSubMediator.onSubscribe`) both key their local maps on
    // `ref.path.toString()`.  Every remote entry used to land on the single key
    // `actor-ts://<sys>/`, so a second registrant silently replaced the first.
    const refs = [
      refTo(NODE_A, 'actor-ts://remote-path-sys/user/alpha'),
      refTo(NODE_A, 'actor-ts://remote-path-sys/user/beta'),
      refTo(NODE_B, 'actor-ts://remote-path-sys/user/gamma'),
    ];
    const byPath = new Map(refs.map((ref) => [ref.path.toString(), ref]));
    expect(byPath.size).toBe(3);
  });
});

describe('decoded wire refs carry an honest path (#515)', () => {
  test('a WireActorRef from another node decodes to a ref with the real path', () => {
    const wire: WireActorRef = {
      $ref: 'actor',
      path: 'actor-ts://remote-path-sys/user/service',
      host: 'elsewhere',
      port: 9999,
      system: 'remote-path-sys',
    };
    const decoded = decodeRefs(wire, cluster) as RemoteActorRef;
    expect(decoded).toBeInstanceOf(RemoteActorRef);
    expect(decoded.path.toString()).toBe('actor-ts://remote-path-sys/user/service');
  });
});
