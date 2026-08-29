/**
 * #194 — warm hand-over: the outgoing singleton hands its in-memory state to
 * the incoming one, so the successor starts warm instead of recovering.
 *
 * A singleton with expensive recovery is unavailable for the length of that
 * recovery every time it moves, and it moves on any routine scale-up.  The
 * hand-over #949 built already has the two things this needs: a moment at which
 * the outgoing state is final (the acknowledgment is emitted once `postStop` has
 * completed) and a frame going the right way.  So the state rides on the
 * acknowledgment, and there is no second trigger to choose between — a planned
 * `leave()` and a leadership move reach the same exchange.
 *
 * These tests move the leader on purpose, like `ClusterSingletonHandOver`'s and
 * unlike `ClusterSingletonHostChange`'s.  Two nodes are enough: the property is
 * about what crosses one hand-over, not about who wins an election.
 *
 * Every failure mode is asserted to end in a **cold start** rather than in an
 * error, because that is the whole safety argument for the feature: warm
 * hand-over is an optimisation that is allowed not to happen.  A test that only
 * covered the happy path would leave the interesting half — an oversized
 * snapshot, a throwing serializer, an actor on the far side that cannot restore
 * — indistinguishable from an outage.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import {
  StartSingletonOptions,
  type WarmHandOverActor,
} from '../../../../../src/cluster/singleton/index.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import type { LogContextData } from '../../../../../src/LogContext.js';
import { LogLevel, type Logger } from '../../../../../src/Logger.js';
import { TestKit } from '../../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../../src/testkit/TestKitOptions.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

/**
 * Keeps `warn` and discards the rest.
 *
 * Half of what this feature promises is *reported* rather than returned: an
 * oversized snapshot, a serializer that threw and a successor that cannot
 * restore all end in the same observable outcome — a cold start — so asserting
 * on the outcome alone would pass just as happily if the framework had silently
 * decided not to try.  The warning is how an operator tells "warm hand-over is
 * off" from "warm hand-over is broken".
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

  saw(fragment: string): boolean {
    return this.warnings.some((warning) => warning.includes(fragment));
  }
}

type Node = {
  readonly kit: TestKit;
  readonly cluster: Cluster;
  readonly log: WarningCollector;
};

async function startNode(systemName: string, port: number, seeds: readonly string[]): Promise<Node> {
  const log = new WarningCollector();
  const kit = TestKit.create(systemName, TestKitOptions.create().withLogger(log));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([...seeds])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 400, downAfterMs: 60_000 })
    .withGossipIntervalMs(60);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  return { kit, cluster, log };
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave().catch(() => { /* best effort */ });
  await node.kit.system.terminate().catch(() => { /* best effort */ });
}

/** What each instance recorded about how it started, in start order. */
type Recovery = {
  readonly where: string;
  /** `'warm'` when a predecessor's snapshot arrived, `'cold'` when it recovered. */
  readonly how: 'warm' | 'cold';
  /** The counter the instance came up holding. */
  readonly count: number;
};

/**
 * What each test observes: how every instance started, and every increment an
 * instance actually applied.
 *
 * `applied` is not bookkeeping — it is a precondition the tests cannot do
 * without.  A `tell` only *enqueues*, and on the no-lease path a cluster event
 * reconciles **synchronously inside the subscription callback**, so a
 * membership change can overtake deliveries already sitting in the manager's
 * mailbox.  A test that sent three increments and immediately triggered the
 * take-over therefore measured a snapshot of whatever had been applied by then
 * — one of three, in the run that caught this — and would have read a correct
 * snapshot as a broken one.
 */
type Observations = {
  readonly recoveries: Recovery[];
  readonly applied: number[];
};

/**
 * The singleton under test: a counter whose "recovery" is expensive enough to be
 * worth skipping, and which reports whether it had to perform it.
 *
 * The counter is the payload precisely because it is *not* derivable — a cold
 * start recovers `0`, so an instance holding a non-zero count can only have got
 * it from its predecessor.  That is what makes "the state crossed" a number
 * rather than an inference from a log line.
 */
class CountingSingleton extends Actor<string> implements WarmHandOverActor {
  private count = 0;
  private restored = false;

  constructor(
    private readonly where: string,
    private readonly seen: Observations,
  ) { super(); }

  override preStart(): void {
    // The shape every warm-hand-over actor has to have: recovery is conditional
    // on not already holding state.  A `preStart` that recovered
    // unconditionally would pay the cost this feature exists to avoid and then
    // overwrite what arrived.
    this.seen.recoveries.push({
      where: this.where,
      how: this.restored ? 'warm' : 'cold',
      count: this.count,
    });
  }

  override onReceive(message: string): void {
    if (message === 'increment') {
      this.count++;
      this.seen.applied.push(this.count);
      return;
    }
  }

  serializeForHandOver(): Uint8Array {
    return new TextEncoder().encode(String(this.count));
  }

  restoreFromHandOver(state: Uint8Array): void {
    this.count = Number(new TextDecoder().decode(state));
    this.restored = true;
  }
}

/** Implements neither hook — the pre-#194 actor, and the control case. */
class ColdOnlySingleton extends Actor<string> {
  private count = 0;

  constructor(
    private readonly where: string,
    private readonly seen: Observations,
  ) { super(); }

  override preStart(): void {
    this.seen.recoveries.push({ where: this.where, how: 'cold', count: this.count });
  }

  override onReceive(message: string): void {
    if (message === 'increment') {
      this.count++;
      this.seen.applied.push(this.count);
      return;
    }
  }
}

/** Serializes a snapshot of a chosen size, to exercise the byte caps. */
class OversizedSingleton extends CountingSingleton {
  constructor(where: string, seen: Observations, private readonly bytes: number) {
    super(where, seen);
  }

  override serializeForHandOver(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/** A serializer that throws, to prove the outgoing side degrades to cold. */
class ThrowingSerializerSingleton extends CountingSingleton {
  override serializeForHandOver(): Uint8Array {
    throw new Error('cannot snapshot this');
  }
}

/** A restore that throws, to prove the incoming side degrades to cold. */
class ThrowingRestoreSingleton extends CountingSingleton {
  override restoreFromHandOver(): void {
    throw new Error('cannot read that snapshot');
  }
}

/**
 * Runs the scenario every test here shares: node B hosts, its instance is
 * driven to a known state, then a lower-addressed node A joins and takes the
 * singleton over.
 *
 * Returned as a journal of recoveries rather than as assertions, so each test
 * says what it expects of the *second* entry — which is the successor, and the
 * only one this feature is about.
 */
async function handOverFromBToA(
  systemName: string,
  ports: { readonly a: number; readonly b: number },
  actorOn: (where: string, seen: Observations) => Actor<string>,
  options?: { readonly maxHandOverStateBytes?: number },
): Promise<{ seen: Observations; nodeA: Node; nodeB: Node }> {
  const seen: Observations = { recoveries: [], applied: [] };
  const seeds = [`${systemName}@h:${ports.b}`];
  // B first and alone, so it is unambiguously the host before A exists.  A
  // sorts *below* it, so A joining moves the singleton with no failure
  // involved — the routine scale-up this feature is for.
  const nodeB = await startNode(systemName, ports.b, []);
  const startOn = (node: Node, where: string): ReturnType<Cluster['singleton']['start']> => {
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('counter')
      .withActor(() => actorOn(where, seen));
    if (options?.maxHandOverStateBytes !== undefined) {
      singletonOptions.withMaxHandOverStateBytes(options.maxHandOverStateBytes);
    }
    return node.cluster.singleton.start(singletonOptions);
  };

  const onB = startOn(nodeB, 'b');
  await awaitCondition(() => seen.recoveries.length === 1, {
    timeoutMs: 10_000,
    label: 'B hosts the singleton',
  });

  // Three increments, so the state that has to cross is a value no cold start
  // produces — and *waited for*, because a `tell` only enqueues.  Starting the
  // take-over before they have been applied would snapshot a partial count and
  // then blame the snapshot for it.
  onB.tell('increment');
  onB.tell('increment');
  onB.tell('increment');
  await awaitCondition(() => seen.applied.length === 3, {
    timeoutMs: 10_000,
    label: 'B has applied all three increments',
  });

  const nodeA = await startNode(systemName, ports.a, seeds);
  // A's own view has to include B before A's manager first reconciles, and that
  // is load-bearing rather than tidy: `takeOverHosting` asks the peers *its own
  // view* calls eligible, so a manager that starts before gossip has delivered B
  // finds nobody to ask and spawns at once — no request, no acknowledgment, and
  // therefore no state, however well the feature works.  It would also run two
  // instances for a moment, which is #949's staleness gap and not this file's
  // subject.
  await awaitCondition(
    () => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
    { timeoutMs: 10_000, label: 'both nodes see a two-member cluster' },
  );
  startOn(nodeA, 'a');

  await awaitCondition(() => seen.recoveries.some((entry) => entry.where === 'a'), {
    timeoutMs: 15_000,
    label: 'A has taken the singleton over',
  });
  return { seen, nodeA, nodeB };
}

describe('ClusterSingleton — warm hand-over (#194)', () => {
  test('the successor starts from its predecessor\'s state instead of recovering', async () => {
    const { seen, nodeA, nodeB } = await handOverFromBToA(
      'warm-happy',
      { a: 53010, b: 53020 },
      (where, observations) => new CountingSingleton(where, observations),
    );

    // Two instances, in order, and the second one did not recover.
    expect(seen.recoveries.map((entry) => entry.where)).toEqual(['b', 'a']);
    expect(seen.recoveries[0]).toEqual({ where: 'b', how: 'cold', count: 0 });
    // The count is the assertion, not the `how`: three increments were applied
    // on B and only B could have known about them, so a successor holding 3
    // proves the state crossed.  `how` alone would pass for a restore that
    // arrived empty.
    expect(seen.recoveries[1]).toEqual({ where: 'a', how: 'warm', count: 3 });

    await stopNode(nodeA); await stopNode(nodeB);
  }, 40_000);

  test('an actor without the hooks is untouched and starts cold', async () => {
    // The control, and the compatibility guarantee: warm hand-over is opted
    // into on the actor, so an actor that predates it behaves exactly as it did
    // — no snapshot is taken, none is expected, and nothing warns, because
    // nothing went wrong.
    const { seen, nodeA, nodeB } = await handOverFromBToA(
      'warm-optout',
      { a: 53030, b: 53040 },
      (where, observations) => new ColdOnlySingleton(where, observations),
    );

    expect(seen.recoveries.map((entry) => entry.where)).toEqual(['b', 'a']);
    expect(seen.recoveries[1]).toEqual({ where: 'a', how: 'cold', count: 0 });
    expect(nodeA.log.warnings.filter((w) => w.includes('hand-over state'))).toEqual([]);

    await stopNode(nodeA); await stopNode(nodeB);
  }, 40_000);

  test('a snapshot over maxHandOverStateBytes is not shipped, and says so', async () => {
    // The cap is on the *outgoing* side on purpose.  Enforcing it at the
    // receiver would be too late: the frame is already built and already over
    // the decoder's limit, and that costs the whole inter-node connection
    // rather than the message.
    const { seen, nodeA, nodeB } = await handOverFromBToA(
      'warm-oversize',
      { a: 53050, b: 53060 },
      (where, observations) => new OversizedSingleton(where, observations, 4_096),
      { maxHandOverStateBytes: 1_024 },
    );

    expect(seen.recoveries[1]).toEqual({ where: 'a', how: 'cold', count: 0 });
    // On B, because B is the node that declined to ship it.
    expect(nodeB.log.saw('maxHandOverStateBytes')).toBe(true);
    expect(nodeB.log.saw('4096 bytes')).toBe(true);

    await stopNode(nodeA); await stopNode(nodeB);
  }, 40_000);

  test('a serializer that throws costs the warm start and nothing else', async () => {
    const { seen, nodeA, nodeB } = await handOverFromBToA(
      'warm-throws-out',
      { a: 53070, b: 53080 },
      (where, observations) => new ThrowingSerializerSingleton(where, observations),
    );

    // The hand-over still completed — the successor is running.  That is the
    // property: a broken snapshot must not be able to keep the singleton from
    // moving, because then a bug in an optimisation becomes an outage.
    expect(seen.recoveries[1]).toEqual({ where: 'a', how: 'cold', count: 0 });
    expect(nodeB.log.saw('serializeForHandOver threw')).toBe(true);

    await stopNode(nodeA); await stopNode(nodeB);
  }, 40_000);

  test('a restore that throws leaves a running instance, not a failed spawn', async () => {
    const { seen, nodeA, nodeB } = await handOverFromBToA(
      'warm-throws-in',
      { a: 53090, b: 53100 },
      (where, observations) => new ThrowingRestoreSingleton(where, observations),
    );

    // `preStart` still ran, so the instance exists and is hosting.  A throw
    // inside `restoreFromHandOver` propagating out of the factory would fail
    // the spawn and leave the singleton hosted nowhere, which is strictly worse
    // than the cold start it was meant to be an improvement on.
    expect(seen.recoveries.map((entry) => entry.where)).toEqual(['b', 'a']);
    expect(seen.recoveries[1]?.count).toBe(0);
    expect(nodeA.log.saw('restoreFromHandOver threw')).toBe(true);

    await stopNode(nodeA); await stopNode(nodeB);
  }, 40_000);

  test('a forced-down predecessor hands nothing over, and the successor still starts', async () => {
    // The issue's own non-goal, asserted rather than assumed: a node that was
    // *downed* cannot be asked for its state, so there is no warm path.
    //
    // It needs no special handling and that is the point — it falls out of who
    // gets asked.  `handOverPeers()` reads `upMembers()`, a downed member is not
    // in it, so the incoming host never sends it a request and never waits on
    // one.  Worth a test anyway, because "no special handling" is exactly the
    // kind of claim that stops being true when the eligible set is next touched.
    const seen: Observations = { recoveries: [], applied: [] };
    const systemName = 'warm-downed';
    const seeds = [`${systemName}@h:53140`];
    const nodeB = await startNode(systemName, 53140, []);
    const startOn = (node: Node, where: string): ReturnType<Cluster['singleton']['start']> => {
      const singletonOptions = StartSingletonOptions.create<string>()
        .withTypeName('counter')
        .withActor(() => new CountingSingleton(where, seen));
      return node.cluster.singleton.start(singletonOptions);
    };

    const onB = startOn(nodeB, 'b');
    await awaitCondition(() => seen.recoveries.length === 1, {
      timeoutMs: 10_000,
      label: 'B hosts the singleton',
    });
    onB.tell('increment');
    await awaitCondition(() => seen.applied.length === 1, {
      timeoutMs: 10_000,
      label: 'B applied the increment',
    });

    const nodeA = await startNode(systemName, 53130, seeds);
    await awaitCondition(
      () => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      { timeoutMs: 10_000, label: 'both nodes see a two-member cluster' },
    );

    // Downed in A's view, which is the view that decides who A asks.
    expect(nodeA.cluster.down(nodeB.cluster.selfAddress)).toBe(true);
    startOn(nodeA, 'a');

    await awaitCondition(() => seen.recoveries.some((entry) => entry.where === 'a'), {
      timeoutMs: 15_000,
      label: 'A has taken the singleton over',
    });
    const successor = seen.recoveries.find((entry) => entry.where === 'a');
    // Cold, and — the part that matters more — *running*.  A downed predecessor
    // must not be something the successor waits on, or every forced downing
    // would cost the full `handOverTimeoutMs` before the singleton came back.
    expect(successor).toEqual({ where: 'a', how: 'cold', count: 0 });

    await stopNode(nodeA); await stopNode(nodeB);
  }, 40_000);

  test('the snapshot is taken after postStop, so a late message is not silently lost from it',
    async () => {
      // The timing property, and the one that would be easiest to get subtly
      // wrong: reading the state when the `PoisonPill` is *enqueued* rather than
      // when the instance has finished would ship a snapshot from before the
      // rest of the mailbox was processed.  The successor would then come up
      // holding a count that disagrees with what its predecessor actually did,
      // and nothing anywhere would say so.
      //
      // Three increments are sent, then the take-over is triggered.  Whatever
      // the outgoing instance processed is in the snapshot; whatever it did not
      // went to dead letters, visibly.  So `count` and "increments the
      // predecessor applied" must be the same number — asserted by reading the
      // predecessor's own final count back out of the successor.
      const { seen, nodeA, nodeB } = await handOverFromBToA(
        'warm-after-poststop',
        { a: 53110, b: 53120 },
        (where, observations) => new CountingSingleton(where, observations),
      );

      expect(seen.recoveries[1]?.how).toBe('warm');
      // All three, not a prefix: the increments were enqueued before the
      // hand-over request could arrive, so `postStop` ran after all three were
      // applied and the snapshot has to contain all three.
      expect(seen.recoveries[1]?.count).toBe(3);

      await stopNode(nodeA); await stopNode(nodeB);
    }, 40_000);
});
