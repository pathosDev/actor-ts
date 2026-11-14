/**
 * A ref marker that names the receiving node goes through the same trust
 * decision as an envelope's own target (#1572).
 *
 * `decodeSingleRef` used to resolve a same-node marker straight against the
 * actor tree.  `parsePathSegments` answers `[]` for anything that is not a full
 * `actor-ts://…` URI, and `_resolvePath([])` answers the root guardian, so a
 * bare `/user/x`, garbage or an empty path decoded to a live ref to the root
 * cell; a full `/system/…` URI decoded to that framework actor.  Every other
 * reader of a wire path refuses both — `dispatchEnvelope`, `RemoteWatcher`,
 * the receptionist — and none of them is bypassed by putting the path in a
 * body field instead of in `to`.
 *
 * The decoder now returns `Nobody` for an empty segment list, and asks
 * `EnvelopeTrust.refusalFor` before it walks the tree: a refused path decodes
 * to `Nobody` (never throws — a throw in the wire handler drops the peer's
 * connection) and is counted under `frame="ref"`, folded like every other
 * refusal and never carrying the body.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { Nobody } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import type { ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { EnvelopeTrust, type EnvelopeRefusalReason } from '../../../src/cluster/EnvelopeTrust.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { decodeRefs, type WireActorRef } from '../../../src/cluster/RefCodec.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MetricsExtensionId, metricsOf } from '../../../src/metrics/MetricsExtension.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];
const transports: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.shutdown().catch(() => {})));
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

class Recorder extends Actor<unknown> {
  constructor(private readonly seen: unknown[]) { super(); }

  override onReceive(message: unknown): void { this.seen.push(message); }
}

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
  readonly received: unknown[];
  readonly userPath: string;
  readonly frameworkPath: string;
};

const PEER = new NodeAddress('ref-trust-peer', 'h', 1);

async function startNode(name: string, port: number, options: Partial<ClusterOptionsType> = {}): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  // A real registry: the noop one's `value` is a constant 0.
  system.extension(MetricsExtensionId).enable();
  const received: unknown[] = [];
  const userRef = system.spawn(() => new Recorder(received), 'orders');
  const frameworkRef = system._spawnSystemActor(() => new Recorder([]), 'cluster', 'pretend-coordinator');
  const address = new NodeAddress(name, 'h', port);
  const clusterOptions = {
    host: 'h',
    port,
    transport: new InMemoryTransport(address),
    ...options,
  } as ClusterOptionsType;
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return {
    system, cluster, address, received,
    userPath: userRef.path.toString(),
    frameworkPath: frameworkRef.path.toString(),
  };
}

const marker = (node: Node, path: string): WireActorRef => ({
  $ref: 'actor',
  path,
  host: node.address.host,
  port: node.address.port,
  system: node.address.systemName,
});

const refusals = (node: Node, reason: EnvelopeRefusalReason, frame = 'ref'): number =>
  metricsOf(node.system).counter('cluster_envelope_refusals_total', { reason, frame }).value;

describe('decodeRefs — a same-node marker is checked before it is resolved (#1572)', () => {
  test('a bare, garbage or empty path decodes to Nobody, never to the root guardian', async () => {
    const node = await startNode('ref-trust-empty', 49_601);
    for (const path of ['/user/orders', 'garbage', '', `actor-ts://${node.address.systemName}`]) {
      expect(decodeRefs(marker(node, path), node.cluster, PEER)).toBe(Nobody);
    }
  });

  test('a /system path decodes to Nobody and is reported under frame="ref"', async () => {
    const node = await startNode('ref-trust-system', 49_603);
    expect(decodeRefs(marker(node, node.frameworkPath), node.cluster, PEER)).toBe(Nobody);
    expect(refusals(node, 'system-path')).toBe(1);
  });

  test('a full /user URI to a live actor still decodes to the local ref', async () => {
    const node = await startNode('ref-trust-user', 49_605);
    const decoded = decodeRefs(marker(node, node.userPath), node.cluster, PEER);
    expect(decoded).not.toBe(Nobody);
    expect(decoded).toBe(node.system._resolvePath(['user', 'orders']).getOrElse(Nobody));
    expect(refusals(node, 'system-path')).toBe(0);
  });

  test('untrusted-mode refuses a /user path off the allow-list and admits one on it', async () => {
    const refused = await startNode('ref-trust-untrusted', 49_607, { untrustedMode: true });
    expect(decodeRefs(marker(refused, refused.userPath), refused.cluster, PEER)).toBe(Nobody);
    expect(refusals(refused, 'not-allow-listed')).toBe(1);

    const admitted = await startNode('ref-trust-listed', 49_609, {
      untrustedMode: true,
      trustedSelectionPaths: ['/user/orders'],
    });
    expect(decodeRefs(marker(admitted, admitted.userPath), admitted.cluster, PEER)).not.toBe(Nobody);
    expect(refusals(admitted, 'not-allow-listed')).toBe(0);
  });
});

describe('a peer cannot hand the application a framework ref inside a body (#1572)', () => {
  test('the envelope is delivered, its /system replyTo arrives as Nobody, and the refusal is counted', async () => {
    const node = await startNode('ref-trust-wire', 49_611);
    const peer = new InMemoryTransport(PEER);
    peer.setHandler(() => {});
    await peer.start();
    transports.push(peer);

    peer.send(node.address, {
      kind: 'envelope',
      to: node.userPath,
      from: null,
      body: { kind: 'order', id: 7, replyTo: marker(node, node.frameworkPath), root: marker(node, '') },
    });

    await awaitCondition(() => node.received.length === 1, {
      timeoutMs: 4_000, label: 'the envelope reached the /user actor',
    });
    const body = node.received[0] as { kind: string; id: number; replyTo: unknown; root: unknown };
    expect(body.kind).toBe('order');
    expect(body.id).toBe(7);
    expect(body.replyTo).toBe(Nobody);
    expect(body.root).toBe(Nobody);
    expect(refusals(node, 'system-path')).toBe(1);
  });
});

/**
 * A path of exactly one segment names a guardian — `/user` is the only one the
 * `system-path` rule did not already cover — and a guardian is never an
 * application endpoint.  `actor-ts://<system>/user` used to resolve to the user
 * guardian itself, both as an envelope's `to` and as a body marker, and an
 * `untrusted-mode` entry `/user/*` admitted it too, because a subtree entry
 * admits its own root.
 */
describe('the bare /user guardian is not addressable by name (#1572)', () => {
  const trustFor = (untrustedMode: boolean, entries: readonly string[]): EnvelopeTrust => {
    const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const system = ActorSystem.create(`guardian-trust-${untrustedMode}-${entries.length}`, systemOptions);
    systems.push(system);
    return new EnvelopeTrust(system, new NoopLogger(), untrustedMode, entries);
  };

  test('refusalFor refuses ["user"] in every mode, an allow-listed subtree root included', () => {
    expect(trustFor(false, []).refusalFor(['user'])).toBe('guardian-path');
    expect(trustFor(true, ['/user/*']).refusalFor(['user'])).toBe('guardian-path');
    expect(trustFor(true, ['/user']).refusalFor(['user'])).toBe('guardian-path');
    // Its children are unaffected.
    expect(trustFor(false, []).refusalFor(['user', 'orders'])).toBeNull();
    expect(trustFor(true, ['/user/*']).refusalFor(['user', 'orders'])).toBeNull();
    // /system keeps its own, older reason.
    expect(trustFor(false, []).refusalFor(['system'])).toBe('system-path');
  });

  test('a same-node marker naming the guardian decodes to Nobody and is reported', async () => {
    const node = await startNode('guardian-marker', 49_621);
    const guardianPath = `actor-ts://${node.address.systemName}/user`;
    expect(decodeRefs(marker(node, guardianPath), node.cluster, PEER)).toBe(Nobody);
    expect(refusals(node, 'guardian-path')).toBe(1);
  });

  test('an envelope addressed to the guardian is refused before resolution, not delivered', async () => {
    const node = await startNode('guardian-envelope', 49_623);
    const peer = new InMemoryTransport(PEER);
    peer.setHandler(() => {});
    await peer.start();
    transports.push(peer);

    peer.send(node.address, {
      kind: 'envelope', to: `actor-ts://${node.address.systemName}/user`, from: null, body: 'to-the-guardian',
    });
    // A second envelope on the same connection, to a real actor, orders the
    // check: once it has arrived the first one has been dispatched.
    peer.send(node.address, { kind: 'envelope', to: node.userPath, from: null, body: 'to-orders' });
    await awaitCondition(() => node.received.length === 1, {
      timeoutMs: 4_000, label: 'the follow-up envelope reached /user/orders',
    });
    expect(node.received).toEqual(['to-orders']);
    expect(refusals(node, 'guardian-path', 'envelope')).toBe(1);
  });
});
