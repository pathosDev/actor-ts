/**
 * #958 — the append of an event received from a peer is serialized, goes
 * through the journal breaker, and is retried rather than logged away.
 *
 * `_absorb` used to start the append and not wait for it.  The append reads
 * the head and then appends conditionally on it — two awaits, so the mailbox
 * moved on in between, and the next envelope read the *same* head.  One
 * append won; every other got a `JournalConcurrencyError`, which a
 * `.catch(log.warn)` swallowed.  The events were folded, so nothing looked
 * wrong until a restart replayed a journal that did not hold them.
 *
 * `InMemoryJournal` answers `highestSeq` in a microtask, which closes the
 * window by luck, so the burst here runs over a journal whose head probe
 * answers a moment later — the timing every real backend has.
 *
 * One node over `InMemoryTransport`; envelopes are delivered by hand as the
 * mediator would deliver them.  No port is bound.
 */
import { describe, expect, test } from 'bun:test';
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
import { assertCompletesWithin } from '../../../../util/AsyncAssertions.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';
import { AppendRejectsJournal, JournalUnavailableError } from '../../../../util/UnavailableJournal.js';

type AddCommand = { readonly kind: 'add'; readonly amount: number };
type Command = AddCommand;
type AddedEvent = { readonly kind: 'added'; readonly amount: number };
type Event = AddedEvent;
type State = { readonly value: number };

const WAIT = { timeoutMs: 3_000, intervalMs: 5 } as const;
const TEARDOWN_BUDGET_MS = 2_000;
const PEER = 'remote-append-peer@h:85299';

type Observations = {
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
    await this.persist({ kind: 'added', amount: command.amount });
  }
}

/**
 * `InMemoryJournal` with a head probe that takes its answer on entry and
 * returns it a few milliseconds later — the round trip a real store has, and
 * the window two overlapping appends race in.
 */
class SlowHeadJournal implements Journal {
  constructor(private readonly inner: Journal) {}

  async highestSeq(persistenceId: string): Promise<number> {
    const head = await this.inner.highestSeq(persistenceId);
    // The delay is the fixture: a head probe that answers a round trip later.
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    return head;
  }

  append<E = unknown>(
    persistenceId: string,
    entries: ReadonlyArray<JournalEntry<E>>,
    expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    return this.inner.append<E>(persistenceId, entries, expectedSeq);
  }

  read<E = unknown>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    return this.inner.read<E>(persistenceId, fromSeq, toSeq);
  }

  delete(persistenceId: string, toSeq: number): Promise<void> { return this.inner.delete(persistenceId, toSeq); }
  persistenceIds(): Promise<string[]> { return this.inner.persistenceIds(); }
}

/** Every append fails with a `JournalConcurrencyError` until `losses` have been spent. */
class LosesFirstAppendsJournal implements Journal {
  appendCalls = 0;

  constructor(private readonly inner: Journal, private losses: number) {}

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

type Replica = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly extension: PersistenceExtension;
  readonly ref: ActorRef<Command | ReplicatedEventEnvelope<Event>>;
  readonly observations: Observations;
  readonly persistenceId: string;
};

async function startReplica(
  name: string,
  port: number,
  journal: Journal,
  persistenceId: string,
  config?: ConfigObject,
): Promise<Replica> {
  let options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
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
  const observations: Observations = { recovered: [], current: null };
  const ref = system.spawn(() => new Counter(persistenceId, observations), 'counter');
  await awaitCondition(() => observations.recovered.length === 1, { ...WAIT, label: `${name}: the replica recovered` });
  return { system, cluster, extension, ref, observations, persistenceId };
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

describe('ReplicatedEventSourcedActor — a peer\'s event is appended in a serialized chain (#958)', () => {
  test('a burst of envelopes delivered back to back lands in the local journal, each exactly once', async () => {
    const journal = new SlowHeadJournal(new InMemoryJournal());
    const replica = await startReplica('remote-append-burst', 85_101, journal, 'ra-burst');
    try {
      const burst = Array.from({ length: 10 }, (_, i) => peerEnvelope(replica.persistenceId, i + 1, i + 1));
      for (const envelope of burst) deliver(replica, envelope);
      await awaitCondition(async () => (await journal.highestSeq(replica.persistenceId)) === burst.length, {
        ...WAIT, label: 'every envelope reached the local journal',
      });
      // Give a straggler the chance to land twice before counting.
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      expect(await storedEventIds(journal, replica.persistenceId)).toEqual(burst.map((e) => e.eventId));
      expect(replica.observations.current!.value).toBe(55);

      // The journal is the whole of what a restart rebuilds from.
      expect(await gracefulStop(replica.ref, TEARDOWN_BUDGET_MS)).toBe(true);
      const recoveriesBefore = replica.observations.recovered.length;
      replica.system.spawn(() => new Counter(replica.persistenceId, replica.observations), 'counter-restarted');
      await awaitCondition(() => replica.observations.recovered.length === recoveriesBefore + 1, {
        ...WAIT, label: 'the restarted replica recovered',
      });
      expect(replica.observations.recovered.at(-1)).toEqual({ value: 55 });
    } finally {
      await stopReplica(replica);
    }
  });

  test('a losing conditional append is retried against the refreshed head', async () => {
    const journal = new LosesFirstAppendsJournal(new InMemoryJournal(), 2);
    const replica = await startReplica('remote-append-retry', 85_102, journal, 'ra-retry');
    try {
      const envelope = peerEnvelope(replica.persistenceId, 1, 7);
      deliver(replica, envelope);
      await awaitCondition(async () => (await storedEventIds(journal, replica.persistenceId)).length === 1, {
        ...WAIT, label: 'the third attempt wrote the event',
      });
      expect(journal.appendCalls).toBe(3);
      expect(await storedEventIds(journal, replica.persistenceId)).toEqual([envelope.eventId]);
      expect(replica.extension.journalBreaker!.state).toBe('closed');
    } finally {
      await stopReplica(replica);
    }
  });

  test('an open breaker refuses the append; it is written once the breaker closes within the retry budget', async () => {
    const journal = new InMemoryJournal();
    const replica = await startReplica('remote-append-breaker', 85_103, journal, 'ra-breaker');
    try {
      replica.extension.journalBreaker!.setState('open');
      const envelope = peerEnvelope(replica.persistenceId, 1, 5);
      deliver(replica, envelope);
      await awaitCondition(() => replica.observations.current!.value === 5, { ...WAIT, label: 'the event was folded' });
      // Refused while open: the journal was not asked.
      expect(await journal.highestSeq(replica.persistenceId)).toBe(0);

      replica.extension.journalBreaker!.setState('closed');
      await awaitCondition(async () => (await journal.highestSeq(replica.persistenceId)) === 1, {
        ...WAIT, label: 'a retry wrote the event after the breaker closed',
      });
      expect(await storedEventIds(journal, replica.persistenceId)).toEqual([envelope.eventId]);
    } finally {
      await stopReplica(replica);
    }
  });

  test('a spent retry budget fails the actor, so its supervisor sees the incomplete journal', async () => {
    const journal = new AppendRejectsJournal(
      new InMemoryJournal(),
      () => new JournalUnavailableError('append'),
    );
    const replica = await startReplica('remote-append-exhausted', 85_104, journal, 'ra-exhausted', {
      'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'max-failures': 100 } } },
    });
    try {
      deliver(replica, peerEnvelope(replica.persistenceId, 1, 9));
      await awaitCondition(() => replica.observations.current!.value === 9, { ...WAIT, label: 'the event was folded' });
      // Default supervision restarts the actor; the new instance recovers from
      // a journal that does not hold the event.
      await awaitCondition(() => replica.observations.recovered.length === 2, {
        ...WAIT, label: 'the actor failed and was restarted',
      });
      expect(journal.appendCalls).toBe(3);
      expect(replica.observations.recovered[1]).toEqual({ value: 0 });
    } finally {
      await stopReplica(replica);
    }
  });
});
