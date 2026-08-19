import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { LeaderChanged } from '../../../../../src/cluster/ClusterEvents.js';
import { ClusterSingletonProxy, StartSingletonOptions } from '../../../../../src/cluster/singleton/index.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { DeadLetter } from '../../../../../src/SystemMessages.js';
import { TestKit } from '../../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../../src/testkit/TestKitOptions.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

/**
 * #637 — the host of a role-restricted singleton moved without anything the
 * manager or the proxy was listening to.
 *
 * Both sides watched `LeaderChanged` (the manager also `SelfUp` and
 * `MemberRemoved`), but the host is `upMembersWithRole(role)[0]` — the first
 * address-ordered up-member carrying the role.  A role-carrying member joining
 * *below* a role-less leader moves that value and changes no leader, so the
 * event never fired.  The joining node spawned anyway, off its own `SelfUp`;
 * the incumbent was never told to stop.  Steady state was **two live
 * singletons**, plus a proxy buffer with no remaining call site to drain it.
 *
 * These tests all hold the leader fixed on purpose.  That is the premise, not
 * an incidental detail: if the leader changed, the old trigger set would have
 * covered the case and the tests would prove nothing.
 *
 * The widening went one event too far, and the last two tests are where the
 * line ended up.  `MemberUnreachable` also moves `singletonHost`, so it looked
 * like it belonged; but it is one node's opinion about a member that cannot
 * hear the opinion, so acting on it produced two live singletons rather than
 * one moved one — the same headline defect, from the other direction.  It is
 * out of the set, and the cost of leaving it out is a routing hole that is now
 * observable on the dead-letter stream instead of a log line.
 */

/**
 * Kept as a name so every call site here stays unchanged; the body forwards to
 * the shared helper (#418), which names the awaited state in its timeout message
 * and — unlike the deadline loop it replaces — cannot fall through silently.
 */
const waitFor = (
  predicate: () => boolean,
  timeoutMs = 5_000,
  stepMs = 20,
  label = 'the awaited singleton host-change state',
): Promise<void> => awaitCondition(predicate, { timeoutMs, intervalMs: stepMs, label });

type Node = {
  system: ActorSystem;
  cluster: Cluster;
  transport: InMemoryTransport;
};

type NodeSpec = {
  readonly systemName: string;
  readonly port: number;
  readonly seeds: readonly string[];
  readonly roles: readonly string[];
  /**
   * Left high in the reachability test so an unreachable member *stays*
   * unreachable instead of being downed and removed — `MemberRemoved` was
   * already subscribed before the fix, so a test that let the member get that
   * far would pass either way.
   */
  readonly downAfterMs?: number;
};

async function startNode(spec: NodeSpec): Promise<Node> {
  const kitOptions = TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const kit = TestKit.create(spec.systemName, kitOptions);
  const transport = new InMemoryTransport(new NodeAddress(spec.systemName, 'h', spec.port));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(spec.port)
    .withSeeds([...spec.seeds])
    .withRoles([...spec.roles])
    .withTransport(transport)
    .withFailureDetector({
      heartbeatIntervalMs: 50,
      unreachableAfterMs: 300,
      downAfterMs: spec.downAfterMs ?? 60_000,
    })
    .withGossipIntervalMs(60);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  return { system: kit.system, cluster, transport };
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave().catch(() => {});
  await node.system.terminate().catch(() => {});
}

/**
 * Counts singleton instances per node, so "exactly one cluster-wide" is a
 * number rather than an inference from who started last.
 */
class SingletonCensus {
  private readonly live = new Map<string, number>();
  readonly startedOn: string[] = [];
  readonly received: string[] = [];

  liveOn(where: string): number { return this.live.get(where) ?? 0; }

  total(): number {
    let sum = 0;
    for (const count of this.live.values()) sum += count;
    return sum;
  }

  /** @internal */ _started(where: string): void {
    this.startedOn.push(where);
    this.live.set(where, this.liveOn(where) + 1);
  }

  /** @internal */ _stopped(where: string): void {
    this.live.set(where, this.liveOn(where) - 1);
  }
}

/** The singleton under test — reports its own lifecycle to a census. */
class CensusMarker extends Actor<string> {
  constructor(
    protected readonly census: SingletonCensus,
    protected readonly where: string,
  ) { super(); }

  override preStart(): void { this.census._started(this.where); }
  override postStop(): void { this.census._stopped(this.where); }
  override onReceive(message: string): void {
    this.census.received.push(`${this.where}:${message}`);
  }
}

/**
 * A census marker whose `postStop` takes a configurable while.
 *
 * The lever that turns the take-over window from a coin flip into a
 * measurement.  Since #949 the incoming host waits for every eligible peer to
 * confirm its instance is *gone*, and a peer confirms only after its own
 * `postStop` has completed — so this delay is, to within a round trip, the
 * width of the window in which the new host is elected everywhere and hosts
 * nothing.  With an instant `postStop` that window is a millisecond or two and
 * traffic aimed at it lands there by luck.
 */
class SlowStoppingCensusMarker extends CensusMarker {
  constructor(census: SingletonCensus, where: string, private readonly stopDelayMs = 0) {
    super(census, where);
  }

  override async postStop(): Promise<void> {
    // The elapsed time *is* the fixture: this delay is the width of the window
    // under test, not a wait for something to happen, so there is nothing to
    // poll for — see the class comment above.
    if (this.stopDelayMs > 0) await sleep(this.stopDelayMs);
    super.postStop();
  }
}

/**
 * A census marker that treats `'die'` as a terminal stop — paired with
 * `restartOnTermination: false` it leaves the manager elected but hosting
 * nothing, which is the state the dead-letter test needs to hold still.
 */
class QuittingCensusMarker extends CensusMarker {
  override onReceive(message: string): void {
    if (message === 'die') { this.context.stopSelf(); return; }
    super.onReceive(message);
  }
}

/** Collects the payloads that reach `system.deadLetters`. */
class DeadLetterCollector extends Actor<DeadLetter> {
  constructor(private readonly seen: unknown[]) { super(); }

  override preStart(): void { this.system.eventStream.subscribe(this.self, DeadLetter); }
  override onReceive(message: DeadLetter): void { this.seen.push(message.message); }
}

/** Whether `node` currently considers the member at `port` unreachable. */
function isUnreachableOn(node: Node, port: number): boolean {
  return node.cluster.getMembers()
    .some((member) => member.address.port === port && member.status === 'unreachable');
}

/**
 * Records every `LeaderChanged` a node sees from here on, so "the leader held"
 * is checkable.
 *
 * `replayMode: 'snapshot'` and not the default `'events'`: the events replay
 * re-states the *current* leader as a `LeaderChanged`, which would put one
 * entry in this list before anything has happened.  The snapshot replay states
 * the same thing as a single `CurrentClusterState`, leaving `LeaderChanged` to
 * mean what these tests need it to mean — a change.
 */
function recordLeaderChanges(node: Node): string[] {
  const seen: string[] = [];
  node.cluster.subscribe(
    (event) => {
      if (event instanceof LeaderChanged) {
        seen.push(event.leader.fold(() => 'none', (member) => member.address.toString()));
      }
    },
    { replayMode: 'snapshot' },
  );
  return seen;
}

describe('ClusterSingleton — the host moves without a leader change (#637)', () => {
  test('a lower-addressed role member joining takes over, and the incumbent stops', async () => {
    // Addresses decide both the leader and the role host, so the ports are the
    // whole setup: A leads (lowest overall) and carries no role; B is the only
    // role member and therefore hosts; C joins later *below* B and takes over
    // without A ever ceasing to be the leader.
    const systemName = 'sng-host-move';
    const seeds = [`${systemName}@h:52510`];
    const nodeA = await startNode({ systemName, port: 52510, seeds: [], roles: [] });
    const nodeB = await startNode({ systemName, port: 52530, seeds, roles: ['worker'] });
    await waitFor(() => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2);

    const census = new SingletonCensus();
    const startOn = (node: Node, where: string): ActorRef<string> => {
      const singletonOptions = StartSingletonOptions.create<string>()
        .withTypeName('needs-worker')
        .withRole('worker')
        .withActor(() => new CensusMarker(census, where));
      return node.cluster.singleton.start(singletonOptions);
    };

    const fromLeader = startOn(nodeA, 'a');
    startOn(nodeB, 'b');

    // B is the only role member, so it hosts.
    await waitFor(() => census.liveOn('b') === 1);
    expect(census.total()).toBe(1);
    expect(nodeA.cluster.isLeader()).toBe(true);

    // From here the leader must not move — that is what makes the case a
    // regression test rather than a restatement of `LeaderChanged`.
    const leaderChangesOnA = recordLeaderChanges(nodeA);
    const leaderChangesOnB = recordLeaderChanges(nodeB);

    const nodeC = await startNode({ systemName, port: 52520, seeds, roles: ['worker'] });
    startOn(nodeC, 'c');
    await waitFor(() => [nodeA, nodeB, nodeC].every(n => n.cluster.upMembers().length === 3));

    // C sorts below B among the role members, so C is the host now.  Before
    // the fix B kept its child and the census settled on two.
    await waitFor(() => census.liveOn('c') === 1 && census.liveOn('b') === 0, 8_000);
    expect(census.total()).toBe(1);
    expect(census.liveOn('c')).toBe(1);

    // The premise held throughout: no leader change was available to react to.
    expect(nodeA.cluster.isLeader()).toBe(true);
    expect(leaderChangesOnA).toEqual([]);
    expect(leaderChangesOnB).toEqual([]);

    // And both sides agree where to route: a tell from the leader — which
    // hosts nothing — reaches C, and reaches it once.
    census.received.length = 0;
    fromLeader.tell('after-handover');
    await waitFor(() => census.received.length > 0);
    // The settle is what makes "and reaches it once" mean anything: the poll
    // above returns on the delivery that reaches one, so a duplicate can only
    // show up in a window after it.  Polling `length === 1` instead would
    // return on the same delivery and never see the second.
    await sleep(200);
    expect(census.received).toEqual(['c:after-handover']);

    await stopNode(nodeC); await stopNode(nodeB); await stopNode(nodeA);
  }, 30_000);

  test('traffic sent across the take-over is delivered, exactly once, with nothing dropped', async () => {
    // The second half of #637's acceptance criterion — *"exactly one live
    // singleton child cluster-wide **and zero dropped messages**"* — in the
    // scenario the criterion names.  The first test in this file covers the
    // first half and is structurally unable to cover this one: it sends its
    // single message *after* the take-over has fully settled, so it exercises
    // steady-state routing and never the window the host actually moves in.
    //
    // Its own test rather than an extension of that one, because the property
    // is different in kind.  That test asserts *where* the singleton lives and
    // that the leader never moved; this one asserts that a message in flight
    // while it moves is neither lost nor duplicated — which needs traffic
    // straddling the move, and a dead-letter collector on every node to prove
    // "not delivered" and "delivered elsewhere" apart.
    //
    // The window is real and it is one the framework opens itself: the incoming
    // host is elected in the *sender's* view a gossip round before its own
    // manager has an instance, and since #949 it deliberately holds its spawn
    // until every eligible peer has confirmed its instance is gone.  Everything
    // routed there in between has to be held and flushed, not dead-lettered —
    // paying for "at most one instance" with loss on every host move is not the
    // trade being made.
    const systemName = 'sng-host-move-traffic';
    const seeds = [`${systemName}@h:52540`];
    const nodeA = await startNode({ systemName, port: 52540, seeds: [], roles: [] });
    const nodeB = await startNode({ systemName, port: 52560, seeds, roles: ['worker'] });
    await waitFor(() => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2);

    // On every node, not just the sender: a message lost on the *receiving*
    // side lands on that node's dead-letter stream, and the criterion is that
    // no such letter exists anywhere in the cluster.  Collecting only on the
    // sender is how this hole stayed invisible — the loss is entirely on the
    // incoming host's side.
    const dead: unknown[] = [];
    nodeA.system.spawn(() => new DeadLetterCollector(dead), 'dead-letter-collector');
    nodeB.system.spawn(() => new DeadLetterCollector(dead), 'dead-letter-collector');

    const census = new SingletonCensus();
    const startOn = (node: Node, where: string, stopDelayMs = 0): ActorRef<string> => {
      const singletonOptions = StartSingletonOptions.create<string>()
        .withTypeName('needs-worker-traffic')
        .withRole('worker')
        .withActor(() => new SlowStoppingCensusMarker(census, where, stopDelayMs));
      return node.cluster.singleton.start(singletonOptions);
    };

    // A hosts nothing — it carries no role — so every send below crosses the
    // wire, which is the case the criterion is about.
    //
    // B's instance takes 400 ms to stop, which is what makes this test a
    // measurement rather than a coin flip.  The window under test is "C is the
    // host in A's view and has no instance yet", and its width is exactly how
    // long B takes to confirm it has stood down: B answers the hand-over only
    // once its own `postStop` has completed (#949).  With an instant `postStop`
    // the window is a millisecond or two and the pump misses it more often than
    // it hits it.
    const fromLeader = startOn(nodeA, 'a') as ClusterSingletonProxy<string>;
    startOn(nodeB, 'b', 400);
    await waitFor(() => census.liveOn('b') === 1);

    const sent: string[] = [];
    const pump = async (): Promise<void> => {
      const payload = `m${sent.length}`;
      sent.push(payload);
      fromLeader.tell(payload);
      // A real timer between sends, and this is the one detail that decides
      // whether the test measures anything at all: `InMemoryTransport` delivers
      // by `queueMicrotask`, so a pump that only yielded microtasks would be
      // starved to zero sends across the take-over — it completes inside a
      // single microtask drain.  The reported figure would then be "nothing
      // dropped out of nothing in flight".
      await sleep(5);
    };

    // C joins and starts its singleton *before* any traffic is aimed at it, so
    // what is measured is the framework's own window and not a deployment that
    // routes to a node which never called `start()`.  Both are real; only this
    // one is #637's.
    const nodeC = await startNode({ systemName, port: 52550, seeds, roles: ['worker'] });
    nodeC.system.spawn(() => new DeadLetterCollector(dead), 'dead-letter-collector');

    // C's own view has to know about B before C's manager first reconciles, and
    // that is a precondition rather than tidiness.  `takeOverHosting` asks the
    // peers *its own view* calls eligible: a manager that starts before gossip
    // has delivered B finds nobody to ask, spawns at once, and the window this
    // test exists to cover never opens (it also runs two instances for a
    // moment, which is #949's staleness gap and not this test's subject).
    await waitFor(() => nodeC.cluster.upMembersWithRole('worker').length === 2);
    startOn(nodeC, 'c');

    // Phase 1 — pump until C's instance exists.  Bounded by that rather than by
    // a message count, so the traffic spans the window on a loaded machine as
    // well as an idle one; the cap only turns a take-over that never happens
    // into a failed assertion instead of a hang.
    while (census.liveOn('c') === 0 && sent.length < 400) await pump();
    const sentBeforeHostExisted = sent.length;

    // Phase 2 — a short tail once C is hosting, so the steady state after the
    // move is covered too.
    for (let index = 0; index < 5; index++) await pump();

    await waitFor(() => census.received.length === sent.length, 10_000);
    // An absence, so it cannot be polled for: the counts are already equal
    // above, and what this proves is that they *stay* equal — no duplicate
    // arrives late from a second instance, and no held message is flushed
    // twice.
    await sleep(300);

    // Every payload exactly once, wherever it landed.  A sorted multiset and
    // not a set: a buffer flushed twice is the failure mode holding introduces,
    // and a set comparison would hide exactly that.
    const arrived = census.received.map((entry) => entry.slice(entry.indexOf(':') + 1));
    expect([...arrived].sort()).toEqual([...sent].sort());
    expect(arrived.length).toBe(sent.length);

    // The criterion's second half, on both sides of the wire.
    expect(fromLeader.droppedCount).toBe(0);
    expect(dead).toEqual([]);

    // And the measurement was not vacuous.  Without this the test would pass
    // just as happily by sending everything after the dust had settled — which
    // is precisely the gap in the first test in this file that this one exists
    // to fill, so leaving it unasserted would reproduce that gap one test
    // further down.
    // B's `postStop` takes 400 ms and the pump sends every 5 ms, so this is
    // dozens in practice; the assertion is loose because what matters is that
    // the window was entered at all, not how wide it was on this machine.
    expect(sentBeforeHostExisted).toBeGreaterThan(5);
    expect(census.liveOn('c')).toBe(1);
    expect(census.total()).toBe(1);
    expect(nodeA.cluster.isLeader()).toBe(true);

    await stopNode(nodeC); await stopNode(nodeB); await stopNode(nodeA);
  }, 60_000);

  test('the proxy buffer drains when the first role member joins', async () => {
    // The deterministic half of the defect.  With one role-less node the
    // singleton has no host, so every tell buffers; the first role-carrying
    // member to join changes no leader, and `drainBuffer` had exactly two call
    // sites — construction and `LeaderChanged` — so the buffer never drained.
    // Messages sent *afterwards* routed normally, which is what made it look
    // like a race rather than a permanent hole.
    //
    // What is asserted is the drain, not the arrival.  A drained message is
    // handed to whichever node is now the host, and that node's manager can
    // still be a gossip round away from having spawned its child — where it
    // now dead-letters rather than being dropped, which the last test in this
    // file covers.  The buffer never draining at all is what this covers, and
    // it is the half that never recovered on its own.
    const systemName = 'sng-host-drain';
    const seeds = [`${systemName}@h:52501`];
    const nodeA = await startNode({ systemName, port: 52501, seeds: [], roles: [] });
    await waitFor(() => nodeA.cluster.leader().nonEmpty);

    const census = new SingletonCensus();
    const singletonOptionsA = StartSingletonOptions.create<string>()
      .withTypeName('buffered-worker')
      .withRole('worker')
      .withActor(() => new CensusMarker(census, 'a'));
    const proxy = nodeA.cluster.singleton.start(singletonOptionsA) as ClusterSingletonProxy<string>;

    // Nobody carries the role yet, so this is held rather than routed.
    proxy.tell('buffered-before-any-host');
    // Two of the three claims here are absences — nothing dropped, nothing
    // delivered — and they hold at t=0, so the window is what would disprove
    // them.  `hasPending()` alone would be satisfied before either could fail.
    await sleep(100);
    expect(proxy.hasPending()).toBe(true);
    expect(proxy.droppedCount).toBe(0);
    expect(census.total()).toBe(0);

    const leaderChangesOnA = recordLeaderChanges(nodeA);

    const nodeB = await startNode({ systemName, port: 52502, seeds, roles: ['worker'] });
    const singletonOptionsB = StartSingletonOptions.create<string>()
      .withTypeName('buffered-worker')
      .withRole('worker')
      .withActor(() => new CensusMarker(census, 'b'));
    nodeB.cluster.singleton.start(singletonOptionsB);

    await waitFor(() => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2);
    await waitFor(() => census.liveOn('b') === 1);

    // Before the fix this stayed pending forever — nothing left to fire.
    await waitFor(() => !proxy.hasPending(), 8_000);
    expect(proxy.hasPending()).toBe(false);
    expect(proxy.droppedCount).toBe(0);

    // A is still the leader it was when the message was buffered, so no
    // `LeaderChanged` was ever available to drain on.
    expect(nodeA.cluster.isLeader()).toBe(true);
    expect(leaderChangesOnA).toEqual([]);

    // And the proxy now routes to the node that joined.
    census.received.length = 0;
    proxy.tell('after-host-exists');
    await waitFor(() => census.received.length > 0);
    expect(census.received).toEqual(['b:after-host-exists']);

    await stopNode(nodeB); await stopNode(nodeA);
  }, 30_000);

  test('a role host that is only unreachable keeps its singleton, and no peer spawns a second', async () => {
    // The regression #637 introduced into its own fix, and the trade that
    // replaced it.
    //
    // An unreachable member drops out of `upMembers()` without being removed,
    // so `singletonHost` genuinely moves — which is why the fix put
    // `MemberUnreachable` in the trigger set, to cure "hosted nowhere until
    // `downAfterMs`".  But unreachability is one node's opinion *about*
    // another, and the member it is about cannot hear the peers that formed it
    // — reaching it is the thing that failed.  So B keeps its child, because
    // nothing is able to tell it to stop.  Reconciling on the event does not
    // move the singleton, it duplicates it, and no leader change follows to
    // resolve it.  Measured with the assertion below: `total=2 b=1 c=1`.
    //
    // Peers therefore no longer promote themselves on it.  What is asserted is
    // the invariant *and where it lives* — "nobody spawned anything" would
    // satisfy a count of one just as well, and that is a different bug.
    const systemName = 'sng-host-unreachable';
    const seeds = [`${systemName}@h:52511`];
    const nodeA = await startNode({ systemName, port: 52511, seeds: [], roles: [] });
    const nodeB = await startNode({ systemName, port: 52512, seeds, roles: ['worker'] });
    const nodeC = await startNode({ systemName, port: 52513, seeds, roles: ['worker'] });
    await waitFor(() => [nodeA, nodeB, nodeC].every(n => n.cluster.upMembers().length === 3));

    const census = new SingletonCensus();
    for (const [node, where] of [[nodeA, 'a'], [nodeB, 'b'], [nodeC, 'c']] as const) {
      const singletonOptions = StartSingletonOptions.create<string>()
        .withTypeName('unreachable-worker')
        .withRole('worker')
        .withActor(() => new CensusMarker(census, where));
      node.cluster.singleton.start(singletonOptions);
    }

    // B sorts first among the role members.
    await waitFor(() => census.liveOn('b') === 1);
    expect(nodeA.cluster.isLeader()).toBe(true);

    const leaderChangesOnC = recordLeaderChanges(nodeC);

    // Silence B without letting it leave: its peers' failure detectors move it
    // to `unreachable`, which is a status change with no membership change.
    await nodeB.transport.shutdown();

    // Wait for the thing under test to have actually happened on C — the
    // detector fires at 300 ms — and then give a promotion a full second more
    // to show up.  Without that second the assertion could pass by being early
    // rather than by being right.
    await waitFor(() => isUnreachableOn(nodeC, 52512), 10_000);
    // The extra second, per the note above: the assertion is that the singleton
    // did NOT move, which is already true the moment the detector fires.  Only
    // elapsed time distinguishes "did not move" from "has not moved yet".
    await sleep(1_000);
    expect(census.total()).toBe(1);
    expect(census.liveOn('b')).toBe(1);
    expect(census.liveOn('c')).toBe(0);
    expect(census.liveOn('a')).toBe(0);

    // The premise held: B is unreachable on C's books but still a member — not
    // downed, `downAfterMs` is a minute away — and C never saw a leader change,
    // so nothing else could have been the reason nothing moved.
    expect(nodeC.cluster.getMembers().length).toBe(3);
    expect(leaderChangesOnC).toEqual([]);

    await stopNode(nodeC); await stopNode(nodeB); await stopNode(nodeA);
  }, 30_000);

  test('a message routed to a node that is not hosting goes to dead letters', async () => {
    // The other half of the trade above.  Peers of an unreachable role host
    // route to the next role member, which is deliberately not hosting, so the
    // manager's undeliverable path stops being an edge case and becomes the
    // path every message from that side takes.  It logged a warning and
    // dropped the message on the floor — nothing on the dead-letter stream, so
    // no metric, no DevTools entry, nothing to assert.  Both of the proxy's
    // undeliverable paths already dead-letter; this is the same event seen
    // from the far end of the wire.
    //
    // Reached here without a partition: `restartOnTermination: false` leaves
    // this node the elected host with a manager that will never spawn again,
    // which is exactly the "routed here, not hosting" state and is the only
    // form of it a single node can hold still.
    const systemName = 'sng-not-hosted';
    const nodeA = await startNode({ systemName, port: 52514, seeds: [], roles: [] });
    await waitFor(() => nodeA.cluster.leader().nonEmpty);

    const dead: unknown[] = [];
    nodeA.system.spawn(() => new DeadLetterCollector(dead), 'dead-letter-collector');

    const census = new SingletonCensus();
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('quitting-worker')
      .withActor(() => new QuittingCensusMarker(census, 'a'))
      .withRestartOnTermination(false);
    const proxy = nodeA.cluster.singleton.start(singletonOptions);
    await waitFor(() => census.liveOn('a') === 1);

    proxy.tell('die');
    // `postStop` has run, and the `Terminated` that follows it clears the
    // manager's `child` — so from here the manager, not a dead child ref, is
    // what the message meets.
    await waitFor(() => census.liveOn('a') === 0);
    // Settle before the next probe: the manager has to have finished clearing
    // `child` for the following tell to meet the manager rather than a dead
    // ref, and that clearing has no observable beyond the census above.
    await sleep(300);

    census.received.length = 0;
    dead.length = 0;
    proxy.tell('nobody-is-hosting-this');

    await waitFor(() => dead.length > 0);
    expect(dead).toEqual(['nobody-is-hosting-this']);
    expect(census.received).toEqual([]);
    // Still the elected host, which is what makes this the manager's path and
    // not the proxy's `onMissingHost`.
    expect(nodeA.cluster.isLeader()).toBe(true);

    nodeA.cluster.singleton.stop('quitting-worker');
    await stopNode(nodeA);
  }, 20_000);
});
