import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { ClusterSingleton, ClusterSingletonId } from '../../../../../src/cluster/singleton/ClusterSingleton.js';
import { SingletonKey } from '../../../../../src/cluster/singleton/SingletonKey.js';
import { StartSingletonOptions } from '../../../../../src/cluster/singleton/StartSingletonOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Props } from '../../../../../src/Props.js';
import { DeadLetter } from '../../../../../src/SystemMessages.js';
import { TestKit } from '../../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../../src/testkit/TestKitOptions.js';

const received: string[] = [];

/** Declares its own key and constructs with no arguments. */
class EchoActor extends Actor<string> {
  static readonly singleton = SingletonKey.of<string>('echo');
  override onReceive(message: string): void { received.push(`echo:${message}`); }
}

/** Declares its own key but needs a dependency — the factory overload. */
class LabelledActor extends Actor<string> {
  static readonly singleton = SingletonKey.of<string>('labelled');
  constructor(private readonly label: string) { super(); }
  override onReceive(message: string): void { received.push(`${this.label}:${message}`); }
}

type Node = { system: ActorSystem; cluster: Cluster; kit: TestKit };

async function startNode(systemName: string, port: number, seeds: string[] = []): Promise<Node> {
  const kitOptions = TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const kit = TestKit.create(systemName, kitOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  return { system: kit.system, cluster, kit };
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave();
  await node.system.terminate();
}

async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(20);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('ClusterSingleton — calling shapes', () => {
  test('all four start() forms land on the same manager path', async () => {
    const node = await startNode('sng-api-forms', 54001);
    const singleton = node.cluster.singleton;
    const managerPath = (typeName: string): string =>
      `actor-ts://sng-api-forms/system/cluster/singleton/manager-${typeName}`;

    // 1. class with a zero-argument constructor
    singleton.start(EchoActor);
    // 2. class + factory (dependency injection)
    singleton.start(LabelledActor, () => new LabelledActor('eu'));
    // 3. bare key + class
    class Plain extends Actor<string> { override onReceive(): void {} }
    singleton.start(SingletonKey.of<string>('bare'), Plain);
    // 4. full options — builder
    singleton.start(StartSingletonOptions.create<string>()
      .withTypeName('built')
      .withProps(Props.create(() => new Plain())));
    // 4b. full options — plain object, which must read identically
    singleton.start({ typeName: 'plain', props: Props.create(() => new Plain()) });

    for (const typeName of ['echo', 'labelled', 'bare', 'built', 'plain']) {
      expect(singleton.isStarted(typeName)).toBe(true);
      expect(singleton.managerFor(typeName).value.path.toString()).toBe(managerPath(typeName));
    }

    await stopNode(node);
  });

  test('a class with no singleton static is rejected by name', async () => {
    const node = await startNode('sng-api-undeclared', 54002);
    class Undeclared extends Actor<string> { override onReceive(): void {} }

    expect(() => node.cluster.singleton.start(Undeclared as never))
      .toThrow(/Undeclared does not declare a singleton key/);

    await stopNode(node);
  });

  test('start() is get-or-create — the same ref, one manager', async () => {
    received.length = 0;
    const node = await startNode('sng-api-idem', 54003);

    const first = node.cluster.singleton.start(EchoActor);
    const second = node.cluster.singleton.start(EchoActor);
    expect(second).toBe(first);

    // The repeat call's props are ignored, so the original actor is the one
    // that runs — this is what makes a getOrCreate-style helper safe to call
    // from several modules.
    await waitFor(() => node.cluster.leader().nonEmpty);
    first.tell('one');
    await waitFor(() => received.includes('echo:one'));

    await stopNode(node);
  });
});

describe('ClusterSingleton — ref()', () => {
  test('ref() is memoised and equals what start() returned', async () => {
    const node = await startNode('sng-api-memo', 54004);

    const started = node.cluster.singleton.start(EchoActor);
    // Not just equal — the SAME object.  Each proxy subscribes to cluster
    // events for the life of the process, so a fresh one per call would leak
    // a listener per call.
    expect(node.cluster.singleton.ref(EchoActor)).toBe(started);
    expect(node.cluster.singleton.ref(EchoActor.singleton)).toBe(started);
    expect(node.cluster.singleton.ref<string>('echo')).toBe(started);

    await stopNode(node);
  });

  test('ref() before start() works and starts delivering locally afterwards', async () => {
    received.length = 0;
    const node = await startNode('sng-api-lazy', 54005);

    // No manager on this node yet — the proxy must still be constructible.
    const ref = node.cluster.singleton.ref(EchoActor);
    expect(node.cluster.singleton.isStarted(EchoActor)).toBe(false);

    // Starting afterwards must make the SAME ref deliver, which is only
    // possible because the manager is resolved per delivery, not captured.
    const started = node.cluster.singleton.start(EchoActor);
    expect(started).toBe(ref);

    await waitFor(() => node.cluster.leader().nonEmpty);
    ref.tell('late');
    await waitFor(() => received.includes('echo:late'));

    await stopNode(node);
  });

  test('a leader that never started the singleton dead-letters and warns once', async () => {
    const node = await startNode('sng-api-nohost', 54006);
    const deadLetters: unknown[] = [];
    const warnings: string[] = [];
    node.system.eventStream.subscribe(
      node.system.spawnAnonymous(Props.create(() => new (class extends Actor<DeadLetter> {
        override onReceive(letter: DeadLetter): void { deadLetters.push(letter.message); }
      })())),
      DeadLetter,
    );
    node.system.log.warn = ((message: string): void => { warnings.push(message); }) as typeof node.system.log.warn;

    // This node is the sole member, so it is the leader — and it hosts no
    // manager, which means nothing anywhere is hosting the singleton.
    const ref = node.cluster.singleton.ref<string>('never-started');
    await waitFor(() => node.cluster.leader().nonEmpty);
    ref.tell('a');
    ref.tell('b');
    ref.tell('c');

    await waitFor(() => deadLetters.length === 3);
    expect(deadLetters).toEqual(['a', 'b', 'c']);
    // Latched: three sends, one warning — a hot path must not flood the log.
    expect(warnings.filter(w => w.includes('never-started')).length).toBe(1);

    await stopNode(node);
  });
});

describe('ClusterSingleton — lifecycle guards', () => {
  test('stop() on the returned ref is a warning no-op, not a PoisonPill', async () => {
    received.length = 0;
    const node = await startNode('sng-api-stopguard', 54007);
    const warnings: string[] = [];
    node.system.log.warn = ((message: string): void => { warnings.push(message); }) as typeof node.system.log.warn;

    const ref = node.cluster.singleton.start(EchoActor);
    await waitFor(() => node.cluster.leader().nonEmpty);

    // `ActorRef.stop()` means "PoisonPill the target" everywhere else; on a
    // singleton ref that would kill whatever the leader is hosting.
    ref.stop();
    expect(warnings.some(w => w.includes('stop() on the ref is a no-op'))).toBe(true);
    expect(node.cluster.singleton.isStarted(EchoActor)).toBe(true);

    ref.tell('still-alive');
    await waitFor(() => received.includes('echo:still-alive'));

    await stopNode(node);
  });

  test('binding the extension to a second cluster throws', async () => {
    const nodeA = await startNode('sng-api-bind', 54008);
    // Reaching the facade binds it; a second, different Cluster on the same
    // system would silently re-point the registry and every live proxy.
    nodeA.cluster.singleton.isStarted('anything');

    const other = await Cluster.join(
      ActorSystem.create('sng-api-bind-other'),
      ClusterOptions.create()
        .withHost('h')
        .withPort(54009)
        .withTransport(new InMemoryTransport(new NodeAddress('sng-api-bind-other', 'h', 54009))),
    );

    expect(() => ClusterSingleton.get(nodeA.system, other))
      .toThrow(/already bound to a different cluster/);

    await other.leave();
    await other.system.terminate();
    await stopNode(nodeA);
  });

  test('an unbound extension explains how to reach the facade', async () => {
    // Reached through `system.extension(ClusterSingletonId)` on a system that
    // never joined a cluster: the error has to name the way in, since there is
    // no argument left to pass a Cluster through.
    const system = ActorSystem.create('sng-api-unbound');
    const unbound = system.extension(ClusterSingletonId);

    expect(() => unbound.ref<string>('x')).toThrow(/not bound to a cluster/);
    expect(() => unbound.ref<string>('x')).toThrow(/cluster\.singleton/);

    await system.terminate();
  });
});

describe('ClusterSingleton — proxy-only node', () => {
  test('a node that only calls ref() reaches the singleton on the hosting node', async () => {
    received.length = 0;
    const nodeA = await startNode('sng-proxyonly', 54101);
    const nodeB = await startNode('sng-proxyonly', 54102, ['sng-proxyonly@h:54101']);
    await waitFor(() =>
      nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
    );

    // Only A hosts.  A is the lower address, so A is the leader and the host.
    nodeA.cluster.singleton.start(LabelledActor, () => new LabelledActor('a'));
    expect(nodeB.cluster.singleton.isStarted(LabelledActor)).toBe(false);

    // B never started a manager — this is the ClusterSharding.startProxy
    // analogue that the singleton API previously had no answer for.
    nodeB.cluster.singleton.ref(LabelledActor).tell('from-b');
    await waitFor(() => received.includes('a:from-b'), 3_000);

    await stopNode(nodeA);
    await stopNode(nodeB);
  });
});
