import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  InMemoryJournal,
  InMemorySnapshotStore,
  JournalIntegrityError,
  PersistenceExtensionId,
  PersistentActor,
  everyNEvents,
  type SnapshotPolicy,
} from '../../../../src/persistence/index.js';
import { ActorLifecycleEvent, ActorRestarted, ActorStopped } from '../../../../src/SystemMessages.js';
import {
  FaultInjectingJournal,
  FaultInjectingJournalOptions,
  FaultInjectingSnapshotStore,
  FaultInjectingSnapshotStoreOptions,
  InjectedFaultError,
} from '../../../../src/testkit/index.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/**
 * What `PersistentActor` does when a store call fails (#1024).
 *
 * Every other persistence suite runs against a store that works, so none of
 * these paths had been observed.  Each case scripts one failure through the
 * testkit's fault-injecting decorators, layered over the in-memory stores, so
 * the failure arrives at the `Journal` / `SnapshotStore` seam the actor
 * really calls.
 */

/* ------------------------------ the actor -------------------------------- */

type DepositCommand = { kind: 'deposit'; amounts: ReadonlyArray<number> };
type Command = DepositCommand;

type DepositedEvent = { kind: 'deposited'; amount: number };
type Event = DepositedEvent;

type State = { balance: number };

/**
 * Everything the actor did, recorded outside it — an instance is gone after a
 * restart, so the assertions read from this bag instead.
 */
type Observations = {
  incarnations: number;
  recovered: State[];
  /** Amounts each command asked to deposit, in the order handled. */
  handled: Array<ReadonlyArray<number>>;
  /** The state each `persistAll` callback saw. */
  callbacks: State[];
  recoveryFailures: Error[];
};

const newObservations = (): Observations =>
  ({ incarnations: 0, recovered: [], handled: [], callbacks: [], recoveryFailures: [] });

class Account extends PersistentActor<Command, Event, State> {
  constructor(
    readonly persistenceId: string,
    protected readonly observations: Observations,
    private readonly policy: SnapshotPolicy<State, Event> = () => false,
  ) {
    super();
  }
  initialState(): State { return { balance: 0 }; }
  onEvent(state: State, event: Event): State { return { balance: state.balance + event.amount }; }
  override snapshotPolicy(): SnapshotPolicy<State, Event> { return this.policy; }
  override onRecoveryComplete(state: State): void { this.observations.recovered.push(state); }
  /** Records the reason and rethrows, so supervision still decides. */
  override onRecoveryFailure(reason: Error): void {
    this.observations.recoveryFailures.push(reason);
    throw reason;
  }
  async onCommand(_state: State, command: Command): Promise<void> {
    await match(command)
      .with({ kind: 'deposit' }, (c) => this.onDeposit(c))
      .exhaustive();
  }

  private async onDeposit(command: DepositCommand): Promise<void> {
    this.observations.handled.push(command.amounts);
    const events = command.amounts.map((amount): Event => ({ kind: 'deposited', amount }));
    await this.persistAll(events, (state) => { this.observations.callbacks.push(state); });
  }
}

/** Records the recovery failure and returns — the actor then stops instead of restarting. */
class SwallowingAccount extends Account {
  override onRecoveryFailure(reason: Error): void {
    this.observations.recoveryFailures.push(reason);
  }
}

/* ------------------------------- harness --------------------------------- */

type ListenerReady = { value: boolean };

class LifecycleListener extends Actor<ActorLifecycleEvent> {
  constructor(private readonly seen: ActorLifecycleEvent[], private readonly ready: ListenerReady) { super(); }
  override preStart(): void {
    this.system.eventStream.subscribe(this.self, ActorLifecycleEvent);
    this.ready.value = true;
  }
  override onReceive(event: ActorLifecycleEvent): void { this.seen.push(event); }
}

type Harness = {
  readonly system: ActorSystem;
  readonly journal: InMemoryJournal;
  readonly snapshots: InMemorySnapshotStore;
  readonly lifecycle: ActorLifecycleEvent[];
};

/**
 * A quiet system whose stores are the given decorators over the returned
 * in-memory stores — seed and inspect through the inner ones, so the script
 * counts only the calls the actor makes.
 */
async function makeHarness(
  name: string,
  wrap: {
    readonly journal?: (inner: InMemoryJournal) => FaultInjectingJournal;
    readonly snapshots?: (inner: InMemorySnapshotStore) => FaultInjectingSnapshotStore;
  },
): Promise<Harness> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  const journal = new InMemoryJournal();
  const snapshots = new InMemorySnapshotStore();
  const extension = system.extension(PersistenceExtensionId);
  extension.setJournal(wrap.journal?.(journal) ?? journal);
  extension.setSnapshotStore(wrap.snapshots?.(snapshots) ?? snapshots);
  const lifecycle: ActorLifecycleEvent[] = [];
  const ready: ListenerReady = { value: false };
  system.spawn(() => new LifecycleListener(lifecycle, ready), 'lifecycle');
  await awaitCondition(() => ready.value, { label: 'the lifecycle listener subscribed' });
  return { system, journal, snapshots, lifecycle };
}

async function amountsIn(journal: InMemoryJournal, persistenceId: string): Promise<number[]> {
  const events = await journal.read<Event>(persistenceId, 1);
  return events.map((e) => e.event.amount);
}

/* -------------------------------- tests ---------------------------------- */

describe('PersistentActor — an append that throws inside persistAll', () => {
  test('restarts the actor from the journal, skips the callback, and keeps the next command', async () => {
    let faulty: FaultInjectingJournal | undefined;
    const journalFaults = FaultInjectingJournalOptions.create()
      .withFailOn('append')
      .withFailOnce();
    const { system, journal, lifecycle } = await makeHarness('append-fails', {
      journal: (inner) => (faulty = new FaultInjectingJournal(inner, journalFaults)),
    });
    const observations = newObservations();
    const ref = system.spawn(() => {
      observations.incarnations++;
      return new Account('acct-append', observations);
    }, 'account');
    await awaitCondition(() => observations.recovered.length === 1, { label: 'the first incarnation recovered' });

    ref.tell({ kind: 'deposit', amounts: [5, 6] });
    ref.tell({ kind: 'deposit', amounts: [7] });

    await awaitCondition(() => observations.callbacks.length === 1, {
      label: 'the command behind the failed one was persisted by the next incarnation',
    });
    // Supervision's default answer to the failure is a restart, and the
    // restarted instance recovers what the journal holds — nothing, since the
    // refused append never reached it.
    expect(lifecycle.some((e) => e instanceof ActorRestarted && e.actor.equals(ref))).toBe(true);
    expect(observations.incarnations).toBe(2);
    expect(observations.recovered).toEqual([{ balance: 0 }, { balance: 0 }]);
    // The failing command is not redelivered; the one queued behind it is.
    expect(observations.handled).toEqual([[5, 6], [7]]);
    expect(observations.callbacks).toEqual([{ balance: 7 }]);
    expect(await amountsIn(journal, 'acct-append')).toEqual([7]);
    expect(faulty!.failuresInjected).toBe(1);
    expect(faulty!.callsTo('append')).toBe(2);
    await system.terminate();
  });

  test('recovers the events of an append whose acknowledgement was lost', async () => {
    const journalFaults = FaultInjectingJournalOptions.create()
      .withFailOn('append')
      .withFailOnce()
      .withFailurePoint('after-operation');
    const { system, journal } = await makeHarness('append-ack-lost', {
      journal: (inner) => new FaultInjectingJournal(inner, journalFaults),
    });
    const observations = newObservations();
    const ref = system.spawn(() => {
      observations.incarnations++;
      return new Account('acct-ack-lost', observations);
    }, 'account');
    await awaitCondition(() => observations.recovered.length === 1, { label: 'the first incarnation recovered' });

    ref.tell({ kind: 'deposit', amounts: [5, 6] });
    await awaitCondition(() => observations.recovered.length === 2, { label: 'the restarted incarnation recovered' });

    // The write landed, so the restart reads it back: the state the actor
    // resumes from is the journal's, not the one the failed call implied.
    expect(observations.recovered[1]).toEqual({ balance: 11 });
    expect(observations.callbacks).toEqual([]);
    expect(await amountsIn(journal, 'acct-ack-lost')).toEqual([5, 6]);

    // And the restarted instance writes after the head it recovered.
    ref.tell({ kind: 'deposit', amounts: [1] });
    await awaitCondition(() => observations.callbacks.length === 1, { label: 'the next deposit was persisted' });
    expect(observations.callbacks).toEqual([{ balance: 12 }]);
    expect(await amountsIn(journal, 'acct-ack-lost')).toEqual([5, 6, 1]);
    await system.terminate();
  });
});

describe('PersistentActor — a snapshot save that fails after the append succeeded', () => {
  test('leaves the event durable and recovers it after the restart', async () => {
    let faulty: FaultInjectingSnapshotStore | undefined;
    const snapshotFaults = FaultInjectingSnapshotStoreOptions.create()
      .withFailOn('save')
      .withFailOnce();
    const { system, journal, snapshots } = await makeHarness('snapshot-save-fails', {
      snapshots: (inner) => (faulty = new FaultInjectingSnapshotStore(inner, snapshotFaults)),
    });
    const observations = newObservations();
    const ref = system.spawn(() => {
      observations.incarnations++;
      return new Account('acct-snapshot', observations, everyNEvents<State, Event>(1));
    }, 'account');
    await awaitCondition(() => observations.recovered.length === 1, { label: 'the first incarnation recovered' });

    ref.tell({ kind: 'deposit', amounts: [5] });
    await awaitCondition(() => observations.recovered.length === 2, {
      label: 'the failed snapshot save restarted the actor',
    });

    // The append committed before the save was attempted, so the event is in
    // the journal and the restart folds it in — nothing is lost or doubled.
    expect(await amountsIn(journal, 'acct-snapshot')).toEqual([5]);
    expect(observations.recovered).toEqual([{ balance: 0 }, { balance: 5 }]);
    expect(faulty!.callsTo('save')).toBe(1);
    expect((await snapshots.loadLatest('acct-snapshot')).isSome()).toBe(false);

    // The next write snapshots normally, at the head the restart recovered.
    ref.tell({ kind: 'deposit', amounts: [2] });
    await awaitCondition(() => observations.callbacks.length > 0 && faulty!.callsTo('save') === 2, {
      label: 'the next deposit was persisted and snapshotted',
    });
    expect(observations.callbacks.at(-1)).toEqual({ balance: 7 });
    const latest = await snapshots.loadLatest<State>('acct-snapshot');
    expect(latest.isSome() && latest.value.sequenceNr).toBe(2);
    expect(latest.isSome() && latest.value.state).toEqual({ balance: 7 });
    await system.terminate();
  });
});

describe('PersistentActor — recovery over a stream with a sequence gap', () => {
  test('refuses to recover from events 1, 2, 4 and names the missing number', async () => {
    const journalFaults = FaultInjectingJournalOptions.create().withGapAfterSeq(2);
    const { system, journal, lifecycle } = await makeHarness('gapped-stream', {
      journal: (inner) => new FaultInjectingJournal(inner, journalFaults),
    });
    await journal.append<Event>('acct-gap', [1, 2, 3, 4].map((amount) => ({ event: { kind: 'deposited', amount } })), 0);
    const observations = newObservations();
    const ref = system.spawn(() => {
      observations.incarnations++;
      return new SwallowingAccount('acct-gap', observations);
    }, 'account');

    await awaitCondition(() => lifecycle.some((e) => e instanceof ActorStopped && e.actor.equals(ref)), {
      label: 'the actor whose history has a hole stopped',
    });
    // Folding 1, 2, 4 would hand onCommand a balance of 7 that no sequence of
    // commands ever produced — recovery refuses instead.
    expect(observations.recovered).toEqual([]);
    expect(observations.recoveryFailures).toHaveLength(1);
    const failure = observations.recoveryFailures[0]!;
    expect(failure).toBeInstanceOf(JournalIntegrityError);
    expect((failure as JournalIntegrityError).sequenceNr).toBe(4);
    expect(failure.message).toContain('expected sequenceNr=3');
    await system.terminate();
  });
});

describe('PersistentActor — a journal read that fails part-way through recovery', () => {
  test('fails the recovery after the snapshot loaded, and the restart recovers in full', async () => {
    let faulty: FaultInjectingJournal | undefined;
    const journalFaults = FaultInjectingJournalOptions.create()
      .withFailOn('read')
      .withFailOnce();
    const { system, journal, snapshots } = await makeHarness('read-fails', {
      journal: (inner) => (faulty = new FaultInjectingJournal(inner, journalFaults)),
    });
    await journal.append<Event>('acct-read', [10, 20, 30].map((amount) => ({ event: { kind: 'deposited', amount } })), 0);
    await snapshots.save<State>('acct-read', 2, { balance: 30 });
    const observations = newObservations();
    system.spawn(() => {
      observations.incarnations++;
      return new Account('acct-read', observations);
    }, 'account');

    await awaitCondition(() => observations.recovered.length === 1, {
      label: 'the restarted incarnation recovered',
    });
    // The snapshot and the head check succeeded; the read of the events after
    // the snapshot did not, so the first recovery failed with that error and
    // assigned no state.  The restart re-ran the whole recovery.
    expect(observations.incarnations).toBe(2);
    expect(observations.recoveryFailures).toHaveLength(1);
    expect(observations.recoveryFailures[0]).toBeInstanceOf(InjectedFaultError);
    expect((observations.recoveryFailures[0] as InjectedFaultError).operation).toBe('read');
    expect(observations.recovered).toEqual([{ balance: 60 }]);
    expect(faulty!.callsTo('read')).toBe(2);
    await system.terminate();
  });
});
