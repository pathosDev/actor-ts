/**
 * A peer cannot suppress a replica's events, crash its actor, or grow its
 * history without limit (#706).
 *
 * `ReplicatedEventSourcedActor` took four security-relevant values straight
 * out of the broadcast payload and trusted all of them: the replica id and
 * `seqAtReplica` that together *were* the cluster-wide deduplication key, the
 * vector clock it merged into local state, and the timestamp it sorted on.
 * The deduplication key was the weapon — `${replica}#${seqAtReplica}` off a
 * plain counter, so a peer computed a victim's future keys by arithmetic and
 * pre-claimed them. A hit means *silently discard*, so the victim's genuine
 * events were then dropped by every peer, permanently: the forgery is
 * journaled and the key set is snapshotted, so a restart did not clear it.
 *
 * Three things are asserted here, and each is bound to a different half of the
 * fix:
 *
 *   1. **Pre-claiming buys nothing.** The key is now a per-event id minted
 *      from 96 bits of entropy at `persist` time — the `ORSet` remedy from
 *      #722, which is the precedent that transfers. Transport binding does
 *      not: `replicaId` is documented as legitimately *not* the sending
 *      node's address.
 *   2. **A malformed envelope is dropped, whole, before anything is
 *      mutated.** `_absorb` used to add the key, splice the event in and
 *      refold state, and only *then* die inside `VectorClock.fromData` — so
 *      one three-field message from any member both corrupted the history and
 *      failed the actor, repeatably.
 *   3. **The history is bounded, by refusal rather than eviction.** Evicting
 *      from the history would change the fold and evicting a key would reopen
 *      double-apply.
 *
 * The forged envelopes are delivered with a plain `ref.tell`, which is exactly
 * what the pub-sub mediator does to a subscriber (`tellSubscriber` →
 * `ref.tell(body)`) and also what `Cluster.dispatchEnvelope` does for any
 * resolvable path — the two reachable routes, without the cluster machinery in
 * the way.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { LogLevel, type Logger } from '../../../../../src/Logger.js';
import type { LogContextData } from '../../../../../src/LogContext.js';
import { ReplicatedEventSourcedActor } from '../../../../../src/persistence/ReplicatedEventSourcedActor.js';
import type { ReplicatedEventEnvelope } from '../../../../../src/persistence/ReplicatedEventSourcedActor.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { InMemorySnapshotStore } from '../../../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import { PersistenceExtensionId } from '../../../../../src/persistence/PersistenceExtension.js';
import {
  MAX_REPLICA_ID_LENGTH,
  MAX_REPLICATED_EVENT_ID_LENGTH,
  MAX_VECTOR_CLOCK_ENTRIES,
  REPLICATED_EVENT_ID_ENTROPY_CHARACTERS,
} from '../../../../../src/persistence/Constants.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

const PERSISTENCE_ID = 'trust-counter';

type AddCommand = { kind: 'add'; n: number };
type Command = AddCommand;
type AddedEvent = { kind: 'added'; n: number };
type Event = AddedEvent;
type State = { value: number };

/**
 * Every amount `onEvent` was called with, in order.
 *
 * The spy the assertions read, rather than `state.value`, for two reasons: a
 * sum cannot say *which* event landed, and a fold that ran and was then thrown
 * away by a restart is exactly what the pre-fix code did — a spy sees it, a
 * recovered state does not.
 */
let appliedAmounts: number[] = [];

/**
 * How often `preStart` completed. A restart re-runs it, so this is the "the
 * actor did not fail" assertion: the pre-fix code threw out of `onReceive`
 * into supervision on a malformed envelope.
 */
let preStartSuccesses = 0;

class TrustCounter extends ReplicatedEventSourcedActor<Command, Event, State> {
  readonly persistenceId = PERSISTENCE_ID;
  /** Per-test override of the history ceiling; 0 means "leave the default". */
  static observedEventsCeiling = 0;

  initialState(): State { return { value: 0 }; }

  onEvent(state: State, event: Event): State {
    appliedAmounts.push(event.n);
    return { value: state.value + event.n };
  }

  async onCommand(_state: State, command: Command): Promise<void> {
    if (command.kind === 'add') await this.persist({ kind: 'added', n: command.n });
  }

  override async preStart(): Promise<void> {
    await super.preStart();
    preStartSuccesses += 1;
  }

  protected override maxObservedEvents(): number {
    return TrustCounter.observedEventsCeiling > 0
      ? TrustCounter.observedEventsCeiling
      : super.maxObservedEvents();
  }

  /** Test hooks — the fields the fix touches are private, the snapshot is not. */
  publishSnapshot(): Promise<void> { return this.saveSnapshot(); }
  get replica(): string { return this.replicaId; }
}

type LogRecord = { readonly level: string; readonly message: string };

/**
 * Collects everything the system logger was told, including through the
 * `withSource` an actor's `this.log` goes via. A custom logger short-circuits
 * `ActorSystemOptions.withLogLevel`, so nothing upstream filters and the
 * assertions can match on message text.
 */
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

type Replica = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly ref: ActorRef<Command>;
  readonly instance: TrustCounter;
  readonly journal: InMemoryJournal;
  readonly snapshotStore: InMemorySnapshotStore;
  readonly logger: RecordingLogger;
};

const WAIT = { timeoutMs: 4_000, intervalMs: 5 } as const;

async function startReplica(name: string, port: number): Promise<Replica> {
  const logger = new RecordingLogger();
  const system = ActorSystem.create(name, ActorSystemOptions.create().withLogger(logger));
  const journal = new InMemoryJournal();
  const snapshotStore = new InMemorySnapshotStore();
  system.extension(PersistenceExtensionId).setJournal(journal);
  system.extension(PersistenceExtensionId).setSnapshotStore(snapshotStore);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  let instance!: TrustCounter;
  const ref = system.spawn(
    () => {
      const created = new TrustCounter();
      instance = created;
      return created as unknown as Actor<Command>;
    },
    'counter',
  );
  await awaitCondition(() => !!instance && preStartSuccesses > 0, {
    ...WAIT, label: `${name}: the replica finished preStart`,
  });
  return { system, cluster, ref, instance, journal, snapshotStore, logger };
}

async function stopReplica(replica: Replica): Promise<void> {
  await replica.cluster.leave();
  await replica.system.terminate();
}

function resetSpies(): void {
  appliedAmounts = [];
  preStartSuccesses = 0;
  TrustCounter.observedEventsCeiling = 0;
}

/**
 * One genuinely-minted envelope, harvested from a *different* node's journal.
 *
 * Hand-writing it would beg the question the first test asks — whether
 * `persist` mints an unguessable id at all — so the victim here is a real
 * replica on a real (in-memory) cluster of its own, with its own journal. Two
 * independent single-node clusters never gossip: `InMemoryTransport`'s registry
 * only connects addresses somebody sends to, and neither has the other as a
 * seed. So the only delivery into the receiver is the `tell` the test makes.
 */
async function harvestVictimEnvelope(
  port: number, amount: number,
): Promise<ReplicatedEventEnvelope<Event>> {
  const victim = await startReplica('trust-victim', port);
  try {
    victim.ref.tell({ kind: 'add', n: amount });
    await awaitCondition(() => appliedAmounts.includes(amount), {
      ...WAIT, label: "the victim's own event was folded",
    });
    const written = await victim.journal.read<ReplicatedEventEnvelope<Event>>(PERSISTENCE_ID, 1);
    const envelope = written.find((entry) => entry.event.event.n === amount)?.event;
    if (envelope === undefined) throw new Error('the victim did not journal its own event');
    return envelope;
  } finally {
    await stopReplica(victim);
  }
}

/**
 * Drive the receiver past the messages under test.
 *
 * The mailbox is FIFO and the actor handles one message at a time, so a local
 * `add` told *after* the forgeries is observable only once every forgery has
 * been handled. That makes every "nothing happened" assertion below a poll on
 * a state that must already be settled rather than a bet on a fixed delay, and
 * it doubles as proof the actor is still processing messages at all.
 */
async function drainWithSentinel(replica: Replica, marker: number): Promise<void> {
  replica.ref.tell({ kind: 'add', n: marker });
  await awaitCondition(() => appliedAmounts.includes(marker), {
    ...WAIT, label: `the sentinel add(${marker}) was folded, so every earlier message is handled`,
  });
}

const warningsMatching = (replica: Replica, needle: string): LogRecord[] =>
  replica.logger.records.filter((record) => record.level === 'warn' && record.message.includes(needle));

const EVENT_ID_SUFFIX = new RegExp(`^[0-9a-f]{${REPLICATED_EVENT_ID_ENTROPY_CHARACTERS}}$`);

describe('replicated envelope trust — event ids (#706)', () => {
  test('persist mints an event id that no peer can derive from the ones already issued', async () => {
    resetSpies();
    const replica = await startReplica('trust-mint', 70_501);
    try {
      const rounds = 50;
      for (let round = 1; round <= rounds; round++) replica.ref.tell({ kind: 'add', n: round });
      await awaitCondition(() => appliedAmounts.length === rounds, {
        ...WAIT, label: 'all fifty local events were folded',
      });

      const journalled = await replica.journal.read<ReplicatedEventEnvelope<Event>>(PERSISTENCE_ID, 1);
      const eventIds = journalled.map((entry) => entry.event.eventId);
      expect(eventIds).toHaveLength(rounds);
      expect(new Set(eventIds).size).toBe(rounds);

      const prefix = `${replica.instance.replica}#`;
      for (const eventId of eventIds) {
        expect(eventId.startsWith(prefix)).toBe(true);
        expect(eventId.slice(prefix.length)).toMatch(EVENT_ID_SUFFIX);
      }
      // The old shape, and the thing a peer enumerated: `seqAtReplica` is still
      // on the envelope and still a plain counter, so if it were the key again
      // every one of these would be present.
      for (let round = 1; round <= rounds; round++) {
        expect(eventIds).not.toContain(`${prefix}${round}`);
      }
    } finally {
      await stopReplica(replica);
    }
  }, 15_000);

  test('an id pre-claimed in the old shape does not suppress the genuine event', async () => {
    resetSpies();
    const victimEnvelope = await harvestVictimEnvelope(70_502, 4_242);
    resetSpies();
    const replica = await startReplica('trust-preclaim', 70_503);
    try {
      // The whole attack, in the two shapes a peer can send it. Both claim the
      // victim's replica id and its `seqAtReplica`, which is all the pre-fix
      // deduplication key was made of.
      const preClaimedWithLegacyKeyAsId: ReplicatedEventEnvelope<Event> = {
        ...victimEnvelope,
        eventId: `${victimEnvelope.replica}#${victimEnvelope.seqAtReplica}`,
        event: { kind: 'added', n: 1 },
      };
      const preClaimedWithNoId = {
        persistenceId: victimEnvelope.persistenceId,
        replica: victimEnvelope.replica,
        seqAtReplica: victimEnvelope.seqAtReplica,
        vc: victimEnvelope.vc,
        timestamp: victimEnvelope.timestamp,
        event: { kind: 'added', n: 2 },
      } as unknown as ReplicatedEventEnvelope<Event>;

      replica.ref.tell(preClaimedWithLegacyKeyAsId as unknown as Command);
      replica.ref.tell(preClaimedWithNoId as unknown as Command);
      // The victim's real event, byte-for-byte as its own journal holds it.
      replica.ref.tell(victimEnvelope as unknown as Command);
      await drainWithSentinel(replica, 9);

      expect(
        appliedAmounts,
        "the victim's genuine event was suppressed by a pre-claimed deduplication key",
      ).toContain(4_242);
      // Guessing the old key still lands an event of the attacker's own — that
      // is impersonation, which needs authorship binding and is not this fix.
      expect(appliedAmounts).toContain(1);
      // The `eventId`-less shape is refused outright rather than absorbed.
      expect(appliedAmounts).not.toContain(2);
      expect(warningsMatching(replica, 'a peer older than #706 does not send one')).not.toEqual([]);

      // And it stays suppressed-proof across the snapshot round trip that used
      // to make the suppression permanent.
      await replica.instance.publishSnapshot();
      const stored = await replica.snapshotStore.loadLatest<{ seenIds: readonly string[] }>(PERSISTENCE_ID);
      expect(stored.isSome()).toBe(true);
      expect(stored.toNullable()!.state.seenIds).toContain(victimEnvelope.eventId);
    } finally {
      await stopReplica(replica);
    }
  }, 20_000);
});

describe('replicated envelope trust — shape validation (#706)', () => {
  test('a malformed remote envelope is dropped whole, and the actor survives it', async () => {
    resetSpies();
    const victimEnvelope = await harvestVictimEnvelope(70_504, 4_242);
    resetSpies();
    const replica = await startReplica('trust-shape', 70_505);
    try {
      const peerReplica = victimEnvelope.replica;
      const wellFormed = {
        persistenceId: PERSISTENCE_ID,
        replica: peerReplica,
        seqAtReplica: 1,
        eventId: `${peerReplica}#deadbeefdeadbeefdeadbeef`,
        vc: { [peerReplica]: 1 },
        timestamp: Date.now(),
      };
      /**
       * One case per field the pre-fix code read without checking, plus the
       * two that were the reported crash and the reported growth vector.
       *
       * Each carries a distinct `seqAtReplica`, applied below, and that is not
       * cosmetic: the pre-fix deduplication key was `${replica}#${seqAtReplica}`,
       * so a shared sequence number would have collapsed twenty-odd cases into
       * one key and let the old code drop all but the first *as a duplicate*.
       * Every case then reads as "handled correctly" against the very code it
       * is supposed to indict. Distinct sequence numbers make each case fail
       * on its own when the fix is reverted.
       */
      const hostile: ReadonlyArray<{ what: string; envelope: unknown }> = [
        { what: 'no vc at all — the reported one-message actor crash', envelope: { ...wellFormed, vc: undefined } },
        { what: 'vc is null', envelope: { ...wellFormed, vc: null } },
        { what: 'vc is an array', envelope: { ...wellFormed, vc: [1, 2, 3] } },
        { what: 'vc is a string', envelope: { ...wellFormed, vc: 'not-a-clock' } },
        { what: 'a vc component is not a number', envelope: { ...wellFormed, vc: { [peerReplica]: 'nine' } } },
        { what: 'a vc component is not finite', envelope: { ...wellFormed, vc: { [peerReplica]: Number.POSITIVE_INFINITY } } },
        { what: 'a vc component is negative', envelope: { ...wellFormed, vc: { [peerReplica]: -1 } } },
        {
          what: 'the vc carries more entries than are accepted',
          envelope: {
            ...wellFormed,
            vc: Object.fromEntries(
              Array.from({ length: MAX_VECTOR_CLOCK_ENTRIES + 1 }, (_, index) => [`invented-${index}`, 1]),
            ),
          },
        },
        { what: 'a vc key is over-long', envelope: { ...wellFormed, vc: { ['x'.repeat(MAX_REPLICA_ID_LENGTH + 1)]: 1 } } },
        { what: 'seqAtReplica is zero', envelope: { ...wellFormed, seqAtReplica: 0 } },
        { what: 'seqAtReplica is negative', envelope: { ...wellFormed, seqAtReplica: -5 } },
        { what: 'seqAtReplica is fractional', envelope: { ...wellFormed, seqAtReplica: 1.5 } },
        { what: 'seqAtReplica is NaN', envelope: { ...wellFormed, seqAtReplica: Number.NaN } },
        { what: 'seqAtReplica is past the safe-integer range', envelope: { ...wellFormed, seqAtReplica: 2 ** 60 } },
        { what: 'timestamp is not finite', envelope: { ...wellFormed, timestamp: Number.POSITIVE_INFINITY } },
        { what: 'timestamp is NaN', envelope: { ...wellFormed, timestamp: Number.NaN } },
        { what: 'timestamp is not a number', envelope: { ...wellFormed, timestamp: '1716297600000' } },
        { what: 'replica is empty', envelope: { ...wellFormed, replica: '' } },
        { what: 'replica is not a string', envelope: { ...wellFormed, replica: 42 } },
        { what: 'replica is over-long', envelope: { ...wellFormed, replica: 'r'.repeat(MAX_REPLICA_ID_LENGTH + 1) } },
        { what: 'eventId is missing', envelope: { ...wellFormed, eventId: undefined } },
        { what: 'eventId is empty', envelope: { ...wellFormed, eventId: '' } },
        { what: 'eventId is not a string', envelope: { ...wellFormed, eventId: 7 } },
        { what: 'eventId is over-long', envelope: { ...wellFormed, eventId: 'e'.repeat(MAX_REPLICATED_EVENT_ID_LENGTH + 1) } },
      ];
      /** The case's fingerprint: `appliedAmounts` holds it iff it was absorbed. */
      const amountFor = (index: number): number => 101 + index;

      hostile.forEach((testCase, index) => {
        const base = testCase.envelope as Record<string, unknown>;
        replica.ref.tell({
          ...base,
          // Both identity fields are made unique per case *after* the spread,
          // and only where the case did not deliberately replace the shared
          // value — spreading `base` last would silently restore
          // `wellFormed`'s and put the collision back.
          seqAtReplica: base.seqAtReplica === wellFormed.seqAtReplica ? 100 + index : base.seqAtReplica,
          eventId: base.eventId === wellFormed.eventId
            ? `${peerReplica}#${index.toString(16).padStart(REPLICATED_EVENT_ID_ENTROPY_CHARACTERS, '0')}`
            : base.eventId,
          event: { kind: 'added', n: amountFor(index) },
        } as unknown as Command);
      });
      await drainWithSentinel(replica, 9);

      const absorbed = hostile
        .filter((_testCase, index) => appliedAmounts.includes(amountFor(index)))
        .map((testCase) => testCase.what);
      expect(
        absorbed,
        'these malformed envelopes reached onEvent — state was mutated before the shape was checked',
      ).toEqual([]);
      expect(
        preStartSuccesses,
        'the actor restarted, so a malformed envelope escaped into supervision instead of being dropped',
      ).toBe(1);
      // Every drop is diagnosable, the way the cluster's own frame validation
      // promises: one WARN per envelope naming the offending field.
      expect(warningsMatching(replica, 'dropped a remote envelope').length).toBe(hostile.length);

      // The validator has to discriminate, not just refuse. Without this every
      // assertion above would also pass a fix that dropped everything.
      replica.ref.tell({ ...wellFormed, event: { kind: 'added', n: 777 } } as unknown as Command);
      await drainWithSentinel(replica, 8);
      expect(appliedAmounts, 'a well-formed peer envelope was refused too').toContain(777);
    } finally {
      await stopReplica(replica);
    }
  }, 20_000);
});

describe('replicated envelope trust — history ceiling (#706)', () => {
  test('remote events are refused once at the ceiling, loudly, and local persists are not', async () => {
    resetSpies();
    TrustCounter.observedEventsCeiling = 3;
    const replica = await startReplica('trust-ceiling', 70_506);
    try {
      const peerReplica = 'peer-far-away';
      const peerEnvelope = (index: number): unknown => ({
        persistenceId: PERSISTENCE_ID,
        replica: peerReplica,
        seqAtReplica: index,
        eventId: `${peerReplica}#${'0'.repeat(23)}${index}`,
        vc: { [peerReplica]: index },
        // Ascending so each lands on the append-only path — a refold would
        // change nothing here, but the ceiling is about how many are kept.
        timestamp: 1_000 + index,
        event: { kind: 'added', n: 200 + index },
      });

      for (let index = 1; index <= 3; index++) replica.ref.tell(peerEnvelope(index) as Command);
      await drainWithSentinel(replica, 9);
      expect(appliedAmounts).toContain(201);
      expect(appliedAmounts).toContain(202);
      expect(appliedAmounts).toContain(203);
      expect(warningsMatching(replica, 'maxObservedEvents()')).toEqual([]);

      // The sentinel above is itself a local persist, so the history is at 4
      // already — past a ceiling of 3, which is the point: local writes are
      // never refused.
      replica.ref.tell(peerEnvelope(4) as Command);
      replica.ref.tell(peerEnvelope(5) as Command);
      await drainWithSentinel(replica, 7);

      expect(appliedAmounts, 'a remote event was absorbed past the ceiling').not.toContain(204);
      expect(appliedAmounts).not.toContain(205);
      expect(appliedAmounts, 'a local persist was refused by the remote-path ceiling').toContain(7);
      const refusals = warningsMatching(replica, 'maxObservedEvents()');
      expect(refusals.length, 'the refusal was silent, or logged once per envelope').toBe(1);
      expect(refusals[0]!.message).toContain('refused');

      // Refusal, not eviction: the three that were accepted are still in the
      // history and still deduplicated, so a re-delivery is a no-op.
      await replica.instance.publishSnapshot();
      const stored = await replica.snapshotStore.loadLatest<{
        seenIds: readonly string[];
        events: ReadonlyArray<ReplicatedEventEnvelope<Event>>;
      }>(PERSISTENCE_ID);
      const snapshot = stored.toNullable()!.state;
      expect(snapshot.events.filter((entry) => entry.replica === peerReplica)).toHaveLength(3);
      expect(snapshot.seenIds.length).toBe(snapshot.events.length);
    } finally {
      TrustCounter.observedEventsCeiling = 0;
      await stopReplica(replica);
    }
  }, 20_000);
});

describe('replicated envelope trust — replica id bound (#706)', () => {
  test('a replicaId longer than peers accept fails on the node that chose it', async () => {
    resetSpies();
    let failure: unknown = null;
    class OverLongReplica extends TrustCounter {
      override get replicaId(): string { return 'r'.repeat(MAX_REPLICA_ID_LENGTH + 1); }
      override async preStart(): Promise<void> {
        try { await super.preStart(); } catch (error) { failure = error; throw error; }
      }
    }
    const system = ActorSystem.create('trust-longid', ActorSystemOptions.create().withLogger(new RecordingLogger()));
    system.extension(PersistenceExtensionId).setJournal(new InMemoryJournal());
    system.extension(PersistenceExtensionId).setSnapshotStore(new InMemorySnapshotStore());
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(70_507)
      .withTransport(new InMemoryTransport(new NodeAddress('trust-longid', 'h', 70_507)))
      .withGossipIntervalMs(30);
    const cluster = await Cluster.join(system, clusterOptions);
    try {
      system.spawn(() => new OverLongReplica() as unknown as Actor<Command>, 'counter');
      await awaitCondition(() => failure !== null, {
        ...WAIT, label: 'the over-long replicaId was refused at preStart',
      });
      expect(String(failure)).toContain('replicaId must be a non-empty string');
      expect(preStartSuccesses).toBe(0);
    } finally {
      await cluster.leave();
      await system.terminate();
    }
  }, 15_000);
});
