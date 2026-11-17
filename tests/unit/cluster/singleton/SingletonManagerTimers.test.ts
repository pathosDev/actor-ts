/**
 * The singleton manager's lease and timer paths that only a scripted lease and
 * a captured timer reach (Pv triage, #1842 G1 and G10).
 *
 * - **A rejected acquire.**  `ClusterSingletonLease.test.ts` contends with an
 *   `InMemoryLease`, which answers `false` and never throws, so an `acquire()`
 *   that rejects — a backend that cannot be reached — was never handed to the
 *   manager.  It must leave the manager holding nothing and spawning nothing,
 *   and retry after `acquire-retry-interval`.
 * - **A restart that finds the lease gone** re-enters the acquire path at once
 *   rather than waiting out the acquire retry.
 * - **The host-disagreement hold** dead-letters what it held at
 *   {@link SINGLETON_HOST_DISAGREEMENT_HOLD_MS}.
 * - **Retained hand-over state** expires after
 *   {@link SINGLETON_HAND_OVER_STATE_RETENTION_MS}: a peer that asks later
 *   starts cold.
 *
 * A real single-node cluster.  Another node is staged into its member view —
 * written in, with nothing running behind it, the way `StagedMember` does it —
 * when a case needs this node not to be the host; its host name sorts first,
 * so it wins the election.  Each timer is captured at its delay, so the case
 * fires it at the moment it means instead of sleeping through it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { MemberUp } from '../../../../src/cluster/ClusterEvents.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import {
  SINGLETON_HAND_OVER_STATE_RETENTION_MS,
  SINGLETON_HOST_DISAGREEMENT_HOLD_MS,
  SINGLETON_RESTART_BACKOFF_MS,
} from '../../../../src/cluster/Constants.js';
import { Member } from '../../../../src/cluster/Member.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { StartSingletonOptions, type WarmHandOverActor } from '../../../../src/cluster/singleton/index.js';
import {
  AuthenticatedSingletonMessage,
  type SingletonHandOverAcknowledgment,
  type SingletonHandOverRequest,
} from '../../../../src/cluster/singleton/SingletonProtocol.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { SystemGroups, singletonManagerName, systemActorPath } from '../../../../src/internal/SystemPaths.js';
import { NoopLogger } from '../../../../src/Logger.js';
import { DeadLetter } from '../../../../src/SystemMessages.js';
import { CapturingScheduler } from '../../../util/CapturingScheduler.js';
import { ScriptedLease } from '../../../util/ScriptedLease.js';
import { stageMember } from '../../../util/StagedMember.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const TYPE_NAME = 'counter';

/** A delay nothing else in the system uses, so only the manager's acquire retry is captured. */
const ACQUIRE_RETRY_INTERVAL_MS = 6_681;

/** What the singleton instances did, across every case. */
const events: string[] = [];

/** A counter that offers its count to a successor — so a hand-over carries state. */
class Counter extends Actor<string> implements WarmHandOverActor {
  private count = 0;

  override preStart(): void { events.push('started'); }

  override onReceive(message: string): void {
    if (message === 'increment') { this.count++; events.push(`count:${this.count}`); return; }
    if (message === 'die') { this.context.stopSelf(); return; }
    events.push(`got:${message}`);
  }

  serializeForHandOver(): Uint8Array { return new TextEncoder().encode(String(this.count)); }

  restoreFromHandOver(state: Uint8Array): void { this.count = Number(new TextDecoder().decode(state)); }
}

/** Every dead letter's message, in order. */
const deadLetters: unknown[] = [];

class DeadLetterWatcher extends Actor<DeadLetter> {
  override preStart(): void { this.system.eventStream.subscribe(this.self, DeadLetter); }

  override onReceive(letter: DeadLetter): void { this.onDeadLetter(letter); }

  private onDeadLetter(letter: DeadLetter): void { deadLetters.push(letter.message); }
}

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly scheduler: CapturingScheduler;
  readonly manager: () => ActorRef<unknown>;
  /** Every singleton frame this node sent another, by peer. */
  readonly sent: Array<{ readonly peer: NodeAddress; readonly body: unknown }>;
  /** Stage a node that sorts before this one — the elected host from here on — and tell the managers. */
  readonly stageElectedPeer: () => NodeAddress;
};

let running: Harness | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* best-effort */ });
    await running.system.terminate().catch(() => { /* best-effort */ });
    running = null;
  }
  events.length = 0;
  deadLetters.length = 0;
});

async function startNode(systemName: string, port: number, captured: readonly number[]): Promise<Harness> {
  const scheduler = new CapturingScheduler();
  for (const delayMs of captured) scheduler.capture(delayMs);
  const system = ActorSystem.create(
    systemName,
    ActorSystemOptions.create().withLogger(new NoopLogger()).withScheduler(scheduler),
  );
  system.spawn(DeadLetterWatcher, 'dead-letter-watcher');
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    // A staged peer never answers a heartbeat; it must stay `up` for the case.
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 600_000, downAfterMs: 1_200_000 })
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  await awaitCondition(() => cluster.isLeader(), { timeoutMs: 4_000, label: 'the single node leads' });

  const sent: Array<{ readonly peer: NodeAddress; readonly body: unknown }> = [];
  const sendEnvelope = cluster._sendEnvelope.bind(cluster);
  cluster._sendEnvelope = (peer, envelope) => {
    sent.push({ peer, body: (envelope as { body?: unknown }).body });
    return sendEnvelope(peer, envelope);
  };

  const managerPath = systemActorPath(systemName, SystemGroups.clusterSingleton, singletonManagerName(TYPE_NAME));
  const segments = managerPath.replace(/^actor-ts:\/\/[^/]+\//, '').split('/').filter((s) => s.length > 0);
  const harness: Harness = {
    system,
    cluster,
    scheduler,
    manager: () => {
      const resolved = system._resolvePath(segments);
      if (resolved.isNone()) throw new Error(`no singleton manager at ${managerPath}`);
      return resolved.value as ActorRef<unknown>;
    },
    sent,
    stageElectedPeer: () => {
      const peer = stageMember(cluster, new NodeAddress(systemName, 'a-elected', port));
      cluster._publishClusterEvent(new MemberUp(new Member(peer, 'up', 1)));
      return peer;
    },
  };
  running = harness;
  return harness;
}

describe('the singleton manager\'s lease cycle (#1842 G1)', () => {
  test('an acquire that rejects spawns nothing, and the retry after the interval hosts', async () => {
    const harness = await startNode('1842-singleton-rejects', 44_740, [ACQUIRE_RETRY_INTERVAL_MS]);
    const lease = new ScriptedLease();
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName(TYPE_NAME)
      .withActor(Counter)
      .withLease(lease)
      .withAcquireRetryIntervalMs(ACQUIRE_RETRY_INTERVAL_MS);
    harness.cluster.singleton.start(singletonOptions);
    await awaitCondition(() => lease.pendingAcquires === 1, { timeoutMs: 4_000, label: 'the host asked for the lease' });

    lease.fail();
    await awaitCondition(() => harness.scheduler.capturedAt(ACQUIRE_RETRY_INTERVAL_MS) === 1, {
      timeoutMs: 4_000,
      label: 'the rejected acquire armed the retry',
    });
    // No instance on a lease nobody holds, and no second attempt before the interval.
    expect(events).toEqual([]);
    expect(lease.checkAlive()).toBe(false);
    expect(lease.acquireCalls).toBe(1);

    harness.scheduler.fire(ACQUIRE_RETRY_INTERVAL_MS);
    await awaitCondition(() => lease.pendingAcquires === 1, { timeoutMs: 4_000, label: 'the retry asked again' });
    expect(lease.acquireCalls).toBe(2);
    expect(events).toEqual([]);

    lease.grant();
    await awaitCondition(() => events.includes('started'), {
      timeoutMs: 4_000,
      label: 'the singleton started once the lease was held',
    });
  }, 20_000);
});

describe('the singleton manager\'s timers (#1842 G10)', () => {
  test('a restart that finds the lease gone re-acquires it at once, and respawns once it is held', async () => {
    const harness = await startNode('1842-singleton-restart', 44_742, [
      ACQUIRE_RETRY_INTERVAL_MS,
      SINGLETON_RESTART_BACKOFF_MS,
    ]);
    const lease = new ScriptedLease();
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName(TYPE_NAME)
      .withActor(Counter)
      .withLease(lease)
      .withAcquireRetryIntervalMs(ACQUIRE_RETRY_INTERVAL_MS);
    const singleton = harness.cluster.singleton.start(singletonOptions);
    await awaitCondition(() => lease.pendingAcquires === 1, { timeoutMs: 4_000, label: 'the host asked for the lease' });
    lease.grant();
    await awaitCondition(() => events.includes('started'), { timeoutMs: 4_000, label: 'the singleton started' });

    // The instance dies on its own: the manager arms the restart backoff.
    const restartsBefore = harness.scheduler.capturedAt(SINGLETON_RESTART_BACKOFF_MS);
    singleton.tell('die');
    await awaitCondition(() => harness.scheduler.capturedAt(SINGLETON_RESTART_BACKOFF_MS) === restartsBefore + 1, {
      timeoutMs: 4_000,
      label: 'the unexpected death armed the restart',
    });
    // Inside the backoff the lease goes, and the re-acquire it triggers fails,
    // so the lease is not held and only the acquire retry would bring it back.
    lease.lose();
    await awaitCondition(() => lease.pendingAcquires === 1, { timeoutMs: 4_000, label: 'the lost lease was re-asked' });
    lease.deny();
    await awaitCondition(() => harness.scheduler.capturedAt(ACQUIRE_RETRY_INTERVAL_MS) === 1, {
      timeoutMs: 4_000,
      label: 'the denied acquire armed the retry',
    });
    expect(lease.acquireCalls).toBe(2);

    // The restart fires first, with no membership event in between: it must
    // not spawn without the lease, and must not leave it to the retry either.
    harness.scheduler.fire(SINGLETON_RESTART_BACKOFF_MS);
    await awaitCondition(() => lease.pendingAcquires === 1, {
      timeoutMs: 4_000,
      label: 'the restart went back to the acquire path',
    });
    expect(lease.acquireCalls).toBe(3);
    expect(events.filter((event) => event === 'started')).toHaveLength(1);

    lease.grant();
    await awaitCondition(() => events.filter((event) => event === 'started').length === 2, {
      timeoutMs: 4_000,
      label: 'the singleton was respawned once the lease was held again',
    });
  }, 20_000);

  test('a message held while hosting is undecided goes to dead letters at the hold\'s deadline', async () => {
    const harness = await startNode('1842-singleton-hold', 44_744, [SINGLETON_HOST_DISAGREEMENT_HOLD_MS]);
    // Another node is the host in this node's view, so this manager runs nothing.
    harness.stageElectedPeer();
    harness.cluster.singleton.start(StartSingletonOptions.create<string>().withTypeName(TYPE_NAME).withActor(Counter));
    await awaitCondition(() => {
      try { harness.manager(); return true; } catch { return false; }
    }, { timeoutMs: 4_000, label: 'the manager started' });

    // A proxy elsewhere routed here: that peer says this node hosts.
    harness.manager().tell({ kind: 'singleton-deliver', body: 'held-1' });
    await awaitCondition(() => harness.scheduler.capturedAt(SINGLETON_HOST_DISAGREEMENT_HOLD_MS) === 1, {
      timeoutMs: 4_000,
      label: 'the message was held and the hold armed',
    });
    expect(deadLetters).not.toContain('held-1');

    harness.scheduler.fire(SINGLETON_HOST_DISAGREEMENT_HOLD_MS);
    await awaitCondition(() => deadLetters.includes('held-1'), {
      timeoutMs: 4_000,
      label: 'the held message went to dead letters at the deadline',
    });
    expect(events).toEqual([]);
  }, 20_000);

  test('retained hand-over state expires: a successor that asks after the window starts cold', async () => {
    const harness = await startNode('1842-singleton-retention', 44_746, [SINGLETON_HAND_OVER_STATE_RETENTION_MS]);
    const singleton = harness.cluster.singleton.start(
      StartSingletonOptions.create<string>().withTypeName(TYPE_NAME).withActor(Counter),
    );
    await awaitCondition(() => events.includes('started'), { timeoutMs: 4_000, label: 'the singleton started' });
    singleton.tell('increment');
    await awaitCondition(() => events.includes('count:1'), { timeoutMs: 4_000, label: 'the count moved' });

    // The election moves before the successor asks: this node stands down on
    // its own and keeps the snapshot for whoever asks next.
    const successor = harness.stageElectedPeer();
    await awaitCondition(() => harness.scheduler.capturedAt(SINGLETON_HAND_OVER_STATE_RETENTION_MS) === 1, {
      timeoutMs: 4_000,
      label: 'the stand-down retained the snapshot',
    });

    harness.scheduler.fire(SINGLETON_HAND_OVER_STATE_RETENTION_MS);
    const request: SingletonHandOverRequest = { kind: 'singleton.HandOverRequest', typeName: TYPE_NAME };
    harness.manager().tell(new AuthenticatedSingletonMessage(successor, request));
    await awaitCondition(() => acknowledgmentsTo(harness, successor).length === 1, {
      timeoutMs: 4_000,
      label: 'the late request was answered',
    });
    expect(acknowledgmentsTo(harness, successor)[0]!.state).toBeUndefined();
  }, 20_000);

  test('within the window the same request carries the snapshot', async () => {
    // The control for the case above: what the expiry takes away is there
    // until it fires.
    const harness = await startNode('1842-singleton-retained', 44_748, [SINGLETON_HAND_OVER_STATE_RETENTION_MS]);
    const singleton = harness.cluster.singleton.start(
      StartSingletonOptions.create<string>().withTypeName(TYPE_NAME).withActor(Counter),
    );
    await awaitCondition(() => events.includes('started'), { timeoutMs: 4_000, label: 'the singleton started' });
    singleton.tell('increment');
    await awaitCondition(() => events.includes('count:1'), { timeoutMs: 4_000, label: 'the count moved' });

    const successor = harness.stageElectedPeer();
    await awaitCondition(() => harness.scheduler.capturedAt(SINGLETON_HAND_OVER_STATE_RETENTION_MS) === 1, {
      timeoutMs: 4_000,
      label: 'the stand-down retained the snapshot',
    });

    const request: SingletonHandOverRequest = { kind: 'singleton.HandOverRequest', typeName: TYPE_NAME };
    harness.manager().tell(new AuthenticatedSingletonMessage(successor, request));
    await awaitCondition(() => acknowledgmentsTo(harness, successor).length === 1, {
      timeoutMs: 4_000,
      label: 'the request was answered',
    });
    const state = acknowledgmentsTo(harness, successor)[0]!.state;
    expect(state === undefined ? undefined : new TextDecoder().decode(state)).toBe('1');
  }, 20_000);
});

function acknowledgmentsTo(harness: Harness, peer: NodeAddress): SingletonHandOverAcknowledgment[] {
  return harness.sent
    .filter((frame) => frame.peer.equals(peer))
    .map((frame) => frame.body as { kind?: unknown })
    .filter((body): body is SingletonHandOverAcknowledgment => body?.kind === 'singleton.HandOverAcknowledgment');
}
