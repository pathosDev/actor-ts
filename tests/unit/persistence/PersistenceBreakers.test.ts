import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { CircuitBreakerOpenError, CircuitBreakerTimeoutError } from '../../../src/pattern/CircuitBreaker.js';
import { CircuitBreakerExtensionId } from '../../../src/pattern/CircuitBreakerExtension.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { JournalConcurrencyError, type Snapshot } from '../../../src/persistence/JournalTypes.js';
import type { EventAdapter } from '../../../src/persistence/migration/Adapter.js';
import { MigrationError } from '../../../src/persistence/migration/Envelope.js';
import { PersistenceExtensionId } from '../../../src/persistence/PersistenceExtension.js';
import { PersistentActor } from '../../../src/persistence/PersistentActor.js';
import { JournalIntegrityError, SnapshotIntegrityError } from '../../../src/persistence/Replay.js';
import { InMemorySnapshotStore } from '../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import type { SnapshotStore } from '../../../src/persistence/SnapshotStore.js';
import type { Option } from '../../../src/util/Option.js';
import type { ConfigObject } from '../../../src/index.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { createTestActorSystem } from '../../util/TestActorSystem.js';
import { JournalUnavailableError, RejectingJournal } from '../../util/UnavailableJournal.js';

/**
 * #874 — the journal and snapshot store are called through a circuit breaker.
 *
 * The breaker itself is #864's, resolved by id through
 * `CircuitBreakerExtension`, which is the whole design decision under test
 * here: `actor-ts.persistence.journal-breaker` is a **name**, so a breaker's
 * numbers keep living under `actor-ts.circuit-breaker.<id>` and there is never
 * a second copy of `max-failures` to drift from the first.  What persistence
 * adds is the id, the off-switch, and the `isFailure` classifier a config file
 * cannot express.
 */

const persistenceOf = (config?: ConfigObject) => {
  const system = createTestActorSystem({ name: 'persistence-breakers', ...(config ? { config } : {}) });
  return { system, extension: system.extension(PersistenceExtensionId) };
};

describe('PersistenceExtension — breaker resolution', () => {
  test('resolves the two documented ids by default', async () => {
    const { system, extension } = persistenceOf();
    const registry = system.extension(CircuitBreakerExtensionId);

    expect(extension.journalBreaker).toBe(registry.breaker('persistence-journal'));
    expect(extension.snapshotBreaker).toBe(registry.breaker('persistence-snapshot'));
    // Two instances, not one shared: a snapshot store that is down must not
    // fast-fail a journal that is fine.
    expect(extension.journalBreaker).not.toBe(extension.snapshotBreaker);
    await system.terminate();
  });

  test('an empty id means no breaker at all, and the call still runs', async () => {
    const { system, extension } = persistenceOf({
      'actor-ts': { persistence: { 'journal-breaker': '', 'snapshot-breaker': '' } },
    });

    expect(extension.journalBreaker).toBeNull();
    expect(extension.snapshotBreaker).toBeNull();
    await expect(extension.callThroughJournalBreaker('append', async () => 'through')).resolves.toBe('through');
    await system.terminate();
  });

  test('a configured id is the one that is used, and its block supplies the numbers', async () => {
    const { system, extension } = persistenceOf({
      'actor-ts': {
        persistence: { 'journal-breaker': 'my-journal' },
        'circuit-breaker': { 'my-journal': { 'max-failures': 2, 'reset-timeout': '5s' } },
      },
    });

    const breaker = extension.journalBreaker;
    expect(breaker).not.toBeNull();
    expect(breaker!.options.maxFailures).toBe(2);
    expect(breaker!.options.resetTimeoutMs).toBe(5_000);
    await system.terminate();
  });

  test('a stock system gets NO call-timeout, so an append still has no ceiling', async () => {
    // The #913 hazard is reachable in one config line, and is not closed by
    // default (#874).  That is a decision — a shipped ceiling would fail a
    // slow-but-healthy store that every release before this one served fine —
    // but it was a decision nothing asserted, which is how "the breakers ship
    // on" reads as "the stall is handled".  It is not: `max-failures` cannot
    // substitute, because a call that never returns is never counted.
    expect(Config.parseString(REFERENCE_CONF).hasPath(
      'actor-ts.circuit-breaker.persistence-journal.call-timeout',
    )).toBe(false);
    expect(Config.parseString(REFERENCE_CONF).hasPath(
      'actor-ts.circuit-breaker.default.call-timeout',
    )).toBe(false);

    const { system, extension } = persistenceOf();
    expect(extension.journalBreaker!.options.callTimeoutMs).toBeUndefined();
    expect(extension.snapshotBreaker!.options.callTimeoutMs).toBeUndefined();
    await system.terminate();
  });

  test('call-timeout is read from the breaker block and cuts a stalled call', async () => {
    // The #913 hazard in one assertion: an append that never settles is
    // bounded by the breaker's per-call timeout and by nothing else.
    const { system, extension } = persistenceOf({
      'actor-ts': {
        'circuit-breaker': { 'persistence-journal': { 'call-timeout': '20ms' } },
      },
    });

    const stalled = extension.callThroughJournalBreaker('append', () => new Promise<never>(() => {}));

    await expect(stalled).rejects.toBeInstanceOf(CircuitBreakerTimeoutError);
    await system.terminate();
  });
});

describe('PersistenceExtension — what counts as an outage', () => {
  const outageAfter = async (
    extension: ReturnType<typeof persistenceOf>['extension'],
    error: Error,
    attempts: number,
  ): Promise<void> => {
    for (let i = 0; i < attempts; i++) {
      await expect(extension.callThroughJournalBreaker('append', async () => { throw error; })).rejects.toBe(error);
    }
  };

  /** Drive the real `Journal.append` signature through the breaker. */
  const appendThrough = (
    extension: ReturnType<typeof persistenceOf>['extension'],
    journal: RejectingJournal,
  ): Promise<unknown> => extension.callThroughJournalBreaker(
    'append',
    () => journal.append('acct-1', [{ event: { kind: 'deposited' } }], 0),
  );

  test('a real outage opens the breaker and the journal stops being asked', async () => {
    const { system, extension } = persistenceOf({
      'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'max-failures': 3 } } },
    });
    const journal = new RejectingJournal();

    for (let i = 0; i < 3; i++) {
      await expect(appendThrough(extension, journal)).rejects.toBeInstanceOf(JournalUnavailableError);
    }

    expect(extension.journalBreaker!.state).toBe('open');
    // The point of the breaker: a dead journal stops being asked once per
    // command, so the fourth call never reaches the store at all.
    await expect(appendThrough(extension, journal)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(journal.calls).toEqual(['append', 'append', 'append']);
    await system.terminate();
  });

  test('a JournalConcurrencyError never counts, however many there are', async () => {
    // The ownership verdict of a conditional append (#1166), not an outage.
    // Ten unlucky entities losing a race must not fast-fail every healthy one
    // on the node.
    const { system, extension } = persistenceOf({
      'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'max-failures': 3 } } },
    });
    const journal = new RejectingJournal(() => new JournalConcurrencyError('acct-1', 4, 7));

    for (let i = 0; i < 10; i++) {
      await expect(appendThrough(extension, journal)).rejects.toBeInstanceOf(JournalConcurrencyError);
    }

    expect(extension.journalBreaker!.state).toBe('closed');
    expect(journal.calls).toHaveLength(10);
    await expect(extension.callThroughJournalBreaker('append', async () => 'still served')).resolves.toBe('still served');
    await system.terminate();
  });

  test('neither integrity verdict counts', async () => {
    // A durable fact about the stored bytes.  Waiting cannot change it, and a
    // breaker is a device for waiting out a transient fault.
    const { system, extension } = persistenceOf({
      'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'max-failures': 2 } } },
    });

    await outageAfter(extension, new JournalIntegrityError('holed', 'acct-1', 3), 2);
    await outageAfter(extension, new SnapshotIntegrityError('ahead', 'acct-1', 9), 2);

    expect(extension.journalBreaker!.state).toBe('closed');
    await system.terminate();
  });

  test('the operator half of the classifier still wins — ignored-error-names', async () => {
    const { system, extension } = persistenceOf({
      'actor-ts': {
        'circuit-breaker': {
          'persistence-journal': { 'max-failures': 2, 'ignored-error-names': ['JournalUnavailableError'] },
        },
      },
    });

    await outageAfter(extension, new JournalUnavailableError('append'), 5);

    expect(extension.journalBreaker!.state).toBe('closed');
    await system.terminate();
  });

  test('the snapshot breaker trips on its own budget, leaving the journal closed', async () => {
    const { system, extension } = persistenceOf({
      'actor-ts': { 'circuit-breaker': { 'persistence-snapshot': { 'max-failures': 1 } } },
    });

    await expect(extension.callThroughSnapshotBreaker('save', async () => { throw new JournalUnavailableError('save'); }))
      .rejects.toBeInstanceOf(JournalUnavailableError);

    expect(extension.snapshotBreaker!.state).toBe('open');
    expect(extension.journalBreaker!.state).toBe('closed');
    await system.terminate();
  });
});

/**
 * The carve-out is a property of the **call**, not of whoever reached the id
 * first.
 *
 * `actor-ts.persistence.journal-breaker` publishes `persistence-journal` as a
 * configuration path, `PersistenceExtension.journalBreaker` invites a
 * dashboard to read the state, and `CircuitBreakerExtension.breaker(id)`
 * hands back the instance that already exists rather than reconfiguring it.
 * Put together, that made the classifier reachable only when persistence
 * happened to construct the instance — one earlier
 * `breaker('persistence-journal')` anywhere in the process and a burst of
 * losing conditional appends fast-failed every healthy entity on the node.
 */
describe('PersistenceExtension — the carve-out survives any resolution order', () => {
  const losingAppends = async (
    extension: ReturnType<typeof persistenceOf>['extension'],
    attempts: number,
  ): Promise<void> => {
    const journal = new RejectingJournal(() => new JournalConcurrencyError('acct-1', 4, 7));
    for (let i = 0; i < attempts; i++) {
      await expect(extension.callThroughJournalBreaker(
        'append',
        () => journal.append('acct-1', [{ event: { kind: 'deposited' } }], 0),
      )).rejects.toBeInstanceOf(JournalConcurrencyError);
    }
  };

  test('a JournalConcurrencyError never counts when the registry resolved the id first', async () => {
    const system = createTestActorSystem({
      name: 'persistence-breakers-order',
      config: { 'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'max-failures': 3 } } } },
    });
    // The one line that used to decide it: an observer resolving the published
    // id before persistence ever asks for it.
    const preResolved = system.extension(CircuitBreakerExtensionId).breaker('persistence-journal');
    const extension = system.extension(PersistenceExtensionId);
    expect(extension.journalBreaker).toBe(preResolved);

    await losingAppends(extension, 10);

    expect(extension.journalBreaker!.state).toBe('closed');
    await expect(extension.callThroughJournalBreaker('append', async () => 'still served')).resolves.toBe('still served');
    await system.terminate();
  });

  test('an integrity verdict never counts when the registry resolved the id first', async () => {
    const system = createTestActorSystem({
      name: 'persistence-breakers-order-integrity',
      config: {
        'actor-ts': {
          'circuit-breaker': {
            'persistence-journal': { 'max-failures': 2 },
            'persistence-snapshot': { 'max-failures': 2 },
          },
        },
      },
    });
    const registry = system.extension(CircuitBreakerExtensionId);
    registry.breaker('persistence-journal');
    registry.breaker('persistence-snapshot');
    const extension = system.extension(PersistenceExtensionId);

    for (let i = 0; i < 4; i++) {
      await expect(extension.callThroughJournalBreaker('replay', async () => {
        throw new JournalIntegrityError('holed', 'acct-1', 3);
      })).rejects.toBeInstanceOf(JournalIntegrityError);
      await expect(extension.callThroughSnapshotBreaker('load', async () => {
        throw new SnapshotIntegrityError('ahead', 'acct-1', 9);
      })).rejects.toBeInstanceOf(SnapshotIntegrityError);
    }

    expect(extension.journalBreaker!.state).toBe('closed');
    expect(extension.snapshotBreaker!.state).toBe('closed');
    await system.terminate();
  });

  test('a real outage still opens the pre-resolved breaker', async () => {
    // The carve-out must not have become "nothing counts".
    const system = createTestActorSystem({
      name: 'persistence-breakers-order-outage',
      config: { 'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'max-failures': 2 } } } },
    });
    system.extension(CircuitBreakerExtensionId).breaker('persistence-journal');
    const extension = system.extension(PersistenceExtensionId);

    for (let i = 0; i < 2; i++) {
      await expect(extension.callThroughJournalBreaker('append', async () => {
        throw new JournalUnavailableError('append');
      })).rejects.toBeInstanceOf(JournalUnavailableError);
    }

    expect(extension.journalBreaker!.state).toBe('open');
    await system.terminate();
  });

  test('the operator half of the classifier still wins on a pre-resolved breaker', async () => {
    // `ignored-error-names` is read from the id's own block whoever builds the
    // instance, so it was never order-dependent — but it must still come first
    // now that the code-side predicate travels with the call.
    const system = createTestActorSystem({
      name: 'persistence-breakers-order-ignored',
      config: {
        'actor-ts': {
          'circuit-breaker': {
            'persistence-journal': { 'max-failures': 2, 'ignored-error-names': ['JournalUnavailableError'] },
          },
        },
      },
    });
    system.extension(CircuitBreakerExtensionId).breaker('persistence-journal');
    const extension = system.extension(PersistenceExtensionId);

    for (let i = 0; i < 5; i++) {
      await expect(extension.callThroughJournalBreaker('append', async () => {
        throw new JournalUnavailableError('append');
      })).rejects.toBeInstanceOf(JournalUnavailableError);
    }

    expect(extension.journalBreaker!.state).toBe('closed');
    await system.terminate();
  });
});

/* ------------- a real PersistentActor, for what the seams wrap -------------- */

type DepositCommand = { readonly kind: 'deposit'; readonly amount: number };
type DepositedEvent = { readonly kind: 'deposited'; readonly amount: number };
type LedgerState = { readonly balance: number };

/** Everything the recovery tests read, recorded outside the actors. */
type Observations = {
  readonly recovered: string[];
  readonly recoveryFailures: Error[];
  readonly persisted: number[];
  readonly persistFailures: Error[];
};

const newObservations = (): Observations => ({ recovered: [], recoveryFailures: [], persisted: [], persistFailures: [] });

class Ledger extends PersistentActor<DepositCommand, DepositedEvent, LedgerState> {
  constructor(readonly persistenceId: string, private readonly observations: Observations) { super(); }

  initialState(): LedgerState { return { balance: 0 }; }

  onEvent(state: LedgerState, event: DepositedEvent): LedgerState {
    return { balance: state.balance + event.amount };
  }

  override onRecoveryComplete(): void { this.observations.recovered.push(this.persistenceId); }

  /** Records and returns, so the actor stops instead of restarting into the same outage. */
  override onRecoveryFailure(reason: Error): void { this.observations.recoveryFailures.push(reason); }

  async onCommand(_state: LedgerState, command: DepositCommand): Promise<void> {
    try {
      await this.persist({ kind: 'deposited', amount: command.amount }, (state) => {
        this.observations.persisted.push(state.balance);
      });
    } catch (e) {
      this.observations.persistFailures.push(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

/** Every read throws — the snapshot store is simply gone. */
class UnreachableSnapshotStore implements SnapshotStore {
  readonly loads: string[] = [];
  async save<S>(): Promise<Snapshot<S>> { throw new Error('snapshot store is unreachable'); }
  async loadLatest<S>(persistenceId: string): Promise<Option<Snapshot<S>>> {
    this.loads.push(persistenceId);
    throw new Error('snapshot store is unreachable');
  }
  async loadBefore<S>(): Promise<Option<Snapshot<S>>> { throw new Error('snapshot store is unreachable'); }
  async delete(): Promise<void> {}
}

/** Reads like an empty journal, and cannot say where its head is. */
class HeadlessJournal extends InMemoryJournal {
  headProbes = 0;

  override async highestSeq(): Promise<number> {
    this.headProbes++;
    throw new JournalUnavailableError('highestSeq');
  }
}

/**
 * Two instances, so that a snapshot store that is down cannot fast-fail a
 * journal that is fine — the invariant the first test in this file states and
 * checks only by identity (#1496, a repair of #874).
 *
 * Identity was never the property.  Recovery ran its snapshot load *inside* the
 * journal call, so a snapshot store that could not answer was counted by the
 * journal breaker: ten entities restarting into an unreachable snapshot store
 * opened it, and every append on the node — from entities whose own recovery
 * had finished long before — was refused with `CircuitBreakerOpenError`
 * against a journal that never failed once.
 */
describe('PersistentActor recovery — a snapshot-store outage is the snapshot breaker\'s', () => {
  test('ten recoveries failing only on loadLatest leave the journal breaker closed, and a healthy persist lands', async () => {
    // Default config on purpose: `max-failures = 10` for both ids and
    // `snapshot-is-optional = false`, so every one of the ten recoveries fails.
    const { system, extension } = persistenceOf();
    const journal = new InMemoryJournal();
    extension.configure({ journal, snapshotStore: new InMemorySnapshotStore() });
    const observations = newObservations();

    // Recovered before the outage.  `PersistentActor` resolves its stores in
    // `preStart`, so this one keeps the healthy snapshot store it started with.
    const healthy = system.spawn(() => new Ledger('ledger-healthy', observations), 'ledger-healthy');
    await awaitCondition(() => observations.recovered.length === 1, { label: 'the healthy entity recovered' });

    const unreachable = new UnreachableSnapshotStore();
    extension.setSnapshotStore(unreachable);
    for (let i = 0; i < 10; i++) {
      system.spawn(() => new Ledger(`ledger-${i}`, observations), `ledger-${i}`);
    }
    await awaitCondition(() => observations.recoveryFailures.length === 10, {
      timeoutMs: 4_000,
      label: 'all ten recoveries failed on the snapshot store',
    });
    expect(unreachable.loads).toHaveLength(10);

    // The outage belongs to the store that had it.
    expect(extension.journalBreaker!.state).toBe('closed');
    expect(extension.snapshotBreaker!.state).toBe('open');

    // And the journal is still served: the healthy entity's append lands.
    healthy.tell({ kind: 'deposit', amount: 5 });
    await awaitCondition(() => observations.persisted.length + observations.persistFailures.length === 1, {
      label: 'the healthy entity\'s persist settled',
    });
    expect(observations.persistFailures).toEqual([]);
    expect(observations.persisted).toEqual([5]);
    expect(await journal.highestSeq('ledger-healthy')).toBe(1);
    await system.terminate();
  });

  test('the journal half of a recovery is still the journal breaker\'s: a dead journal opens it and the next replay is not asked', async () => {
    // The repair must not have become "recovery is unguarded".
    const { system, extension } = persistenceOf({
      'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'max-failures': 3 } } },
    });
    const journal = new RejectingJournal();
    extension.configure({ journal, snapshotStore: new InMemorySnapshotStore() });
    const observations = newObservations();

    for (let i = 0; i < 3; i++) {
      system.spawn(() => new Ledger(`ledger-${i}`, observations), `ledger-${i}`);
    }
    await awaitCondition(() => observations.recoveryFailures.length === 3, {
      label: 'three recoveries failed on the journal',
    });
    expect(extension.journalBreaker!.state).toBe('open');
    expect(extension.snapshotBreaker!.state).toBe('closed');

    system.spawn(() => new Ledger('ledger-late', observations), 'ledger-late');
    await awaitCondition(() => observations.recoveryFailures.length === 4, {
      label: 'the fourth recovery failed fast',
    });
    expect(observations.recoveryFailures[3]).toBeInstanceOf(CircuitBreakerOpenError);
    expect(journal.calls).toEqual(['read', 'read', 'read']);
    await system.terminate();
  });

  test('with snapshot-is-optional, an open snapshot breaker is tolerated like an unreachable store', async () => {
    // The breaker sits inside the tolerance, not around it: a load it refuses
    // falls back to a full replay exactly as a load the store refused does.
    const { system, extension } = persistenceOf({
      'actor-ts': { persistence: { 'snapshot-is-optional': true } },
    });
    const journal = new InMemoryJournal();
    await journal.append<DepositedEvent>('ledger-replayed', [{ event: { kind: 'deposited', amount: 7 } }], 0);
    const unreachable = new UnreachableSnapshotStore();
    extension.configure({ journal, snapshotStore: unreachable });
    extension.snapshotBreaker!.setState('open');
    const observations = newObservations();

    const ledger = system.spawn(() => new Ledger('ledger-replayed', observations), 'ledger-replayed');
    await awaitCondition(() => observations.recovered.length === 1, {
      label: 'the entity recovered from the journal alone',
    });
    expect(observations.recoveryFailures).toEqual([]);
    // Refused by the breaker: the store itself was never asked.
    expect(unreachable.loads).toEqual([]);

    ledger.tell({ kind: 'deposit', amount: 1 });
    await awaitCondition(() => observations.persisted.length === 1, { label: 'the replayed entity persisted' });
    expect(observations.persisted).toEqual([8]);
    await system.terminate();
  });
});

/**
 * The fold is user code, and a throw from it is no more a journal outage than
 * an unreachable snapshot store is (#1496, found beside the snapshot repair).
 *
 * The journal call used to wrap the fold along with the read, so an `onEvent`
 * that cannot fold some entity's history — a bug, an event the current code
 * no longer understands, a missing upcaster after a deploy — failed the
 * journal call and was counted as an outage.  Ten such entities restarting
 * opened the journal breaker for the whole node.  That is the same shape as
 * the losing conditional appends #874 carved out: a deterministic verdict on
 * one entity, which waiting cannot change and which must not fast-fail every
 * healthy one.
 */
describe('PersistentActor recovery — a fold that throws is not a journal outage', () => {
  /** A ledger whose fold refuses every event — the history cannot be folded by this code. */
  class UnfoldableLedger extends Ledger {
    override onEvent(_state: LedgerState, _event: DepositedEvent): LedgerState {
      throw new Error('this build cannot fold a deposited event');
    }
  }

  /** A ledger that adopted envelopes over a journal still holding raw events. */
  class EnvelopedLedger extends Ledger {
    override eventAdapter(): EventAdapter<DepositedEvent> {
      return {
        manifest: () => 'deposited',
        toJournal: (event) => ({ manifest: 'deposited', version: 1, payload: event }),
        fromJournal: (stored) => stored.payload as DepositedEvent,
      };
    }
  }

  test('ten recoveries whose onEvent throws leave the journal breaker closed, and a healthy persist lands', async () => {
    const { system, extension } = persistenceOf();
    const journal = new InMemoryJournal();
    for (let i = 0; i < 10; i++) {
      await journal.append<DepositedEvent>(`ledger-unfoldable-${i}`, [{ event: { kind: 'deposited', amount: 1 } }], 0);
    }
    extension.configure({ journal, snapshotStore: new InMemorySnapshotStore() });
    const observations = newObservations();

    const healthy = system.spawn(() => new Ledger('ledger-healthy', observations), 'ledger-healthy');
    await awaitCondition(() => observations.recovered.length === 1, { label: 'the healthy entity recovered' });

    for (let i = 0; i < 10; i++) {
      system.spawn(() => new UnfoldableLedger(`ledger-unfoldable-${i}`, observations), `ledger-unfoldable-${i}`);
    }
    await awaitCondition(() => observations.recoveryFailures.length === 10, {
      timeoutMs: 4_000,
      label: 'all ten folds threw',
    });
    expect(observations.recoveryFailures.map((e) => e.message)).toEqual(
      Array.from({ length: 10 }, () => 'this build cannot fold a deposited event'),
    );

    expect(extension.journalBreaker!.state).toBe('closed');

    healthy.tell({ kind: 'deposit', amount: 5 });
    await awaitCondition(() => observations.persisted.length + observations.persistFailures.length === 1, {
      label: 'the healthy entity\'s persist settled',
    });
    expect(observations.persistFailures).toEqual([]);
    expect(observations.persisted).toEqual([5]);
    await system.terminate();
  });

  test('ten recoveries whose events cannot be decoded leave the journal breaker closed', async () => {
    // The deploy forgot the one-shot wrap: `decodeEvent` refuses every raw
    // event with a `MigrationError`.  A verdict on this data, not on the
    // journal that returned it — so decoding sits with the fold, not the read.
    const { system, extension } = persistenceOf();
    const journal = new InMemoryJournal();
    for (let i = 0; i < 10; i++) {
      await journal.append<DepositedEvent>(`ledger-raw-${i}`, [{ event: { kind: 'deposited', amount: 1 } }], 0);
    }
    extension.configure({ journal, snapshotStore: new InMemorySnapshotStore() });
    const observations = newObservations();

    for (let i = 0; i < 10; i++) {
      system.spawn(() => new EnvelopedLedger(`ledger-raw-${i}`, observations), `ledger-raw-${i}`);
    }
    await awaitCondition(() => observations.recoveryFailures.length === 10, {
      timeoutMs: 4_000,
      label: 'all ten decodes threw',
    });
    expect(observations.recoveryFailures.every((e) => e instanceof MigrationError)).toBe(true);
    expect(extension.journalBreaker!.state).toBe('closed');
    await system.terminate();
  });

  test('the head probe stays the journal\'s: a journal that reads but cannot report its head counts', async () => {
    // Moving the fold out must not take the `highestSeq` probe with it — a
    // stalled backend stalls that query exactly as readily as the read (#874).
    const { system, extension } = persistenceOf({
      'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'max-failures': 2 } } },
    });
    const journal = new HeadlessJournal();
    extension.configure({ journal, snapshotStore: new InMemorySnapshotStore() });
    const observations = newObservations();

    for (let i = 0; i < 2; i++) {
      system.spawn(() => new Ledger(`ledger-${i}`, observations), `ledger-${i}`);
    }
    await awaitCondition(() => observations.recoveryFailures.length === 2, {
      label: 'both head probes failed',
    });
    expect(journal.headProbes).toBe(2);
    expect(extension.journalBreaker!.state).toBe('open');
    await system.terminate();
  });
});

/**
 * `deleteHistory` is a store call like any other, and it was the one call on
 * `PersistentActor` with no breaker in front of it (#1496): with `call-timeout`
 * configured, a backend that accepted a delete and never answered still parked
 * the compaction — and the command that asked for it — for good.
 */
describe('PersistentActor.deleteHistory — each delete through its own store\'s breaker', () => {
  type CompactCommand = { readonly kind: 'compact'; readonly toSequenceNr: number };
  type CompactionOutcome = Error | 'compacted';

  /** Compacts on command and records how each compaction ended. */
  class Compactor extends PersistentActor<CompactCommand, DepositedEvent, LedgerState> {
    constructor(readonly persistenceId: string, private readonly outcomes: CompactionOutcome[]) { super(); }

    initialState(): LedgerState { return { balance: 0 }; }

    onEvent(state: LedgerState, event: DepositedEvent): LedgerState {
      return { balance: state.balance + event.amount };
    }

    async onCommand(_state: LedgerState, command: CompactCommand): Promise<void> {
      try {
        await this.deleteHistory(command.toSequenceNr);
        this.outcomes.push('compacted');
      } catch (e) {
        this.outcomes.push(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  /** Reads and appends like a healthy journal; a delete is accepted and never answered. */
  class DeleteStallingJournal extends InMemoryJournal {
    private readonly parked: Array<(error: Error) => void> = [];

    get deletesInFlight(): number { return this.parked.length; }

    override delete(): Promise<void> {
      return new Promise<void>((_resolve, reject) => { this.parked.push(reject); });
    }

    /** Unwind every parked delete, so teardown is not left waiting on one. */
    settleAll(): void {
      for (const reject of this.parked.splice(0)) reject(new JournalUnavailableError('settleAll'));
    }
  }

  /** As {@link DeleteStallingJournal}, for the snapshot store. */
  class DeleteStallingSnapshotStore extends InMemorySnapshotStore {
    private readonly parked: Array<(error: Error) => void> = [];

    get deletesInFlight(): number { return this.parked.length; }

    override delete(): Promise<void> {
      return new Promise<void>((_resolve, reject) => { this.parked.push(reject); });
    }

    settleAll(): void {
      for (const reject of this.parked.splice(0)) reject(new JournalUnavailableError('settleAll'));
    }
  }

  test('a journal delete that never answers is cut by the journal breaker\'s call-timeout', async () => {
    const { system, extension } = persistenceOf({
      'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'call-timeout': '50ms' } } },
    });
    const journal = new DeleteStallingJournal();
    extension.configure({ journal, snapshotStore: new InMemorySnapshotStore() });
    const outcomes: CompactionOutcome[] = [];
    try {
      const compactor = system.spawn(() => new Compactor('ledger-compacted', outcomes), 'ledger-compacted');
      compactor.tell({ kind: 'compact', toSequenceNr: 1 });
      await awaitCondition(() => outcomes.length === 1, {
        timeoutMs: 2_000,
        label: 'the stalled journal delete was cut by call-timeout',
      });
      expect(outcomes[0]).toBeInstanceOf(CircuitBreakerTimeoutError);
      expect(journal.deletesInFlight).toBe(1);
    } finally {
      journal.settleAll();
      await system.terminate();
    }
  });

  test('a snapshot delete that never answers is cut by the snapshot breaker\'s call-timeout', async () => {
    const { system, extension } = persistenceOf({
      'actor-ts': { 'circuit-breaker': { 'persistence-snapshot': { 'call-timeout': '50ms' } } },
    });
    const snapshotStore = new DeleteStallingSnapshotStore();
    extension.configure({ journal: new InMemoryJournal(), snapshotStore });
    const outcomes: CompactionOutcome[] = [];
    try {
      const compactor = system.spawn(() => new Compactor('ledger-compacted', outcomes), 'ledger-compacted');
      compactor.tell({ kind: 'compact', toSequenceNr: 1 });
      await awaitCondition(() => outcomes.length === 1, {
        timeoutMs: 2_000,
        label: 'the stalled snapshot delete was cut by call-timeout',
      });
      expect(outcomes[0]).toBeInstanceOf(CircuitBreakerTimeoutError);
      expect(snapshotStore.deletesInFlight).toBe(1);
    } finally {
      snapshotStore.settleAll();
      await system.terminate();
    }
  });
});
