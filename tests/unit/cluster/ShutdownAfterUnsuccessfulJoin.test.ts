/**
 * #1500 — `actor-ts.cluster.shutdown-after-unsuccessful-join`: a join that
 * nothing can complete gives up instead of dialling its seeds for good.
 *
 * A node on a bare `Cluster.join` whose seeds never answer used to retry
 * forever: the seed loop cancels only once self is `up`, or in `leave()`.  On
 * an orchestrator that is a process which never joins and never exits.  The
 * key gives the join a deadline of its own — and the deadline is when the node
 * decides, not what decides: it gives up only if nothing can still promote it,
 * which is the same verdict the cold-start stall warning states.
 *
 * Driven by a {@link ManualScheduler}, because every claim here is about the
 * round or the instant something happens at, which a real timer could only be
 * asked about approximately.  The harness is ColdStartStallDiagnosis's — seeds
 * no transport is registered under, so `InMemoryTransport` drops each contact
 * and the loop keeps running — plus a `before-service-unbind` task that
 * records the reason of every pipeline run.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { SelfElectionPolicy } from '../../../src/cluster/ClusterOptions.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { GossipMessage, LeaveMessage, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Config } from '../../../src/config/Config.js';
import { ClusterJoinUnsuccessfulReason, CoordinatedShutdownId, Phases, type Reason } from '../../../src/index.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { LogLevel, type Logger } from '../../../src/Logger.js';
import type { Cancellable } from '../../../src/Scheduler.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/** One seed round of virtual time. */
const RETRY_INTERVAL_MS = 100;

/** Ten rounds — well past the three the stall line waits for, so the two are told apart. */
const DEADLINE_MS = RETRY_INTERVAL_MS * 10;

/** "Several rounds past the deadline", for the cases that must not give up. */
const PAST_THE_DEADLINE_MS = DEADLINE_MS + RETRY_INTERVAL_MS * 5;

/** The host every node and its seeds live on; each case takes its own ports. */
const HOST = '10.0.152.1';
const SEED_HOST = '10.0.152.2';

type LogRecord = { readonly level: string; readonly message: string };

/** Collects everything the system logger was told, including via `withSource`. */
class RecordingLogger implements Logger {
  readonly records: LogRecord[] = [];

  constructor(
    readonly level: LogLevel = LogLevel.Debug,
    private readonly root: RecordingLogger | null = null,
  ) {}

  private get sink(): RecordingLogger { return this.root ?? this; }

  private record(level: string, message: string): void {
    this.sink.records.push({ level, message });
  }

  debug(message: string): void { this.record('debug', message); }
  info(message: string): void { this.record('info', message); }
  warn(message: string): void { this.record('warn', message); }
  error(message: string): void { this.record('error', message); }

  withSource(_source: string): Logger { return new RecordingLogger(this.level, this.sink); }
  withFields(_fields: LogContextData): Logger { return new RecordingLogger(this.level, this.sink); }
}

/** What a case configures; each one names only the inputs it is about. */
type NodeSpec = {
  /** Passed to `withShutdownAfterUnsuccessfulJoinMs`; absent leaves the builder field unset. */
  readonly giveUpMs?: number;
  /** Layered over `reference.conf` through `ActorSystemOptions.withConfig`. */
  readonly hocon?: string;
  readonly selfElection?: SelfElectionPolicy;
  readonly minimumMembersBeforeUp?: number;
  readonly weaklyUpAfterMs?: number;
};

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
  readonly seed: NodeAddress;
  readonly scheduler: ManualScheduler;
  readonly logger: RecordingLogger;
  /** The reason of every pipeline run, as a `before-service-unbind` task saw it. */
  readonly reasons: Reason[];
};

/** Every system a case created, so a join that throws still leaves nothing running. */
let systems: ActorSystem[] = [];
let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
  }
  for (const system of systems) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
  systems = [];
});

/** A system on its own {@link ManualScheduler}, with the reason recorder registered. */
function createSystem(systemName: string, spec: NodeSpec): {
  system: ActorSystem; scheduler: ManualScheduler; logger: RecordingLogger; reasons: Reason[];
} {
  const logger = new RecordingLogger();
  const scheduler = new ManualScheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Debug)
    .withScheduler(scheduler);
  if (spec.hocon !== undefined) systemOptions.withConfig(Config.parseString(spec.hocon));
  const system = ActorSystem.create(systemName, systemOptions);
  systems.push(system);
  const reasons: Reason[] = [];
  system.extension(CoordinatedShutdownId).addTask(Phases.BeforeServiceUnbind, 'record-the-reason', (reason) => {
    reasons.push(reason);
  });
  return { system, scheduler, logger, reasons };
}

/**
 * A node whose one seed nobody answers on, so the retry loop keeps running —
 * which is exactly the state under test.  The seed shares the node's port
 * number on another host, which keeps each case's addresses its own.
 */
async function startNode(systemName: string, port: number, spec: NodeSpec = {}): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, HOST, port);
  const seed = new NodeAddress(systemName, SEED_HOST, port);
  const { system, scheduler, logger, reasons } = createSystem(systemName, spec);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withSeeds([`${SEED_HOST}:${port}`])
    .withSeedRetryIntervalMs(RETRY_INTERVAL_MS)
    .withFailureDetector({
      heartbeatIntervalMs: 60_000,
      unreachableAfterMs: 120_000,
      downAfterMs: 240_000,
    })
    .withGossipIntervalMs(60_000);
  if (spec.giveUpMs !== undefined) clusterOptions.withShutdownAfterUnsuccessfulJoinMs(spec.giveUpMs);
  if (spec.selfElection !== undefined) clusterOptions.withSelfElection(spec.selfElection);
  if (spec.minimumMembersBeforeUp !== undefined) {
    clusterOptions.withMinimumMembersBeforeUp(spec.minimumMembersBeforeUp);
  }
  if (spec.weaklyUpAfterMs !== undefined) clusterOptions.withWeaklyUpAfterMs(spec.weaklyUpAfterMs);
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, address, seed, scheduler, logger, reasons };
  nodes.push(node);
  return node;
}

/** The private surface these tests reach through — merge internals and the two timers, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: GossipMessage | LeaveMessage): void;
  readonly members: Map<string, Member>;
  readonly seedRounds: number;
  readonly seedTimer: Cancellable | null;
  readonly joinGiveUpTimer: Cancellable | null;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

function selfStatus(node: NodeHandle): MemberStatus | undefined {
  return internals(node.cluster).members.get(node.address.toString())?.status;
}

/**
 * Put one peer in the member map at `status`, the way gossip would — the frame
 * announces only the peer itself, the one claim `maySpeakFor` never refuses.
 */
function introducePeer(node: NodeHandle, peer: NodeAddress, status: MemberStatus): void {
  internals(node.cluster).handleWire(peer, {
    kind: 'gossip',
    from: peer.toJSON(),
    sequence: Date.now(),
    members: [{ address: peer.toJSON(), status, version: Date.now(), roles: [] }],
  });
}

/** The peer's own `leave` frame — it leaves a `removed` tombstone behind, as a departed peer does. */
function peerLeaves(node: NodeHandle, peer: NodeAddress): void {
  internals(node.cluster).handleWire(peer, { kind: 'leave', node: peer.toJSON() });
}

function warningsContaining(node: NodeHandle, text: string): string[] {
  return node.logger.records
    .filter((r) => r.level === 'warn' && r.message.includes(text))
    .map((r) => r.message);
}

const giveUpWarnings = (node: NodeHandle): string[] => warningsContaining(node, 'giving up the join');
const stallWarnings = (node: NodeHandle): string[] => warningsContaining(node, 'nothing can promote this node');
const thresholdWarnings = (node: NodeHandle): string[] =>
  warningsContaining(node, 'actor-ts.cluster.minimum-members-before-up holds');

/** Nothing gave up: no line, no pipeline run, and the node is still trying. */
function expectStillJoining(node: NodeHandle, status: MemberStatus = 'joining'): void {
  expect(giveUpWarnings(node)).toEqual([]);
  expect(node.reasons).toEqual([]);
  expect(node.system.extension(CoordinatedShutdownId).isRunning).toBe(false);
  expect(selfStatus(node)).toBe(status);
}

/** The give-up happened, once, and the pipeline it ran saw the join's own reason. */
function expectGaveUp(node: NodeHandle): void {
  expect(giveUpWarnings(node)).toHaveLength(1);
  expect(node.reasons).toEqual([ClusterJoinUnsuccessfulReason.instance]);
  // `leave()` ran synchronously inside the give-up, ahead of the pipeline's
  // own phases: self says `leaving`, and the seed loop is already cancelled.
  expect(selfStatus(node)).toBe('leaving');
  expect(internals(node.cluster).seedTimer?.isCancelled).toBe(true);
}

const awaitTerminated = (node: NodeHandle): Promise<void> => awaitCondition(
  () => node.system.isTerminated,
  { timeoutMs: 4_000, intervalMs: 5, label: 'the give-up pipeline to terminate the system' },
);

describe('a join with a deadline gives up once nothing can promote the node', () => {
  test("'immediate' with a dead seed: nothing before the deadline, then one warning, leave, one run", async () => {
    const node = await startNode('give-up-immediate', 9_801, { giveUpMs: DEADLINE_MS });

    node.scheduler.advance(DEADLINE_MS - 1);

    // Nine rounds in and six past the stall line, which has been said — and
    // is a line, not the trigger: nothing has been given up.
    expect(stallWarnings(node)).toHaveLength(1);
    expectStillJoining(node);

    node.scheduler.advance(1);

    expectGaveUp(node);
    const warning = giveUpWarnings(node)[0] ?? '';
    expect(warning).toContain('actor-ts.cluster.shutdown-after-unsuccessful-join');
    expect(warning).toContain(`${DEADLINE_MS} ms`);
    // The stall remedy, so the line is actionable on its own: nobody answered,
    // and here is who was asked.
    expect(warning).toContain('no seed has answered at all');
    expect(warning).toContain(node.seed.toString());

    await awaitTerminated(node);
    // Exactly one run, and the loop never dialled again.
    expect(node.reasons).toHaveLength(1);
    const roundsAtGiveUp = internals(node.cluster).seedRounds;
    node.scheduler.advance(RETRY_INTERVAL_MS * 10);
    expect(internals(node.cluster).seedRounds).toBe(roundsAtGiveUp);
  });

  test("'never' gives up too: it waits for a leader, and there is none", async () => {
    const node = await startNode('give-up-never', 9_802, { giveUpMs: DEADLINE_MS, selfElection: 'never' });

    node.scheduler.advance(DEADLINE_MS);

    expectGaveUp(node);
    await awaitTerminated(node);
  });

  test("a symmetric deadlock — a peer known, none up, 'immediate' — gives up", async () => {
    const node = await startNode('give-up-symmetric', 9_803, { giveUpMs: DEADLINE_MS });
    introducePeer(node, new NodeAddress('give-up-symmetric', SEED_HOST, 9_803), 'joining');

    node.scheduler.advance(DEADLINE_MS);

    expectGaveUp(node);
    // The remedy for this deadlock, not the one for silence.
    expect(giveUpWarnings(node)[0]).toContain("selfElection: 'immediate'");
    expect(giveUpWarnings(node)[0]).not.toContain('no seed has answered at all');
  });

  test('a node its own timer moved to weakly-up counts as not joined, and gives up', async () => {
    const node = await startNode('give-up-weakly-up', 9_804, {
      giveUpMs: DEADLINE_MS,
      weaklyUpAfterMs: RETRY_INTERVAL_MS,
    });

    node.scheduler.advance(DEADLINE_MS - 1);
    expectStillJoining(node, 'weakly-up');

    node.scheduler.advance(1);

    expectGaveUp(node);
    expect(giveUpWarnings(node)[0]).toContain('still "weakly-up"');
  });

  test('no seed answering gives up under a membership threshold too', async () => {
    // The same verdict the stall line states, so a threshold no longer turns a
    // node whose seeds are wrong into one that waits for members for good.
    const node = await startNode('give-up-threshold-dead', 9_805, {
      giveUpMs: DEADLINE_MS,
      minimumMembersBeforeUp: 3,
    });

    node.scheduler.advance(DEADLINE_MS);

    expectGaveUp(node);
    expect(giveUpWarnings(node)[0]).toContain('no seed has answered at all');
    expect(thresholdWarnings(node)).toEqual([]);
  });

  test('a deadline that finds the node promotable re-checks every round and gives up at the first that holds', async () => {
    const node = await startNode('give-up-recheck', 9_806, { giveUpMs: DEADLINE_MS });
    const leader = new NodeAddress('give-up-recheck', SEED_HOST, 9_806);
    introducePeer(node, leader, 'up');

    node.scheduler.advance(DEADLINE_MS);
    // A leader exists, so promotion is its job: nothing given up, one re-check armed.
    expectStillJoining(node);
    expect(internals(node.cluster).joinGiveUpTimer).not.toBeNull();

    peerLeaves(node, leader);
    node.scheduler.advance(RETRY_INTERVAL_MS - 1);
    // Not before the re-check: the leader going is not an event this listens to.
    expectStillJoining(node);

    node.scheduler.advance(1);

    expectGaveUp(node);
  });

  test('coordinated-shutdown.auto-register-tasks = off still stops the seed loop', async () => {
    // That pipeline has no cluster-leave task, so a give-up that only ran it
    // would terminate the system around a node still dialling its seeds.
    const node = await startNode('give-up-no-framework-tasks', 9_807, {
      giveUpMs: DEADLINE_MS,
      hocon: 'actor-ts.coordinated-shutdown.auto-register-tasks = off',
    });

    node.scheduler.advance(DEADLINE_MS);

    expectGaveUp(node);
    await awaitTerminated(node);
  });

  test('the deadline arrives from the key in configuration, not only from the builder', async () => {
    const node = await startNode('give-up-hocon', 9_808, {
      hocon: `actor-ts.cluster.shutdown-after-unsuccessful-join = ${DEADLINE_MS}ms`,
    });

    node.scheduler.advance(DEADLINE_MS - 1);
    expectStillJoining(node);

    node.scheduler.advance(1);

    expectGaveUp(node);
  });
});

describe('and does not give up while something can still promote the node', () => {
  test('unset, the join has no deadline at all: still dialling after forty rounds', async () => {
    // What every release before the key did, pinned: the shipped `0s` arms no
    // timer, and the loop just keeps going.
    const node = await startNode('give-up-unset', 9_811);

    node.scheduler.advance(RETRY_INTERVAL_MS * 40);

    expect(internals(node.cluster).seedRounds).toBe(40);
    expect(internals(node.cluster).joinGiveUpTimer).toBeNull();
    expectStillJoining(node);
  });

  test('a member that is up is a leader: promotion is its job, not a deadlock', async () => {
    const node = await startNode('give-up-leader-known', 9_812, { giveUpMs: DEADLINE_MS });
    introducePeer(node, new NodeAddress('give-up-leader-known', SEED_HOST, 9_812), 'up');

    node.scheduler.advance(PAST_THE_DEADLINE_MS);

    expectStillJoining(node);
  });

  test('a pending deferred self-election holds the verdict, and the node forms a cluster at its grace', async () => {
    const graceMs = DEADLINE_MS * 2;
    const node = await startNode('give-up-deferred', 9_813, { giveUpMs: DEADLINE_MS, selfElection: graceMs });

    node.scheduler.advance(PAST_THE_DEADLINE_MS);
    // Past the deadline, inside the grace: on a clock, not stuck.
    expectStillJoining(node);

    node.scheduler.advance(graceMs - PAST_THE_DEADLINE_MS);

    expect(selfStatus(node)).toBe('up');
    expect(node.cluster.selfElected).toBe(true);
    node.scheduler.advance(RETRY_INTERVAL_MS * 5);
    expect(giveUpWarnings(node)).toEqual([]);
    expect(node.reasons).toEqual([]);
    // The re-checks stopped with the node up: a disarmed timer, not a pending one.
    expect(internals(node.cluster).joinGiveUpTimer).toBeNull();
  });

  test('a membership threshold holding a peer that is present is a wait, not a give-up', async () => {
    const node = await startNode('give-up-threshold-wait', 9_814, {
      giveUpMs: DEADLINE_MS,
      minimumMembersBeforeUp: 3,
    });
    introducePeer(node, new NodeAddress('give-up-threshold-wait', SEED_HOST, 9_814), 'joining');

    node.scheduler.advance(PAST_THE_DEADLINE_MS);

    expectStillJoining(node);
    // And the line it does log says what the node is waiting for.
    expect(thresholdWarnings(node)).toHaveLength(1);
  });

  test('a deadline shorter than one seed round is refused at the join, from configuration too', async () => {
    let caught: unknown;
    try {
      await startNode('give-up-too-short', 9_815, {
        hocon: `actor-ts.cluster.shutdown-after-unsuccessful-join = ${RETRY_INTERVAL_MS - 1}ms`,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(OptionsError);
    expect((caught as OptionsError).field).toBe('shutdownAfterUnsuccessfulJoinMs');
    expect(nodes).toEqual([]);
  });
});
