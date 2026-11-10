import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { CircuitBreakerOpenError, CircuitBreakerTimeoutError } from '../../../../src/pattern/CircuitBreaker.js';
import {
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
  RecoveryTimeoutError,
} from '../../../../src/persistence/index.js';
import type { ConfigObject } from '../../../../src/index.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import {
  AppendStallsJournal,
  GatedJournal,
  StallingJournal,
  UnreachableSnapshotStore,
} from '../../../util/UnavailableJournal.js';

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
