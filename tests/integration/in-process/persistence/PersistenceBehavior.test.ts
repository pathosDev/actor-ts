import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { CircuitBreakerOpenError, CircuitBreakerTimeoutError } from '../../../../src/pattern/CircuitBreaker.js';
import type { Journal } from '../../../../src/persistence/Journal.js';
import type { JournalEntry, PersistentEvent, Snapshot } from '../../../../src/persistence/JournalTypes.js';
import type { SnapshotStore } from '../../../../src/persistence/SnapshotStore.js';
import type { Option } from '../../../../src/util/Option.js';
import {
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
  RecoveryTimeoutError,
} from '../../../../src/persistence/index.js';
import type { ConfigObject } from '../../../../src/index.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { StallingJournal } from '../../../util/UnavailableJournal.js';

/**
 * #874 — the wiring, as opposed to the mechanisms.
 *
 * The unit suites prove that the breaker opens, that the permits queue and
 * that `replayState` falls back.  What they cannot prove is that
 * `PersistentActor` actually *goes through* any of it: every one of them would
 * stay green against a `persistAll` that still called `this._journal.append`
 * directly.  These tests exercise the real actor against a real
 * `ActorSystem`, so the assertions fail if the seam is removed.
 */

type DepositCommand = { readonly kind: 'deposit'; readonly amount: number };
type Command = DepositCommand;

type DepositedEvent = { readonly kind: 'deposited'; readonly amount: number };
type Event = DepositedEvent;

type State = { readonly balance: number };

/** Everything the tests read, recorded outside the actor. */
type Observations = {
  persistFailures: Error[];
  recoveryFailures: Error[];
  recovered: State[];
};

const newObservations = (): Observations => ({ persistFailures: [], recoveryFailures: [], recovered: [] });

class Account extends PersistentActor<Command, Event, State> {
  readonly persistenceId: string;

  constructor(persistenceId: string, private readonly observations: Observations) {
    super();
    this.persistenceId = persistenceId;
  }

  initialState(): State { return { balance: 0 }; }

  onEvent(state: State, event: Event): State { return { balance: state.balance + event.amount }; }

  override onRecoveryComplete(state: State): void { this.observations.recovered.push(state); }

  /**
   * Records rather than rethrows.  Supervision would restart the actor and
   * the restart would fail the same way, which is correct behaviour and
   * useless to assert against — the failure is what these tests are reading.
   */
  override onRecoveryFailure(reason: Error): void { this.observations.recoveryFailures.push(reason); }

  async onCommand(_state: State, command: Command): Promise<void> {
    try {
      await this.persist({ kind: 'deposited', amount: command.amount });
    } catch (e) {
      this.observations.persistFailures.push(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

function systemWith(name: string, config?: ConfigObject): ActorSystem {
  let options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (config) options = options.withConfig(config);
  return ActorSystem.create(name, options);
}

/** A journal whose `read` waits on a gate the test opens — a slow replay. */
class GatedJournal implements Journal {
  readonly reading: string[] = [];

  constructor(private readonly gate: Promise<void>) {}

  async append<E = unknown>(
    _persistenceId: string,
    _entries: ReadonlyArray<JournalEntry<E>>,
    _expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> { throw new Error('GatedJournal is read-only'); }

  async read<E = unknown>(persistenceId: string): Promise<PersistentEvent<E>[]> {
    this.reading.push(persistenceId);
    await this.gate;
    return [];
  }

  async highestSeq(): Promise<number> { return 0; }
  async delete(): Promise<void> {}
  async persistenceIds(): Promise<string[]> { return []; }
}

/**
 * Reads like an ordinary journal, but every `append` hangs.
 *
 * One object rather than swapping the extension's journal mid-test:
 * `PersistentActor` resolves its journal once in `preStart`, so a later
 * `setJournal` would leave the actor writing to the store it already held —
 * a test that passed for the wrong reason, or in this case did not pass at
 * all.  A store that accepts the connection and then stalls on writes is also
 * the more faithful shape of the outage.
 */
class AppendStallsJournal implements Journal {
  private readonly pending: Array<(error: Error) => void> = [];

  constructor(private readonly reads: Journal) {}

  async append<E = unknown>(
    _persistenceId: string,
    _entries: ReadonlyArray<JournalEntry<E>>,
    _expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    return new Promise<PersistentEvent<E>[]>((_resolve, reject) => { this.pending.push(reject); });
  }

  read<E = unknown>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    return this.reads.read<E>(persistenceId, fromSeq, toSeq);
  }

  highestSeq(persistenceId: string): Promise<number> { return this.reads.highestSeq(persistenceId); }
  delete(persistenceId: string, toSeq: number): Promise<void> { return this.reads.delete(persistenceId, toSeq); }
  persistenceIds(): Promise<string[]> { return this.reads.persistenceIds(); }

  /** End the hanging appends so their closures are collectable. */
  settleAll(): void {
    const parked = this.pending.splice(0, this.pending.length);
    for (const reject of parked) reject(new Error('test teardown'));
  }
}

/** A snapshot store whose reads always throw — the store is simply gone. */
class UnreachableSnapshotStore implements SnapshotStore {
  async save<S>(): Promise<Snapshot<S>> { throw new Error('snapshot store is unreachable'); }
  async loadLatest<S>(): Promise<Option<Snapshot<S>>> { throw new Error('snapshot store is unreachable'); }
  async loadBefore<S>(): Promise<Option<Snapshot<S>>> { throw new Error('snapshot store is unreachable'); }
  async delete(): Promise<void> {}
}

describe('PersistentActor — the journal breaker is in the persist path', () => {
  test('an open breaker fast-fails persist without reaching the journal', async () => {
    const system = systemWith('breaker-open');
    const extension = system.extension(PersistenceExtensionId);
    const journal = new InMemoryJournal();
    extension.configure({ journal, snapshotStore: new InMemorySnapshotStore() });

    const observations = newObservations();
    const ref = system.spawn(() => new Account('acct-open', observations), 'account');
    await awaitCondition(() => observations.recovered.length === 1, { label: 'the actor recovered' });

    // Opened after recovery, because recovery goes through the same breaker.
    extension.journalBreaker!.setState('open');
    ref.tell({ kind: 'deposit', amount: 5 });
    await awaitCondition(() => observations.persistFailures.length === 1, {
      label: 'persist failed through the open breaker',
    });

    expect(observations.persistFailures[0]).toBeInstanceOf(CircuitBreakerOpenError);
    expect(await journal.highestSeq('acct-open')).toBe(0);
    await system.terminate();
  });

  test('a stalled append is cut at the breaker call-timeout instead of wedging the actor', async () => {
    // The #913 hazard, end to end.  Without the breaker this `persist` never
    // settles, `_persisting` stays true, and every later command is stashed
    // until the 1024-entry stash throws from inside the user's own handler.
    const system = systemWith('breaker-call-timeout', {
      'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'call-timeout': '50ms' } } },
    });
    const extension = system.extension(PersistenceExtensionId);
    // Recovery reads normally; only the append stalls.
    const journal = new AppendStallsJournal(new InMemoryJournal());
    extension.configure({ journal, snapshotStore: new InMemorySnapshotStore() });

    const observations = newObservations();
    const ref = system.spawn(() => new Account('acct-stall', observations), 'account');
    await awaitCondition(() => observations.recovered.length === 1, { label: 'the actor recovered' });

    ref.tell({ kind: 'deposit', amount: 5 });
    await awaitCondition(() => observations.persistFailures.length === 1, {
      label: 'the stalled append was cut at the call-timeout',
    });

    expect(observations.persistFailures[0]).toBeInstanceOf(CircuitBreakerTimeoutError);
    journal.settleAll();
    await system.terminate();
  });
});

describe('PersistentActor — recovery is bounded', () => {
  test('recovery-timeout fails the actor instead of leaving it in preStart', async () => {
    const system = systemWith('recovery-timeout', {
      'actor-ts': { persistence: { 'recovery-timeout': '60ms' } },
    });
    const extension = system.extension(PersistenceExtensionId);
    const stalling = new StallingJournal();
    extension.configure({ journal: stalling, snapshotStore: new InMemorySnapshotStore() });

    const observations = newObservations();
    system.spawn(() => new Account('acct-timeout', observations), 'account');
    await awaitCondition(() => observations.recoveryFailures.length >= 1, {
      label: 'the stalled recovery hit its deadline',
    });

    expect(observations.recoveryFailures[0]).toBeInstanceOf(RecoveryTimeoutError);
    expect(observations.recovered).toEqual([]);
    stalling.settleAll();
    await system.terminate();
  });

  test('max-concurrent-recoveries caps the replays in flight', async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const system = systemWith('recovery-cap', {
      'actor-ts': { persistence: { 'max-concurrent-recoveries': 1 } },
    });
    const extension = system.extension(PersistenceExtensionId);
    const journal = new GatedJournal(gate);
    extension.configure({ journal, snapshotStore: new InMemorySnapshotStore() });

    const observations = newObservations();
    for (const id of ['acct-a', 'acct-b', 'acct-c']) {
      system.spawn(() => new Account(id, observations), id);
    }
    await awaitCondition(() => journal.reading.length === 1, {
      label: 'exactly one replay reached the journal under a cap of one',
    });
    // The other two are queued behind the permit, not reading.
    expect(extension.recoveryPermits?.queued).toBe(2);

    openGate();
    await awaitCondition(() => observations.recovered.length === 3, {
      label: 'all three actors recovered once the journal answered',
    });

    expect(extension.recoveryPermits?.peakInFlight).toBe(1);
    expect(journal.reading).toHaveLength(3);
    await system.terminate();
  });
});

describe('PersistentActor — snapshot-is-optional', () => {
  test('off: an unreachable snapshot store fails the recovery', async () => {
    const system = systemWith('snapshot-required');
    const extension = system.extension(PersistenceExtensionId);
    extension.configure({ journal: new InMemoryJournal(), snapshotStore: new UnreachableSnapshotStore() });

    const observations = newObservations();
    system.spawn(() => new Account('acct-required', observations), 'account');
    await awaitCondition(() => observations.recoveryFailures.length >= 1, {
      label: 'the recovery failed on the snapshot store',
    });

    expect(observations.recoveryFailures[0]?.message).toContain('snapshot store is unreachable');
    await system.terminate();
  });

  test('on: the actor recovers from the journal alone', async () => {
    const system = systemWith('snapshot-optional', {
      'actor-ts': { persistence: { 'snapshot-is-optional': true } },
    });
    const extension = system.extension(PersistenceExtensionId);
    const journal = new InMemoryJournal();
    await journal.append<Event>('acct-optional', [{ event: { kind: 'deposited', amount: 7 } }], 0);
    extension.configure({ journal, snapshotStore: new UnreachableSnapshotStore() });

    const observations = newObservations();
    system.spawn(() => new Account('acct-optional', observations), 'account');
    await awaitCondition(() => observations.recovered.length === 1, {
      label: 'the actor recovered without its snapshot store',
    });

    expect(observations.recovered[0]).toEqual({ balance: 7 });
    expect(observations.recoveryFailures).toEqual([]);
    await system.terminate();
  });
});
