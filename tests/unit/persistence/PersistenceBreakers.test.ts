import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { CircuitBreakerOpenError, CircuitBreakerTimeoutError } from '../../../src/pattern/CircuitBreaker.js';
import { CircuitBreakerExtensionId } from '../../../src/pattern/CircuitBreakerExtension.js';
import { JournalConcurrencyError } from '../../../src/persistence/JournalTypes.js';
import { PersistenceExtensionId } from '../../../src/persistence/PersistenceExtension.js';
import { JournalIntegrityError, SnapshotIntegrityError } from '../../../src/persistence/Replay.js';
import type { ConfigObject } from '../../../src/index.js';
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
    await expect(extension.callThroughJournalBreaker(async () => 'through')).resolves.toBe('through');
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

    const stalled = extension.callThroughJournalBreaker(() => new Promise<never>(() => {}));

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
      await expect(extension.callThroughJournalBreaker(async () => { throw error; })).rejects.toBe(error);
    }
  };

  /** Drive the real `Journal.append` signature through the breaker. */
  const appendThrough = (
    extension: ReturnType<typeof persistenceOf>['extension'],
    journal: RejectingJournal,
  ): Promise<unknown> => extension.callThroughJournalBreaker(
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
    await expect(extension.callThroughJournalBreaker(async () => 'still served')).resolves.toBe('still served');
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

    await expect(extension.callThroughSnapshotBreaker(async () => { throw new JournalUnavailableError('save'); }))
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
    await expect(extension.callThroughJournalBreaker(async () => 'still served')).resolves.toBe('still served');
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
      await expect(extension.callThroughJournalBreaker(async () => {
        throw new JournalIntegrityError('holed', 'acct-1', 3);
      })).rejects.toBeInstanceOf(JournalIntegrityError);
      await expect(extension.callThroughSnapshotBreaker(async () => {
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
      await expect(extension.callThroughJournalBreaker(async () => {
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
      await expect(extension.callThroughJournalBreaker(async () => {
        throw new JournalUnavailableError('append');
      })).rejects.toBeInstanceOf(JournalUnavailableError);
    }

    expect(extension.journalBreaker!.state).toBe('closed');
    await system.terminate();
  });
});
