/**
 * #949 — the singleton had no hand-over protocol, so a routine scale-up ran
 * two instances.
 *
 * Every node computed the host from its own gossip view and acted on it alone.
 * The incoming host promoted itself off its *own* `SelfUp` — which fires
 * locally, before gossip has told any peer anything — while the incumbent
 * stopped its instance with a `PoisonPill` queued behind that instance's whole
 * mailbox and an arbitrarily slow `postStop` after it.  No failure and no
 * partition was needed: `Cluster.leader()` is the lowest-addressed up-member,
 * so a lower-addressed node simply joining moves the host.
 *
 * These tests **move the leader on purpose**, which is what makes them
 * complementary to `ClusterSingletonHostChange.test.ts` — that file holds the
 * leader fixed, because #637 was about a host that moved *without* a leader
 * change.  Here the leader change is the trigger.
 *
 * The probe is a census that records its own **peak**, not a snapshot taken
 * once the dust has settled.  The distinction is the whole point: the old
 * assertions waited for `liveOn(new) === 1 && liveOn(old) === 0` and then
 * checked the total, which a window of two live instances satisfies perfectly.
 * In-process nodes share one heap, so every `preStart` / `postStop` runs here
 * and the peak is exact rather than sampled — "exactly one at every instant"
 * becomes a number.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import {
  singletonManagerPath,
  StartSingletonOptions,
} from '../../../../../src/cluster/singleton/index.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import {
  InMemoryLease,
  inMemoryLeaseStore,
} from '../../../../../src/coordination/leases/InMemoryLease.js';
import { LeaseOptions } from '../../../../../src/coordination/LeaseOptions.js';
import type { LogContextData } from '../../../../../src/LogContext.js';
import { LogLevel, type Logger } from '../../../../../src/Logger.js';
import { DeadLetter } from '../../../../../src/SystemMessages.js';
import { TestKit } from '../../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../../src/testkit/TestKitOptions.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

/**
 * Discards everything except `warn`, which it keeps.
 *
 * Several of the properties under test here are *reported* rather than
 * returned — "hosted anyway because nobody answered" and "refused a hand-over
 * from a peer that cannot be the host" are both a `warn` and a decision, and
 * asserting on the decision alone would pass with the operator left in the
 * dark.  `withSource` returns `this` the way `NoopLogger` does, so a
 * subsystem-scoped logger lands in the same list.
 */
class WarningCollector implements Logger {
  readonly level = LogLevel.Debug;
  readonly warnings: string[] = [];

  debug(): void { /* discarded */ }
  info(): void { /* discarded */ }
  error(): void { /* discarded */ }
  warn(message: string): void { this.warnings.push(message); }
  withSource(_source: string): Logger { return this; }
  withFields(_fields: LogContextData): Logger { return this; }

  /** Whether any collected warning contains `fragment`. */
  saw(fragment: string): boolean {
    return this.warnings.some((warning) => warning.includes(fragment));
  }
}

type Node = {
  readonly kit: TestKit;
  readonly cluster: Cluster;
  readonly log: WarningCollector;
};

type NodeSpec = {
  readonly systemName: string;
  readonly port: number;
  readonly seeds: readonly string[];
  readonly roles?: readonly string[];
};

async function startNode(spec: NodeSpec): Promise<Node> {
  const log = new WarningCollector();
  const kitOptions = TestKitOptions.create().withLogger(log);
  const kit = TestKit.create(spec.systemName, kitOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(spec.port)
    .withSeeds([...spec.seeds])
    .withRoles([...(spec.roles ?? [])])
    .withTransport(new InMemoryTransport(new NodeAddress(spec.systemName, 'h', spec.port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 400, downAfterMs: 60_000 })
    .withGossipIntervalMs(60);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  return { kit, cluster, log };
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave().catch(() => {});
  await node.kit.system.terminate().catch(() => {});
}

/**
 * Live instances per node, plus the **peak** total ever reached and the order
 * of every lifecycle edge.
 *
 * `peak` is what turns "exactly one cluster-wide" into an assertion about the
 * transition rather than about the state after it.  `timeline` is what makes
 * "the new host does not spawn until the previous instance has terminated"
 * checkable as an ordering instead of as an inference from a count.
 */
class SingletonCensus {
  private readonly live = new Map<string, number>();
  readonly timeline: string[] = [];
  readonly received: string[] = [];
  peak = 0;

  liveOn(where: string): number { return this.live.get(where) ?? 0; }

  total(): number {
    let sum = 0;
    for (const count of this.live.values()) sum += count;
    return sum;
  }

  /** @internal */ _started(where: string): void {
    this.live.set(where, this.liveOn(where) + 1);
    this.timeline.push(`${where}:started`);
    this.peak = Math.max(this.peak, this.total());
  }

  /** @internal */ _stopped(where: string): void {
    this.live.set(where, this.liveOn(where) - 1);
    this.timeline.push(`${where}:stopped`);
  }
}

/**
 * The singleton under test.  Its `postStop` is deliberately slow: the overlap
 * this issue is about *is* the outgoing instance's drain, so a `postStop` that
 * returns immediately hides the very window the protocol has to close.
 */
class SlowStoppingMarker extends Actor<string> {
  constructor(
    private readonly census: SingletonCensus,
    private readonly where: string,
    private readonly stopDelayMs: number,
  ) { super(); }

  override preStart(): void { this.census._started(this.where); }

  override async postStop(): Promise<void> {
    // The elapsed time IS the property: the instance has to still be live here,
    // so that a peer spawning early is observable as a peak of two.  Recorded
    // as stopped only once the drain has actually finished.
    await sleep(this.stopDelayMs);
    this.census._stopped(this.where);
  }

  override onReceive(message: string): void {
    this.census.received.push(`${this.where}:${message}`);
  }
}

/**
 * Collects the payloads that reach one node's `system.deadLetters`.
 *
 * `subscribed` flips in `preStart`, which is a turn later than the `spawn` that
 * created it — so a test that sends before checking it races the subscription
 * and then waits out its timeout for a letter that was published to nobody.
 */
class DeadLetterCollector extends Actor<DeadLetter> {
  constructor(
    private readonly seen: unknown[],
    private readonly subscribed: { value: boolean },
  ) { super(); }

  override preStart(): void {
    this.system.eventStream.subscribe(this.self, DeadLetter);
    this.subscribed.value = true;
  }

  override onReceive(message: DeadLetter): void { this.seen.push(message.message); }
}

describe('ClusterSingleton — hand-over on a leader move (#949)', () => {
  test('a lower-addressed node joining never produces two live instances', async () => {
    // B holds the singleton first (it is the only member, so it is the leader).
    // A then joins *below* it, which moves the leader with no failure involved,
    // and is the case the issue title calls "a routine scale-up".
    const systemName = 'sng-handover-move';
    const census = new SingletonCensus();
    const nodeB = await startNode({ systemName, port: 53_102, seeds: [] });
    const startOn = (node: Node, where: string): ActorRef<string> => {
      const singletonOptions = StartSingletonOptions.create<string>()
        .withTypeName('mover')
        .withActor(() => new SlowStoppingMarker(census, where, 400));
      return node.cluster.singleton.start(singletonOptions);
    };

    startOn(nodeB, 'b');
    await awaitCondition(() => census.liveOn('b') === 1, { label: 'B hosts the singleton' });

    const nodeA = await startNode({ systemName, port: 53_101, seeds: [`${systemName}@h:53102`] });
    startOn(nodeA, 'a');
    await awaitCondition(
      () => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      { timeoutMs: 5_000, label: 'both nodes are up' },
    );

    // A sorts first, so A is the leader and therefore the host.
    await awaitCondition(
      () => census.liveOn('a') === 1 && census.liveOn('b') === 0,
      { timeoutMs: 8_000, label: 'the singleton has moved to A' },
    );

    // The assertion this issue exists for.  Without the hand-over, A spawns off
    // its own `SelfUp` while B's instance is still 400 ms into `postStop`, so
    // the peak is 2 — and every settled-state assertion still passes.
    expect(census.peak).toBe(1);
    expect(census.total()).toBe(1);
    // AC2 as an ordering rather than a count: B's instance is gone *before* A's
    // exists, which is the property `peak === 1` is the consequence of.
    expect(census.timeline).toEqual(['b:started', 'b:stopped', 'a:started']);
    expect(nodeA.cluster.isLeader()).toBe(true);

    await stopNode(nodeA);
    await stopNode(nodeB);
  }, 30_000);

  test('messages routed to the incoming host during the wait are not dropped', async () => {
    // The wait is a window this protocol opens itself: the node is the elected
    // host, every proxy already routes there, and the instance does not exist
    // yet.  Paying for uniqueness with message loss on every host move is not
    // the trade being made, so the manager holds them and flushes on spawn.
    const systemName = 'sng-handover-hold';
    const census = new SingletonCensus();
    const nodeB = await startNode({ systemName, port: 53_202, seeds: [] });
    const startOn = (node: Node, where: string): ActorRef<string> => {
      const singletonOptions = StartSingletonOptions.create<string>()
        .withTypeName('holder')
        .withActor(() => new SlowStoppingMarker(census, where, 600));
      return node.cluster.singleton.start(singletonOptions);
    };

    startOn(nodeB, 'b');
    await awaitCondition(() => census.liveOn('b') === 1, { label: 'B hosts the singleton' });

    const nodeA = await startNode({ systemName, port: 53_201, seeds: [`${systemName}@h:53202`] });
    const fromA = startOn(nodeA, 'a');

    // Mid-hand-over: A is the elected host and has no instance yet, because B
    // is still draining.  Pre-fix this state does not exist at all — A spawns
    // immediately — so this wait is itself part of the binding.
    await awaitCondition(
      () => nodeA.cluster.isLeader() && census.liveOn('a') === 0 && census.liveOn('b') === 1,
      { timeoutMs: 5_000, label: 'A is the elected host and is still waiting for B' },
    );
    fromA.tell('during-the-handover');

    await awaitCondition(
      () => census.received.length > 0,
      { timeoutMs: 8_000, label: 'the held message reached an instance' },
    );
    // It reached the *new* instance, not a torn-down old one.
    expect(census.received).toEqual(['a:during-the-handover']);
    expect(census.peak).toBe(1);

    await stopNode(nodeA);
    await stopNode(nodeB);
  }, 30_000);

  test('an eligible peer that never answers costs the timeout, then hosting proceeds', async () => {
    // The deliberate choice, made visible.  B is an up member — so A's own view
    // says it could be hosting — and it never calls `start()` or `ref()`, so it
    // has nothing registered to answer with.  That is indistinguishable from
    // unreachable, which is the case where "hosted somewhere" and "at most one"
    // cannot both be had: availability wins, and the manager says so.
    const systemName = 'sng-handover-silent';
    const census = new SingletonCensus();
    const nodeB = await startNode({ systemName, port: 53_302, seeds: [] });
    const nodeA = await startNode({ systemName, port: 53_301, seeds: [`${systemName}@h:53302`] });
    await awaitCondition(
      () => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      { timeoutMs: 5_000, label: 'both nodes are up' },
    );

    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('unanswered')
      .withHandOverTimeoutMs(300)
      .withActor(() => new SlowStoppingMarker(census, 'a', 0));
    nodeA.cluster.singleton.start(singletonOptions);

    await awaitCondition(
      () => census.liveOn('a') === 1,
      { timeoutMs: 5_000, label: 'A hosted anyway once the hand-over timed out' },
    );
    expect(nodeA.log.saw('did not acknowledge the hand-over')).toBe(true);
    expect(nodeA.log.saw('Availability was chosen over uniqueness')).toBe(true);

    await stopNode(nodeA);
    await stopNode(nodeB);
  }, 30_000);

  test('a peer that leaves mid-hand-over stops being waited on', async () => {
    // A peer that goes away will never answer, and by this node's own view it
    // can no longer be hosting — so continuing to wait on it would spend the
    // whole timeout on a question membership has already settled, and end in the
    // warning that says the invariant could not be proven when in fact it was.
    //
    // B is silent by construction (it never mentions the singleton), so the only
    // thing that can end A's wait short of the timeout is B dropping out of the
    // eligible set.  The timeout is set an order of magnitude above the budget
    // below, so taking it cannot pass this.
    const systemName = 'sng-handover-departing';
    const census = new SingletonCensus();
    const nodeB = await startNode({ systemName, port: 53_1002, seeds: [] });
    const nodeA = await startNode({ systemName, port: 53_1001, seeds: [`${systemName}@h:531002`] });
    await awaitCondition(
      () => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      { timeoutMs: 5_000, label: 'both nodes are up' },
    );

    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('departing')
      .withHandOverTimeoutMs(60_000)
      .withActor(() => new SlowStoppingMarker(census, 'a', 0));
    nodeA.cluster.singleton.start(singletonOptions);

    // Nothing can have hosted yet: A is waiting on a peer that cannot answer.
    // This is an *absence* — it already holds, and has to still hold after the
    // request has had every chance to be answered — so there is nothing to poll.
    await sleep(200);
    expect(census.liveOn('a')).toBe(0);

    await stopNode(nodeB);
    await awaitCondition(
      () => census.liveOn('a') === 1,
      { timeoutMs: 6_000, label: 'A hosts once the silent peer has left the cluster' },
    );
    expect(nodeA.log.saw('did not acknowledge the hand-over')).toBe(false);

    await stopNode(nodeA);
  }, 30_000);

  test('a peer that only calls ref() answers at once instead of costing the timeout', async () => {
    // The counterpart to the test above, and why the envelope-path claim moved
    // off the manager and onto the extension: a node that merely talks to the
    // singleton is still asked to stand down, and "I run no manager" is an
    // answer it can give without one.  The generous default timeout would
    // otherwise be paid on every host move in a proxy/host deployment.
    const systemName = 'sng-handover-refonly';
    const census = new SingletonCensus();
    const nodeB = await startNode({ systemName, port: 53_402, seeds: [] });
    const nodeA = await startNode({ systemName, port: 53_401, seeds: [`${systemName}@h:53402`] });
    await awaitCondition(
      () => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      { timeoutMs: 5_000, label: 'both nodes are up' },
    );
    nodeB.cluster.singleton.ref<string>('proxied');

    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('proxied')
      // Far below one round trip, so only an *answered* hand-over can pass.
      .withHandOverTimeoutMs(2_000)
      .withActor(() => new SlowStoppingMarker(census, 'a', 0));
    nodeA.cluster.singleton.start(singletonOptions);

    await awaitCondition(
      () => census.liveOn('a') === 1,
      { timeoutMs: 1_500, label: 'A hosts once the proxy-only node acknowledged' },
    );
    expect(nodeA.log.saw('did not acknowledge the hand-over')).toBe(false);

    await stopNode(nodeA);
    await stopNode(nodeB);
  }, 30_000);
});

describe('ClusterSingleton — nodes whose systems are named differently (#949)', () => {
  test('the hand-over is addressed to the peer, not to the sender', async () => {
    // The manager path embeds the *hosting* system's name, and a cluster's
    // members do not have to share one — `MultiNodeSpec` names every node's
    // system after its role precisely so a test can tell them apart, and
    // `tests/multi-node/SingletonFailover.test.ts` runs on that.  A frame
    // addressed with the sender's name misses the recipient's per-path handler,
    // falls through to `Cluster.dispatchEnvelope`'s generic path resolution, and
    // arrives at the manager as a bare body with no authenticated peer — which
    // it then, correctly, refuses to act on.  Nothing else in this file catches
    // that, because every other node here shares one system name.
    const census = new SingletonCensus();
    const nodeBeta = await startNode({ systemName: 'beta', port: 53_902, seeds: [] });
    const startOn = (node: Node, where: string): ActorRef<string> => {
      const singletonOptions = StartSingletonOptions.create<string>()
        .withTypeName('cross-named')
        // Well below the default, so only an *answered* hand-over can pass this
        // in time — taking the timeout would blow the wait below.
        .withHandOverTimeoutMs(20_000)
        .withActor(() => new SlowStoppingMarker(census, where, 200));
      return node.cluster.singleton.start(singletonOptions);
    };

    startOn(nodeBeta, 'beta');
    await awaitCondition(() => census.liveOn('beta') === 1, { label: 'beta hosts the singleton' });

    // 'alpha' sorts before 'beta' in the address string, so alpha leads.
    const nodeAlpha = await startNode({ systemName: 'alpha', port: 53_901, seeds: ['beta@h:53902'] });
    startOn(nodeAlpha, 'alpha');
    await awaitCondition(
      () => nodeAlpha.cluster.upMembers().length === 2 && nodeBeta.cluster.upMembers().length === 2,
      { timeoutMs: 5_000, label: 'both differently-named nodes are up' },
    );

    await awaitCondition(
      () => census.liveOn('alpha') === 1 && census.liveOn('beta') === 0,
      { timeoutMs: 5_000, label: 'the singleton moved to alpha' },
    );
    expect(census.peak).toBe(1);
    expect(census.timeline).toEqual(['beta:started', 'beta:stopped', 'alpha:started']);
    // Reached by acknowledgment and not by running out of patience — the whole
    // point, since the timeout would have produced the same end state.
    expect(nodeAlpha.log.saw('did not acknowledge the hand-over')).toBe(false);

    await stopNode(nodeAlpha);
    await stopNode(nodeBeta);
  }, 30_000);

  test('a proxy on one system reaches the singleton hosted on another', async () => {
    // The same defect on the delivery path, which predates this issue:
    // `ClusterSingletonProxy.deliver` addressed the manager with *its own*
    // system name.  Generic path resolution then handed the manager the raw
    // user body instead of a `singleton-deliver`, so it was logged as an
    // unrecognised message and dropped — no dead letter, no arrival.
    const census = new SingletonCensus();
    const nodeAlpha = await startNode({ systemName: 'alpha', port: 53_911, seeds: [] });
    const nodeBeta = await startNode({ systemName: 'beta', port: 53_912, seeds: ['alpha@h:53911'] });
    await awaitCondition(
      () => nodeAlpha.cluster.upMembers().length === 2 && nodeBeta.cluster.upMembers().length === 2,
      { timeoutMs: 5_000, label: 'both differently-named nodes are up' },
    );

    // beta takes its proxy first, so its manager path is claimed and it can
    // answer alpha's hand-over request at once rather than making alpha wait out
    // the timeout — the property the previous test covers, kept out of this one.
    const fromBeta = nodeBeta.cluster.singleton.ref<string>('cross-named-routing');

    // alpha sorts first, so alpha hosts; beta only talks to it.
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('cross-named-routing')
      .withActor(() => new SlowStoppingMarker(census, 'alpha', 0));
    nodeAlpha.cluster.singleton.start(singletonOptions);
    await awaitCondition(() => census.liveOn('alpha') === 1, { label: 'alpha hosts the singleton' });

    fromBeta.tell('from-beta');
    await awaitCondition(
      () => census.received.length > 0,
      { timeoutMs: 5_000, label: 'the message crossed to the differently-named host' },
    );
    expect(census.received).toEqual(['alpha:from-beta']);

    await stopNode(nodeBeta);
    await stopNode(nodeAlpha);
  }, 30_000);
});

describe('ClusterSingleton — routed to a node that never called start() (#949)', () => {
  test('the message reaches deadLetters instead of a log line', async () => {
    // Claiming the manager path from `ref()` — which is what lets a proxy-only
    // node answer a hand-over at all — also puts a handler where there used to be
    // none, so a *user* message routed to such a node no longer falls through to
    // `Cluster.dispatchEnvelope`'s "no envelope handler registered, dropping"
    // warning.  It now goes to `deadLetters`, for the reason
    // `ClusterSingletonManager.onSingletonDeliver` gives on the neighbouring
    // path: only the dead-letter stream makes a lost message a metric, a
    // DevTools entry and something a test can assert.
    const systemName = 'sng-handover-nomanager';
    const census = new SingletonCensus();
    const nodeA = await startNode({ systemName, port: 53_1101, seeds: [] });
    const nodeB = await startNode({ systemName, port: 53_1102, seeds: [`${systemName}@h:531101`] });
    await awaitCondition(
      () => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      { timeoutMs: 5_000, label: 'both nodes are up' },
    );

    // A sorts first and is therefore the elected host — and A only ever takes a
    // `ref()`, so nothing anywhere is hosting.  The deployment mistake, seen
    // from the far end of the wire.
    nodeA.cluster.singleton.ref<string>('never-started');
    const seenOnA: unknown[] = [];
    const subscribed = { value: false };
    nodeA.kit.system.spawn(() => new DeadLetterCollector(seenOnA, subscribed), 'dead-letter-collector');
    await awaitCondition(() => subscribed.value, { label: "A's dead-letter collector is listening" });

    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('never-started')
      .withActor(() => new SlowStoppingMarker(census, 'b', 0));
    const fromB = nodeB.cluster.singleton.start(singletonOptions);
    fromB.tell('nowhere-to-go');

    await awaitCondition(
      () => seenOnA.length > 0,
      { timeoutMs: 5_000, label: "the undeliverable message reached A's dead letters" },
    );
    expect(seenOnA).toEqual(['nowhere-to-go']);
    expect(nodeA.log.saw('never called')).toBe(true);
    expect(census.total()).toBe(0);

    await stopNode(nodeB);
    await stopNode(nodeA);
  }, 30_000);
});

describe('ClusterSingleton — who may ask for a hand-over (#949)', () => {
  test('a member that cannot be the elected host is refused', async () => {
    // A hand-over is a directive that stops the singleton, so an unauthenticated
    // one is a remote kill switch — the shape #584 left open in `ShardRegion`,
    // on a wire that carries no credential (#964).  The socket-verified peer
    // address is the whole of the check available today: a node that believes it
    // hosts stands down only for a peer that sorts *before* it, because the host
    // is the first address-ordered eligible member.
    const systemName = 'sng-handover-authorization';
    const census = new SingletonCensus();
    const nodeA = await startNode({ systemName, port: 53_501, seeds: [] });
    const nodeB = await startNode({ systemName, port: 53_502, seeds: [`${systemName}@h:53501`] });
    await awaitCondition(
      () => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      { timeoutMs: 5_000, label: 'both nodes are up' },
    );

    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('guarded')
      .withActor(() => new SlowStoppingMarker(census, 'a', 0));
    nodeA.cluster.singleton.start(singletonOptions);
    nodeB.cluster.singleton.ref<string>('guarded');
    await awaitCondition(() => census.liveOn('a') === 1, { label: 'A hosts the singleton' });

    // B sorts *after* A, so B cannot be the host while A is up — and A knows it.
    nodeB.cluster._sendEnvelope(nodeA.cluster.selfAddress, {
      kind: 'envelope',
      to: singletonManagerPath(systemName, 'guarded'),
      from: null,
      body: { kind: 'singleton.HandOverRequest', typeName: 'guarded' },
      tag: 'Singleton',
    });
    await awaitCondition(
      () => nodeA.log.saw('refusing a hand-over request'),
      { timeoutMs: 3_000, label: 'A refused the request' },
    );
    // The assertion is an *absence* — the instance must still be there — and an
    // absence cannot be polled for: it already holds at t=0 and has to still
    // hold after the frame has had every chance to be acted on.
    await sleep(150);
    expect(census.liveOn('a')).toBe(1);
    expect(census.timeline).toEqual(['a:started']);

    await stopNode(nodeB);
    await stopNode(nodeA);
  }, 30_000);

  test('a sender that is not a member of the cluster is refused', async () => {
    const systemName = 'sng-handover-outsider';
    const census = new SingletonCensus();
    const nodeA = await startNode({ systemName, port: 53_601, seeds: [] });
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('closed')
      .withActor(() => new SlowStoppingMarker(census, 'a', 0));
    nodeA.cluster.singleton.start(singletonOptions);
    await awaitCondition(() => census.liveOn('a') === 1, { label: 'A hosts the singleton' });

    // A transport that joined nothing: the frame is well-formed and arrives on a
    // connection the receiver authenticated, which is exactly the attacker
    // #584 describes — someone who can complete a handshake but is not a member.
    const outsider = new InMemoryTransport(new NodeAddress(systemName, 'h', 53_699));
    await outsider.start();
    outsider.send(nodeA.cluster.selfAddress, {
      kind: 'envelope',
      to: singletonManagerPath(systemName, 'closed'),
      from: null,
      body: { kind: 'singleton.HandOverRequest', typeName: 'closed' },
      tag: 'Singleton',
    });

    await awaitCondition(
      () => nodeA.log.saw('not a member of this cluster'),
      { timeoutMs: 3_000, label: 'A refused the outsider' },
    );
    // Absence again: the singleton has to survive the frame, so there is nothing
    // to poll for — only a turn to give the manager and a state to re-read.
    await sleep(150);
    expect(census.liveOn('a')).toBe(1);

    await outsider.shutdown();
    await stopNode(nodeA);
  }, 30_000);
});

describe('ClusterSingleton — the lease waits for the instance, not for the PoisonPill (#949)', () => {
  test('release() is not called before the outgoing instance has terminated', async () => {
    // AC3.  `stopChild` returns as soon as the `PoisonPill` is enqueued, and the
    // step-down used to `await` the *release* right behind it — so a follower
    // could win the lease and spawn while the previous instance was still
    // draining.  Releasing early hands away the entire guarantee the lease is
    // there to provide.
    inMemoryLeaseStore._clear();
    const systemName = 'sng-handover-lease-release';
    const census = new SingletonCensus();
    const order: string[] = [];

    const leaseFor = (owner: string): InMemoryLease => {
      const leaseOptions = LeaseOptions.create()
        .withName('sng-handover-lease-release')
        .withOwner(owner)
        .withTtlMs(5_000);
      const lease = new InMemoryLease(leaseOptions);
      const release = lease.release.bind(lease);
      lease.release = async (): Promise<void> => { order.push(`${owner}:release`); return release(); };
      return lease;
    };

    class RecordingMarker extends SlowStoppingMarker {
      override async postStop(): Promise<void> {
        await super.postStop();
        order.push('b:terminated');
      }
    }

    const nodeB = await startNode({ systemName, port: 53_702, seeds: [] });
    const bSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('leased')
      .withActor(() => new RecordingMarker(census, 'b', 300))
      .withLease(leaseFor('b'))
      .withAcquireRetryIntervalMs(100);
    nodeB.cluster.singleton.start(bSingletonOptions);
    await awaitCondition(() => census.liveOn('b') === 1, { label: 'B holds the lease and hosts' });

    const nodeA = await startNode({ systemName, port: 53_701, seeds: [`${systemName}@h:53702`] });
    const aSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('leased')
      .withActor(() => new SlowStoppingMarker(census, 'a', 0))
      .withLease(leaseFor('a'))
      .withAcquireRetryIntervalMs(100);
    nodeA.cluster.singleton.start(aSingletonOptions);

    await awaitCondition(
      () => census.liveOn('a') === 1 && census.liveOn('b') === 0,
      { timeoutMs: 10_000, label: 'the leased singleton has moved to A' },
    );
    // The ordering is the assertion: B's instance is gone before B lets go of
    // the lease that is A's permission to spawn.
    expect(order.indexOf('b:terminated')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('b:release')).toBeGreaterThan(order.indexOf('b:terminated'));
    expect(census.peak).toBe(1);

    await stopNode(nodeA);
    await stopNode(nodeB);
  }, 30_000);

  test('a lost lease is re-acquired only after the instance is gone, and a child comes back', async () => {
    // AC4, and the failure is not "two instances" but **zero**.  `onLeaseLost`
    // stopped the child and re-entered `acquiring` at once; the acquire could
    // resolve while the old instance was still in `postStop`; the `spawn()` that
    // followed early-returned on `pendingStop`; and the reconcile after
    // `Terminated` read `leaseState === 'held'` as "already running" and
    // returned.  The manager then renewed a lease over nothing, for good — the
    // #1175 shape by a path #1175 did not close.
    inMemoryLeaseStore._clear();
    const systemName = 'sng-handover-lease-lost';
    const census = new SingletonCensus();
    const order: string[] = [];

    const leaseOptions = LeaseOptions.create()
      .withName('sng-handover-lease-lost')
      .withOwner('a')
      .withTtlMs(5_000)
      // Tight renewal so the revocation is noticed quickly.
      .withRenewalIntervalMs(60);
    const lease = new InMemoryLease(leaseOptions);
    const acquire = lease.acquire.bind(lease);
    lease.acquire = async (): Promise<boolean> => { order.push('acquire'); return acquire(); };

    class RecordingMarker extends SlowStoppingMarker {
      override async postStop(): Promise<void> {
        await super.postStop();
        order.push('terminated');
      }
    }

    const nodeA = await startNode({ systemName, port: 53_801, seeds: [] });
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('revoked')
      .withActor(() => new RecordingMarker(census, 'a', 400))
      .withLease(lease)
      .withAcquireRetryIntervalMs(50);
    nodeA.cluster.singleton.start(singletonOptions);
    await awaitCondition(() => census.liveOn('a') === 1, { label: 'A holds the lease and hosts' });
    const acquiresBeforeLoss = order.filter((entry) => entry === 'acquire').length;

    // Take the lease from under A, then hand it straight back: A's next renewal
    // fails either way, so `onLost` fires, and the re-acquire that follows can
    // succeed immediately — which is precisely what used to strand the manager.
    inMemoryLeaseStore._clear();
    const usurperOptions = LeaseOptions.create()
      .withName('sng-handover-lease-lost')
      .withOwner('usurper')
      .withTtlMs(5_000);
    const usurper = new InMemoryLease(usurperOptions);
    expect(await usurper.acquire()).toBe(true);
    await usurper.release();

    await awaitCondition(
      () => census.liveOn('a') === 1 && census.timeline.length >= 3,
      { timeoutMs: 8_000, label: 'the singleton is running again after the lease loss' },
    );
    expect(census.timeline).toEqual(['a:started', 'a:stopped', 'a:started']);
    expect(census.peak).toBe(1);
    // The re-acquire happened *after* the instance was gone, which is the AC's
    // wording: the manager did not re-enter `acquiring` over a draining child.
    const reacquire = order.indexOf('acquire', acquiresBeforeLoss);
    expect(reacquire).toBeGreaterThan(order.indexOf('terminated'));

    await stopNode(nodeA);
  }, 30_000);
});
