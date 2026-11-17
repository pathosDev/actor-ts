/**
 * #1732 — what a replicated actor's background journal work owes after the
 * actor stops, and the retry schedule that work runs on.
 *
 * A peer's event is folded before it is written (#958), and a local append a
 * breaker gave up on is settled in the background, so both outlive the
 * mailbox turn that started them.  `postStop` hands them to a successor on the
 * node, which waits for them before its recovery reads; a stopped instance
 * keeps writing but no longer sleeps between attempts, and tells its dead self
 * nothing.  The retry schedule itself — `REPLICATED_JOURNAL_RETRY_ATTEMPTS`
 * attempts, `REPLICATED_JOURNAL_RETRY_BACKOFF_MS × attempt` apart, no pause
 * after the last — is pinned here too, for the remote append and for the
 * read that settles an append of unknown outcome.
 *
 * **The backoff runs on a manual clock.**  The actor waits with a module-level
 * `sleep` over `setTimeout`.  The suite replaces `setTimeout` for its duration
 * and routes exactly the calls made from that `sleep` — recognised by the
 * frame `sleep` in `ReplicatedEventSourcedActor.ts` on the stack — to
 * {@link BackoffClock}, which records the requested delay and either fires at
 * once or holds the timer until the test releases it.  Every other timer (the
 * breaker's `call-timeout`, gossip, the test's own waits) runs for real.  So
 * the schedule is read off as a list of requested delays rather than measured,
 * and "the replica stops while a retry is in its backoff" is a state the test
 * holds rather than a race it wins.
 *
 * One node over `InMemoryTransport`, like the sibling replicated suites; no
 * port is bound.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { PubSubEnvelope } from '../../../../../src/cluster/pubsub/Messages.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import type { ConfigObject } from '../../../../../src/index.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { gracefulStop } from '../../../../../src/pattern/GracefulStop.js';
import { REPLICATED_JOURNAL_RETRY_ATTEMPTS, REPLICATED_JOURNAL_RETRY_BACKOFF_MS } from '../../../../../src/persistence/Constants.js';
import type { Journal } from '../../../../../src/persistence/Journal.js';
import {
  JournalConcurrencyError,
  type JournalEntry,
  type PersistentEvent,
} from '../../../../../src/persistence/JournalTypes.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { PersistenceExtensionId, type PersistenceExtension } from '../../../../../src/persistence/PersistenceExtension.js';
import {
  ReplicatedEventSourcedActor,
  type ReplicatedEventEnvelope,
} from '../../../../../src/persistence/ReplicatedEventSourcedActor.js';
import { InMemorySnapshotStore } from '../../../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import { DeadLetter } from '../../../../../src/SystemMessages.js';
import { assertCompletesWithin } from '../../../../util/AsyncAssertions.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';
import { HeldAppendJournal, JournalUnavailableError } from '../../../../util/UnavailableJournal.js';

type AddCommand = { readonly kind: 'add'; readonly amount: number };
type Command = AddCommand;
type AddedEvent = { readonly kind: 'added'; readonly amount: number };
type Event = AddedEvent;
type State = { readonly value: number };

const WAIT = { timeoutMs: 3_000, intervalMs: 5 } as const;
const TEARDOWN_BUDGET_MS = 2_000;
const PEER = 'journal-work-peer@h:87399';

/** The backoff each retry asks for, in order: 100 ms, then 200 ms. */
const FULL_SCHEDULE = Array.from(
  { length: REPLICATED_JOURNAL_RETRY_ATTEMPTS - 1 },
  (_, index) => REPLICATED_JOURNAL_RETRY_BACKOFF_MS * (index + 1),
);

/** Neither breaker trips on the handful of failures a test scripts. */
const TOLERANT_BREAKER: ConfigObject = {
  'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'max-failures': 100 } } },
};

/** A journal call-timeout short enough to cut a held append inside one test. */
const CALL_TIMEOUT: ConfigObject = {
  'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'call-timeout': '50ms' } } },
};

/* ------------------------------ the manual clock ------------------------------ */

const BACKOFF_FRAME = /at sleep \([^)]*ReplicatedEventSourcedActor\.ts:/;

/** The actor's retry backoff timers, and only those. */
class BackoffClock {
  /** Every delay a backoff asked for, in order — held or not. */
  readonly requested: number[] = [];
  private readonly held: Array<() => void> = [];
  private holding = false;

  /** Hold every backoff from now on until {@link release}. */
  hold(): void { this.holding = true; }

  /** Fire the held backoffs, and fire every later one at once. */
  release(): void {
    this.holding = false;
    for (const fire of this.held.splice(0, this.held.length)) fire();
  }

  get heldCount(): number { return this.held.length; }

  request(delayMs: number, fire: () => void): void {
    this.requested.push(delayMs);
    if (this.holding) this.held.push(fire);
    else queueMicrotask(fire);
  }
}

let clock = new BackoffClock();
const realSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  clock = new BackoffClock();
  globalThis.setTimeout = ((handler: unknown, delayMs?: number, ...rest: unknown[]) => {
    if (typeof handler === 'function' && BACKOFF_FRAME.test(new Error().stack ?? '')) {
      clock.request(delayMs ?? 0, () => (handler as (...a: unknown[]) => void)(...rest));
      // `sleep` never clears its timer, so nothing reads the handle.
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return (realSetTimeout as (...a: unknown[]) => ReturnType<typeof setTimeout>)(handler, delayMs, ...rest);
  }) as typeof setTimeout;
});

afterEach(() => {
  clock.release();
  globalThis.setTimeout = realSetTimeout;
});

/* ------------------------------ fixtures ------------------------------ */

type Observations = {
  readonly persisted: number[];
  readonly persistFailures: Error[];
  readonly recovered: State[];
  current: Counter | null;
};

class Counter extends ReplicatedEventSourcedActor<Command, Event, State> {
  readonly persistenceId: string;

  constructor(persistenceId: string, private readonly observations: Observations) {
    super();
    this.persistenceId = persistenceId;
    observations.current = this;
  }

  get value(): number { return this.state.value; }

  initialState(): State { return { value: 0 }; }

  onEvent(state: State, event: Event): State { return { value: state.value + event.amount }; }

  override onRecoveryComplete(state: State): void { this.observations.recovered.push(state); }

  async onCommand(_state: State, command: Command): Promise<void> {
    try {
      await this.persist({ kind: 'added', amount: command.amount });
      this.observations.persisted.push(command.amount);
    } catch (e) {
      this.observations.persistFailures.push(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

/** Records every dead letter the system publishes. */
class DeadLetterProbe extends Actor<DeadLetter> {
  constructor(private readonly received: DeadLetter[]) { super(); }

  override onReceive(message: DeadLetter): void { this.received.push(message); }
}

/** The first `losses` appends are refused as lost conditional appends — nothing written, so each is retried. */
class LosesFirstAppendsJournal implements Journal {
  appendCalls = 0;

  constructor(private readonly inner: Journal, private losses: number) {}

  /** Lose the next `losses` appends as well. */
  lose(losses: number): void { this.losses += losses; }

  async append<E = unknown>(
    persistenceId: string,
    entries: ReadonlyArray<JournalEntry<E>>,
    expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    this.appendCalls += 1;
    if (this.losses > 0) {
      this.losses -= 1;
      throw new JournalConcurrencyError(persistenceId, expectedSeq, expectedSeq + 1);
    }
    return this.inner.append<E>(persistenceId, entries, expectedSeq);
  }

  read<E = unknown>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    return this.inner.read<E>(persistenceId, fromSeq, toSeq);
  }

  highestSeq(persistenceId: string): Promise<number> { return this.inner.highestSeq(persistenceId); }
  delete(persistenceId: string, toSeq: number): Promise<void> { return this.inner.delete(persistenceId, toSeq); }
  persistenceIds(): Promise<string[]> { return this.inner.persistenceIds(); }
}

/**
 * Once {@link arm}ed: the next append commits and then fails, as a dropped
 * connection does, and the next `readFailures` reads fail — so whether the
 * append landed is settled only by a read that gets an answer.
 */
class LostAnswerJournal implements Journal {
  appendCalls = 0;
  /** Reads since {@link arm}, failed or not. */
  readsSinceArmed = 0;
  private armed = false;
  private answerToLose = false;
  private readFailures = 0;

  constructor(private readonly inner: Journal) {}

  arm(readFailures: number): void {
    this.armed = true;
    this.answerToLose = true;
    this.readFailures = readFailures;
  }

  async append<E = unknown>(
    persistenceId: string,
    entries: ReadonlyArray<JournalEntry<E>>,
    expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    this.appendCalls += 1;
    const written = await this.inner.append<E>(persistenceId, entries, expectedSeq);
    if (this.answerToLose) {
      this.answerToLose = false;
      throw new JournalUnavailableError('append');
    }
    return written;
  }

  async read<E = unknown>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    if (this.armed) this.readsSinceArmed += 1;
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new JournalUnavailableError('read');
    }
    return this.inner.read<E>(persistenceId, fromSeq, toSeq);
  }

  highestSeq(persistenceId: string): Promise<number> { return this.inner.highestSeq(persistenceId); }
  delete(persistenceId: string, toSeq: number): Promise<void> { return this.inner.delete(persistenceId, toSeq); }
  persistenceIds(): Promise<string[]> { return this.inner.persistenceIds(); }
}

type Replica = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly extension: PersistenceExtension;
  readonly ref: ActorRef<Command | ReplicatedEventEnvelope<Event>>;
  readonly observations: Observations;
  readonly persistenceId: string;
  readonly deadLetters: DeadLetter[];
};

async function startReplica(
  name: string,
  port: number,
  journal: Journal,
  persistenceId: string,
  config?: ConfigObject,
): Promise<Replica> {
  let options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  if (config) options = options.withConfig(config);
  const system = ActorSystem.create(name, options);
  const extension = system.extension(PersistenceExtensionId);
  extension.configure({ journal, snapshotStore: new InMemorySnapshotStore() });
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  const deadLetters: DeadLetter[] = [];
  const probe = system.spawn(() => new DeadLetterProbe(deadLetters), 'dead-letter-probe');
  system.eventStream.subscribe(probe, DeadLetter);
  const observations: Observations = { persisted: [], persistFailures: [], recovered: [], current: null };
  const ref = system.spawn(() => new Counter(persistenceId, observations), 'counter');
  await awaitCondition(() => observations.recovered.length === 1, { ...WAIT, label: `${name}: the replica recovered` });
  return { system, cluster, extension, ref, observations, persistenceId, deadLetters };
}

async function stopReplica(replica: Replica): Promise<void> {
  await assertCompletesWithin(replica.cluster.leave(), TEARDOWN_BUDGET_MS, `${replica.system.name}: cluster.leave() settled`);
  await assertCompletesWithin(replica.system.terminate(), TEARDOWN_BUDGET_MS, `${replica.system.name}: system.terminate() settled`);
}

function peerEnvelope(persistenceId: string, seqAtReplica: number, amount: number): ReplicatedEventEnvelope<Event> {
  return {
    persistenceId,
    replica: PEER,
    seqAtReplica,
    eventId: `${PEER}#${String(seqAtReplica).padStart(24, '0')}`,
    vc: { [PEER]: seqAtReplica },
    timestamp: 1_700_000_000_000 + seqAtReplica,
    event: { kind: 'added', amount },
  };
}

function deliver(replica: Replica, envelope: ReplicatedEventEnvelope<Event>): void {
  const delivery = new PubSubEnvelope(`replicated-es:${replica.persistenceId}`, envelope, NodeAddress.parse(PEER));
  replica.ref.tell(delivery as unknown as Command);
}

async function storedEventIds(journal: Journal, persistenceId: string): Promise<string[]> {
  const events = await journal.read<ReplicatedEventEnvelope<Event>>(persistenceId, 1);
  return events.map((persisted) => persisted.event.eventId);
}

/** Spawn a successor over the same stores; answers its ref. */
function spawnSuccessor(replica: Replica, name: string): ActorRef<Command | ReplicatedEventEnvelope<Event>> {
  return replica.system.spawn(() => new Counter(replica.persistenceId, replica.observations), name);
}

async function awaitRecoveries(replica: Replica, count: number, label: string): Promise<void> {
  await awaitCondition(() => replica.observations.recovered.length === count, { ...WAIT, label });
}

/**
 * The names of the actor's own message classes that reached dead letters,
 * read once a marker sent after them has arrived — dead letters reach the
 * probe in publication order, so everything published before it is in.
 */
async function ownMessagesInDeadLetters(replica: Replica, stopped: ActorRef<unknown>): Promise<string[]> {
  const marker = { kind: 'dead-letter-marker' } as const;
  stopped.tell(marker as unknown as never);
  await awaitCondition(() => replica.deadLetters.some((letter) => letter.message === marker), {
    ...WAIT, label: 'the marker reached the dead-letter probe',
  });
  return replica.deadLetters
    .map((letter) => (letter.message as { constructor?: { name?: string } } | null)?.constructor?.name ?? '')
    .filter((name) => name === 'RemoteAppendExhausted' || name === 'LandedLate');
}

/* ------------------------------ C1: the drain on stop ------------------------------ */

describe('ReplicatedEventSourcedActor — journal work still running when the actor stops (#1732)', () => {
  test('a peer event in its retry backoff at stop is written before the successor reads, and the successor holds it', async () => {
    const journal = new LosesFirstAppendsJournal(new InMemoryJournal(), 1);
    const replica = await startReplica('journal-work-backoff', 87_301, journal, 'jw-backoff');
    try {
      clock.hold();
      const envelope = peerEnvelope(replica.persistenceId, 1, 5);
      deliver(replica, envelope);
      await awaitCondition(() => clock.heldCount === 1, { ...WAIT, label: 'the first append lost and its retry is backing off' });
      expect(journal.appendCalls).toBe(1);

      expect(await gracefulStop(replica.ref, TEARDOWN_BUDGET_MS)).toBe(true);
      spawnSuccessor(replica, 'counter-2');
      // An absence: the successor must NOT recover while the append it would miss is still backing off.
      await sleep(100);
      expect(replica.observations.recovered.length).toBe(1);
      expect(await storedEventIds(journal, replica.persistenceId)).toEqual([]);

      clock.release();
      await awaitRecoveries(replica, 2, 'the successor recovered once the retry had written the event');
      expect(replica.observations.recovered[1]).toEqual({ value: 5 });
      expect(journal.appendCalls).toBe(2);
      expect(await storedEventIds(journal, replica.persistenceId)).toEqual([envelope.eventId]);
    } finally {
      await stopReplica(replica);
    }
  });

  test('terminate() settles while a retry is still held in its backoff', async () => {
    const journal = new LosesFirstAppendsJournal(new InMemoryJournal(), 1);
    const replica = await startReplica('journal-work-terminate', 87_302, journal, 'jw-terminate');
    clock.hold();
    deliver(replica, peerEnvelope(replica.persistenceId, 1, 5));
    await awaitCondition(() => clock.heldCount === 1, { ...WAIT, label: 'the retry is backing off' });
    // Nothing releases the clock until the teardown below has settled.
    await stopReplica(replica);
  });

  test('stop, respawn, stop, respawn: each successor waits for the work of the instance before it', async () => {
    const journal = new LosesFirstAppendsJournal(new InMemoryJournal(), 1);
    const replica = await startReplica('journal-work-chain', 87_303, journal, 'jw-chain');
    try {
      clock.hold();
      const first = peerEnvelope(replica.persistenceId, 1, 5);
      deliver(replica, first);
      await awaitCondition(() => clock.heldCount === 1, { ...WAIT, label: 'the first event is backing off' });
      expect(await gracefulStop(replica.ref, TEARDOWN_BUDGET_MS)).toBe(true);

      const second = spawnSuccessor(replica, 'counter-2');
      clock.release();
      await awaitRecoveries(replica, 2, 'the second instance recovered');
      expect(replica.observations.recovered[1]).toEqual({ value: 5 });

      // The second instance's own peer event is backing off when it stops.
      clock.hold();
      journal.lose(1);
      const next = peerEnvelope(replica.persistenceId, 2, 7);
      deliver({ ...replica, ref: second }, next);
      await awaitCondition(() => clock.heldCount === 1, { ...WAIT, label: 'the second event is backing off' });
      expect(await gracefulStop(second, TEARDOWN_BUDGET_MS)).toBe(true);

      spawnSuccessor(replica, 'counter-3');
      // An absence: the third instance must NOT recover while the second one's append is backing off.
      await sleep(100);
      expect(replica.observations.recovered.length).toBe(2);

      clock.release();
      await awaitRecoveries(replica, 3, 'the third instance recovered');
      expect(replica.observations.recovered[2]).toEqual({ value: 12 });
      expect(await storedEventIds(journal, replica.persistenceId)).toEqual([first.eventId, next.eventId]);
    } finally {
      await stopReplica(replica);
    }
  });

  test('a successor whose recovery deadline expires while it waits still leaves the wait to the next one', async () => {
    // The successor of an instance with an append still in flight waits for it
    // under `recovery-timeout`, and fails its start when that runs out.  Its
    // own `postStop` then hands over its work — none — and that must not
    // replace what the instance before it still owes.
    const config: ConfigObject = {
      'actor-ts': {
        'circuit-breaker': { 'persistence-journal': { 'call-timeout': '50ms' } },
        persistence: { 'recovery-timeout': '100ms' },
      },
    };
    const journal = new HeldAppendJournal(new InMemoryJournal());
    const replica = await startReplica('journal-work-deadline', 87_306, journal, 'jw-deadline', config);
    try {
      replica.ref.tell({ kind: 'add', amount: 1 });
      await awaitCondition(() => replica.observations.persistFailures.length === 1, {
        ...WAIT, label: 'the held append was cut at the call-timeout',
      });
      expect(await gracefulStop(replica.ref, TEARDOWN_BUDGET_MS)).toBe(true);

      spawnSuccessor(replica, 'counter-2');
      // An absence: across several recovery deadlines — the successor's and
      // whatever supervision makes of its failed start — no instance may
      // recover while the first one's append is still held.
      await sleep(500);
      expect(replica.observations.recovered.length).toBe(1);

      journal.landAll();
      await awaitRecoveries(replica, 2, 'an instance recovered once the held append landed');
      expect(replica.observations.recovered[1]).toEqual({ value: 1 });
    } finally {
      journal.landAll();
      await stopReplica(replica);
    }
  });

  test('a stopped instance stops backing off, and does not tell its dead self that the retries ran out', async () => {
    const journal = new LosesFirstAppendsJournal(new InMemoryJournal(), REPLICATED_JOURNAL_RETRY_ATTEMPTS);
    const replica = await startReplica('journal-work-exhausted', 87_304, journal, 'jw-exhausted');
    try {
      clock.hold();
      deliver(replica, peerEnvelope(replica.persistenceId, 1, 5));
      await awaitCondition(() => clock.heldCount === 1, { ...WAIT, label: 'the first retry is backing off' });
      expect(await gracefulStop(replica.ref, TEARDOWN_BUDGET_MS)).toBe(true);

      spawnSuccessor(replica, 'counter-2');
      clock.release();
      await awaitRecoveries(replica, 2, 'the successor recovered once the stopped instance gave up');
      // Every attempt ran, without a pause once the actor had stopped.
      expect(journal.appendCalls).toBe(REPLICATED_JOURNAL_RETRY_ATTEMPTS);
      expect(clock.requested).toEqual([REPLICATED_JOURNAL_RETRY_BACKOFF_MS]);
      expect(replica.observations.recovered[1]).toEqual({ value: 0 });
      expect(await ownMessagesInDeadLetters(replica, replica.ref)).toEqual([]);
    } finally {
      await stopReplica(replica);
    }
  });

  test('a local append that lands after the actor stopped is not told to the dead actor', async () => {
    const journal = new HeldAppendJournal(new InMemoryJournal());
    const replica = await startReplica('journal-work-landed-late', 87_305, journal, 'jw-landed-late', CALL_TIMEOUT);
    try {
      replica.ref.tell({ kind: 'add', amount: 1 });
      await awaitCondition(() => replica.observations.persistFailures.length === 1, {
        ...WAIT, label: 'the held append was cut at the call-timeout',
      });
      expect(await gracefulStop(replica.ref, TEARDOWN_BUDGET_MS)).toBe(true);

      spawnSuccessor(replica, 'counter-2');
      journal.landAll();
      await awaitRecoveries(replica, 2, 'the successor recovered once the append landed');
      expect(replica.observations.recovered[1]).toEqual({ value: 1 });
      expect(await ownMessagesInDeadLetters(replica, replica.ref)).toEqual([]);
    } finally {
      journal.landAll();
      await stopReplica(replica);
    }
  });
});

/* ------------------------------ C4: the retry schedule ------------------------------ */

describe('ReplicatedEventSourcedActor — the journal retry schedule', () => {
  test('a peer event whose append loses all but the last attempt is written, after a backoff of BACKOFF × attempt', async () => {
    const journal = new LosesFirstAppendsJournal(new InMemoryJournal(), REPLICATED_JOURNAL_RETRY_ATTEMPTS - 1);
    const replica = await startReplica('retry-remote-written', 87_311, journal, 'rt-remote-written');
    try {
      const envelope = peerEnvelope(replica.persistenceId, 1, 3);
      deliver(replica, envelope);
      await awaitCondition(async () => (await storedEventIds(journal, replica.persistenceId)).length === 1, {
        ...WAIT, label: 'the last attempt wrote the event',
      });
      expect(journal.appendCalls).toBe(REPLICATED_JOURNAL_RETRY_ATTEMPTS);
      expect(clock.requested).toEqual(FULL_SCHEDULE);
      expect(replica.observations.recovered.length).toBe(1);
    } finally {
      await stopReplica(replica);
    }
  });

  test('a peer event whose every append loses escalates with no pause after the last attempt', async () => {
    const journal = new LosesFirstAppendsJournal(new InMemoryJournal(), REPLICATED_JOURNAL_RETRY_ATTEMPTS);
    const replica = await startReplica('retry-remote-exhausted', 87_312, journal, 'rt-remote-exhausted', TOLERANT_BREAKER);
    try {
      deliver(replica, peerEnvelope(replica.persistenceId, 1, 3));
      await awaitRecoveries(replica, 2, 'the spent budget failed the actor and it was restarted');
      expect(journal.appendCalls).toBe(REPLICATED_JOURNAL_RETRY_ATTEMPTS);
      expect(clock.requested).toEqual(FULL_SCHEDULE);
    } finally {
      await stopReplica(replica);
    }
  });

  test('an append of unknown outcome is settled by a read that answers on the last attempt', async () => {
    const store = new InMemoryJournal();
    const journal = new LostAnswerJournal(store);
    const replica = await startReplica('retry-read-written', 87_313, journal, 'rt-read-written', TOLERANT_BREAKER);
    try {
      journal.arm(REPLICATED_JOURNAL_RETRY_ATTEMPTS - 1);
      const envelope = peerEnvelope(replica.persistenceId, 1, 3);
      deliver(replica, envelope);
      await awaitCondition(() => journal.readsSinceArmed === REPLICATED_JOURNAL_RETRY_ATTEMPTS, {
        ...WAIT, label: 'the last settling read got an answer',
      });
      // A presence to wait on: a second peer event queues behind the settling.
      const next = peerEnvelope(replica.persistenceId, 2, 4);
      deliver(replica, next);
      await awaitCondition(async () => (await storedEventIds(store, replica.persistenceId)).length === 2, {
        ...WAIT, label: 'the next event was written behind the settled one',
      });
      // Settled as written: neither re-appended nor escalated.
      expect(journal.appendCalls).toBe(2);
      expect(await storedEventIds(store, replica.persistenceId)).toEqual([envelope.eventId, next.eventId]);
      expect(journal.readsSinceArmed).toBe(REPLICATED_JOURNAL_RETRY_ATTEMPTS);
      expect(clock.requested).toEqual(FULL_SCHEDULE);
      expect(replica.observations.recovered.length).toBe(1);
    } finally {
      await stopReplica(replica);
    }
  });

  test('a settling read that never answers is tried every attempt, with no pause after the last', async () => {
    const journal = new LostAnswerJournal(new InMemoryJournal());
    const replica = await startReplica('retry-read-unknown', 87_314, journal, 'rt-read-unknown', TOLERANT_BREAKER);
    try {
      journal.arm(REPLICATED_JOURNAL_RETRY_ATTEMPTS);
      deliver(replica, peerEnvelope(replica.persistenceId, 1, 3));
      // Unknown is not retried; it escalates, and the restarted instance recovers.
      await awaitRecoveries(replica, 2, 'the unsettled append escalated and the actor was restarted');
      expect(journal.appendCalls).toBe(1);
      // The restarted instance's recovery read is the one after the three failures.
      expect(journal.readsSinceArmed).toBe(REPLICATED_JOURNAL_RETRY_ATTEMPTS + 1);
      expect(clock.requested).toEqual(FULL_SCHEDULE);
    } finally {
      await stopReplica(replica);
    }
  });
});
