/**
 * Which peer-supplied paths a node resolves by name (#877, #964).
 *
 * `Cluster.dispatchEnvelope` step 2 is the one place a remote party names its
 * own target: the frame carries a `to` string and the node hands it to
 * `ActorSystem._resolvePath`, which walks from the **root** cell with no
 * guardian scope.  `/system/…` therefore resolved exactly like `/user/…`, and
 * every framework actor — shard coordinators, regions, singleton managers, the
 * pub-sub mediator, both DevTools lanes — was addressable by anyone who
 * completed a `hello`.
 *
 * Two things are pinned here, and they are deliberately not the same thing:
 *
 *  - the `/system` block is **unconditional**, because a switch defaulted off
 *    would leave #964 open on every deployment that did not opt in;
 *  - `remote.untrusted-mode` narrows the `/user` half to an allow-list, which
 *    is an operator's decision about their own topology and defaults to the
 *    open behaviour every existing cluster relies on.
 *
 * Driven through the real `handleWire` → `onEnvelope` → `dispatchEnvelope`
 * path with a bare `InMemoryTransport` for a peer, which is the shape #964's
 * own reproduction takes: from `send` onwards nothing here is a stub.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions, ClusterOptionsValidator } from '../../../src/cluster/ClusterOptions.js';
import type { ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { EnvelopeTrust } from '../../../src/cluster/EnvelopeTrust.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MetricsExtensionId, metricsOf } from '../../../src/metrics/MetricsExtension.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];
const transports: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.shutdown().catch(() => {})));
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

/** Records every body it was told, so "never arrived" is assertable. */
class Recorder extends Actor<string> {
  constructor(private readonly seen: string[]) { super(); }

  override onReceive(message: string): void { this.seen.push(message); }
}

const address = (name: string, port: number): NodeAddress => new NodeAddress(name, 'h', port);

type Node = {
  readonly cluster: Cluster;
  readonly system: ActorSystem;
  /** Everything the `/user` actor received. */
  readonly user: string[];
  /** Everything the `/system` actor received. */
  readonly framework: string[];
  readonly userPath: string;
  readonly frameworkPath: string;
};

async function startNode(
  name: string,
  port: number,
  options: Partial<ClusterOptionsType> = {},
): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  // A real registry: the noop one's `value` is a constant 0, so a counter
  // assertion against it would pass whatever the code did.
  system.extension(MetricsExtensionId).enable();
  const user: string[] = [];
  const framework: string[] = [];
  const userRef = system.spawn(() => new Recorder(user), 'orders');
  // Spawned where the framework's own actors live, through the same internal
  // entry point they use — the point is a real `/system/…` path in this
  // system's tree, not a string that looks like one.
  const frameworkRef = system._spawnSystemActor(
    () => new Recorder(framework),
    'cluster',
    'pretend-coordinator',
  );
  const clusterOptions = {
    host: 'h',
    port,
    transport: new InMemoryTransport(address(name, port)),
    ...options,
  } as ClusterOptionsType;
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return {
    cluster,
    system,
    user,
    framework,
    userPath: userRef.path.toString(),
    frameworkPath: frameworkRef.path.toString(),
  };
}

/** A bare transport that speaks the wire under its own identity. */
async function peer(name: string, port: number): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport(address(name, port));
  transport.setHandler(() => {});
  await transport.start();
  transports.push(transport);
  return transport;
}

const sendEnvelope = (
  from: InMemoryTransport,
  to: NodeAddress,
  path: string,
  body: string,
): void => {
  from.send(to, { kind: 'envelope', to: path, from: null, body });
};

const refusals = (
  node: Node,
  reason: 'system-path' | 'not-allow-listed',
  frame = 'envelope',
): number => metricsOf(node.system)
  .counter('cluster_envelope_refusals_total', { reason, frame }).value;

describe('the /system subtree is not reachable by name, in either mode (#964)', () => {
  test('a /system path is refused while a /user path in the same stream is not', async () => {
    // Both frames, on one connection, in order: the delivered one is what
    // proves the refusal was about the *path* and not about the harness.
    const node = await startNode('untrusted-system-off', 49_301);
    const sender = await peer('untrusted-system-off-peer', 49_302);
    const target = address('untrusted-system-off', 49_301);

    sendEnvelope(sender, target, node.frameworkPath, 'to-framework');
    sendEnvelope(sender, target, node.userPath, 'to-user');

    await awaitCondition(() => node.user.length === 1, {
      timeoutMs: 4_000,
      label: 'the /user frame was delivered',
    });
    expect(node.framework).toEqual([]);
    expect(refusals(node, 'system-path')).toBe(1);
    // Not the other reason: untrusted mode is off here, so nothing was
    // measured against the allow-list at all.
    expect(refusals(node, 'not-allow-listed')).toBe(0);
  });

  test('the guardian is matched as a segment, so a user actor named systemish still resolves', async () => {
    // The string-prefix trap, from the other direction: `startsWith('system')`
    // would refuse `/user/systemish`, which is an application's own actor.
    const node = await startNode('untrusted-system-segment', 49_303);
    const sender = await peer('untrusted-system-segment-peer', 49_304);
    const seen: string[] = [];
    const ref = node.system.spawn(() => new Recorder(seen), 'systemish');

    sendEnvelope(sender, address('untrusted-system-segment', 49_303), ref.path.toString(), 'ok');

    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the lookalike /user actor was delivered to',
    });
    expect(refusals(node, 'system-path')).toBe(0);
  });
});

describe('remote.untrusted-mode narrows the /user half to an allow-list (#877)', () => {
  test('off, any /user actor is still addressable by name', async () => {
    // The default has to be "no change": a RemoteActorRef rebuilt from a
    // WireActorRef names an arbitrary user path, and that is how a ref works
    // across nodes at all.
    const node = await startNode('untrusted-off', 49_311);
    const sender = await peer('untrusted-off-peer', 49_312);

    sendEnvelope(sender, address('untrusted-off', 49_311), node.userPath, 'hello');

    await awaitCondition(() => node.user.length === 1, {
      timeoutMs: 4_000,
      label: 'the unlisted /user frame was delivered with the mode off',
    });
    expect(refusals(node, 'not-allow-listed')).toBe(0);
  });

  test('on with an empty list, the same frame is refused and the actor never sees it', async () => {
    const node = await startNode('untrusted-on', 49_313, { untrustedMode: true });
    const sender = await peer('untrusted-on-peer', 49_314);

    sendEnvelope(sender, address('untrusted-on', 49_313), node.userPath, 'hello');

    await awaitCondition(() => refusals(node, 'not-allow-listed') === 1, {
      timeoutMs: 4_000,
      label: 'the unlisted frame was counted as refused',
    });
    expect(node.user).toEqual([]);
  });

  test('on, an exactly-listed path is delivered', async () => {
    const node = await startNode('untrusted-exact', 49_315, {
      untrustedMode: true,
      trustedSelectionPaths: ['/user/orders'],
    });
    const sender = await peer('untrusted-exact-peer', 49_316);

    sendEnvelope(sender, address('untrusted-exact', 49_315), node.userPath, 'hello');

    await awaitCondition(() => node.user.length === 1, {
      timeoutMs: 4_000,
      label: 'the allow-listed frame was delivered',
    });
    expect(refusals(node, 'not-allow-listed')).toBe(0);
  });

  test('on, an exact entry does not admit the children below it', async () => {
    // The half that makes `/*` mean something: if an exact entry were treated
    // as a prefix there would be no way to list one actor.
    const node = await startNode('untrusted-exact-child', 49_317, {
      untrustedMode: true,
      trustedSelectionPaths: ['/user/orders'],
    });
    const sender = await peer('untrusted-exact-child-peer', 49_318);
    const seen: string[] = [];
    node.system.spawn(() => new Recorder(seen), 'orders-child-holder');

    sendEnvelope(
      sender,
      address('untrusted-exact-child', 49_317),
      `${node.userPath}/child`,
      'hello',
    );

    await awaitCondition(() => refusals(node, 'not-allow-listed') === 1, {
      timeoutMs: 4_000,
      label: 'the child of an exactly-listed path was refused',
    });
    expect(node.user).toEqual([]);
  });

  test('on, the registered per-path handlers keep working', async () => {
    // The mode gates step 2 and nothing else.  Gating step 1 would take
    // sharding, singletons, pub-sub, DistributedData and both DevTools lanes
    // down with it — and those endpoints are reached through the door that
    // attaches the connection's identity to the frame, which is the door this
    // whole change is pushing traffic towards.
    const node = await startNode('untrusted-handlers', 49_319, { untrustedMode: true });
    const sender = await peer('untrusted-handlers-peer', 49_320);
    const seen: string[] = [];
    node.cluster._registerEnvelopeHandler(
      '/cluster/pretend-extension',
      (envelope) => { seen.push(String(envelope.body)); },
    );

    sendEnvelope(
      sender,
      address('untrusted-handlers', 49_319),
      '/cluster/pretend-extension',
      'framework-traffic',
    );

    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the registered handler still received its frame under the mode',
    });
    expect(refusals(node, 'not-allow-listed')).toBe(0);
    expect(refusals(node, 'system-path')).toBe(0);
  });
});

/* ------------------------- the matching semantics ------------------------ */

/**
 * Pinned directly rather than only through the wire, because this table is the
 * precedent `remote.large-message-destinations` inherits (#846) — the
 * project's answer to "exact, prefix or glob" lives here, and a change to it is
 * a change to two config keys.
 */
describe('trusted-selection-paths matching', () => {
  const trustFor = (entries: readonly string[]): EnvelopeTrust => {
    const system = ActorSystem.create(
      `trust-${entries.length}-${Math.random().toString(36).slice(2)}`,
      ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
    );
    systems.push(system);
    return new EnvelopeTrust(system, new NoopLogger(), true, entries);
  };
  const segmentsOf = (path: string): string[] => path.split('/').filter((s) => s.length > 0);

  test.each([
    ['an exact entry admits exactly that path', ['/user/orders'], '/user/orders', true],
    ['an exact entry refuses a child', ['/user/orders'], '/user/orders/7', false],
    ['a subtree entry admits its own path', ['/user/orders/*'], '/user/orders', true],
    ['a subtree entry admits a child', ['/user/orders/*'], '/user/orders/7', true],
    ['a subtree entry admits a grandchild', ['/user/orders/*'], '/user/orders/7/lines', true],
    // The one that makes a naive `startsWith` allow-list worse than none.
    ['a subtree entry is segment-anchored', ['/user/orders/*'], '/user/orders-archive', false],
    ['the leading slash is optional', ['user/orders'], '/user/orders', true],
    ['a trailing slash is ignored', ['/user/orders/'], '/user/orders', true],
    ['any one entry is enough', ['/user/a', '/user/b'], '/user/b', true],
    ['an empty list admits nothing', [], '/user/orders', false],
  ])('%s', (_case, entries, path, admitted) => {
    expect(trustFor(entries).refusalFor(segmentsOf(path)))
      .toBe(admitted ? null : 'not-allow-listed');
  });

  test('the allow-list never reaches /system, whatever it lists', () => {
    // An operator cannot opt back into the reachability #964 closed, not even
    // by naming the path — the two rules are ordered, not alternatives.
    expect(trustFor(['/system/*']).refusalFor(['system', 'cluster', 'x'])).toBe('system-path');
    expect(trustFor(['/system/cluster/x']).refusalFor(['system', 'cluster', 'x']))
      .toBe('system-path');
  });
});

describe('ClusterOptionsValidator rejects an allow-list entry that cannot mean what it looks like', () => {
  const validate = (trustedSelectionPaths: readonly string[]): void => {
    new ClusterOptionsValidator().validate({ trustedSelectionPaths } as Partial<ClusterOptionsType>);
  };

  test('a mid-path wildcard is refused rather than matched literally', () => {
    // Silent in the direction that matters: matched literally it admits
    // nothing, so the node refuses all its own traffic while the config file
    // reads as though it does not.
    expect(() => validate(['/user/*/inbox'])).toThrow(OptionsError);
    expect(() => validate(['/user/*/inbox'])).toThrow(/trustedSelectionPaths/);
  });

  test('an empty entry is refused', () => {
    expect(() => validate([''])).toThrow(OptionsError);
    expect(() => validate(['   '])).toThrow(OptionsError);
  });

  test('the two legal shapes pass', () => {
    expect(() => validate(['/user/orders', '/user/orders/*'])).not.toThrow();
    expect(() => validate([])).not.toThrow();
  });
});
