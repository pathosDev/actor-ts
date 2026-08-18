/**
 * The journal contract, run against a journal that legitimately omits an
 * *optional* `Journal` method (#536).
 *
 * `PersistenceContract.test.ts` binds the same scenarios to eleven in-tree
 * journals, and every one of them implements `raiseCompactionMark` — so the
 * two scenarios that exercise it were free to assert its presence, and no
 * amount of green in that file could notice.  `src/persistence/Journal.ts`
 * documents the method as "optional, and absence is meaningful": a journal
 * that cannot record a mark independently of its events omits it, and
 * `migrateBetweenJournals` then refuses a compacted stream rather than
 * silently renumbering it.  A store like that is *conforming*, and the suite
 * has to say so — it is the tool a third-party backend author would reach for
 * to find out, which is the whole point of publishing it.
 *
 * These cases are deliberately not more harnesses in `PersistenceContract.test.ts`:
 * that file binds scenarios to stores and asserts they pass, while these assert
 * on the *skip decisions themselves*, which a `test.skip` cannot observe.  The
 * skip logic below is the same three lines as `bind()` there and as `adapt()` in
 * `brokers/lib/PersistenceContract.ts`, so what is asserted is what both real
 * consumers do.
 */
import { describe, expect, test } from 'bun:test';
import {
  InMemoryJournal,
  type Journal,
  type JournalEntry,
  type PersistentEvent,
} from '../../../../src/persistence/index.js';
import {
  journalContractScenarios,
  type JournalHarness,
} from '../../brokers/lib/persistence-contract/index.js';

/**
 * A journal that omits `raiseCompactionMark` — and only that.
 *
 * Delegation rather than a subclass with the method deleted: a subclass cannot
 * un-declare an inherited member, and `InMemoryJournal` has one.  The omitted
 * `events` bus and `persistenceIdsPaginated` are omitted for the same reason a
 * real third-party journal omits them, and no journal scenario reads either.
 */
class CompactionMarkLessJournal implements Journal {
  private readonly inner = new InMemoryJournal();

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

  highestSeq(persistenceId: string): Promise<number> {
    return this.inner.highestSeq(persistenceId);
  }

  delete(persistenceId: string, toSeq: number): Promise<void> {
    return this.inner.delete(persistenceId, toSeq);
  }

  persistenceIds(): Promise<string[]> {
    return this.inner.persistenceIds();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

/** The two scenarios `capabilities.compactionMark` is allowed to gate. */
const compactionMarkScenarioNames = [
  'raiseCompactionMark seeds the high-water mark of a stream with no events',
  'raiseCompactionMark is monotonic and never deletes events',
] as const;

type ScenarioOutcome = {
  readonly name: string;
  readonly skipReason: string | null;
  /** The assertion message, or `null` when the scenario passed or was skipped. */
  readonly failure: string | null;
};

/**
 * Resolve every journal scenario against `harness`, reporting skips and
 * failures separately.  The skip branch mirrors `bind()` in
 * `PersistenceContract.test.ts` exactly; the `try` is what a `test()` body
 * would otherwise do, kept here so a failure is data instead of a red test.
 */
async function resolveJournalContract(harness: JournalHarness): Promise<ScenarioOutcome[]> {
  const outcomes: ScenarioOutcome[] = [];
  for (const scenario of journalContractScenarios()) {
    const skipReason = scenario.skip?.(harness) ?? null;
    if (skipReason !== null) {
      outcomes.push({ name: scenario.name, skipReason, failure: null });
      continue;
    }
    try {
      await scenario.run(harness);
      outcomes.push({ name: scenario.name, skipReason: null, failure: null });
    } catch (error) {
      outcomes.push({ name: scenario.name, skipReason: null, failure: (error as Error).message });
    }
  }
  return outcomes;
}

const namespacer = (label: string) => (name: string): string => `${label}:${name}`;

/** Omits the method AND declares the omission — a conforming third-party store. */
const declaredHarness: JournalHarness = {
  label: 'CompactionMarkLessJournal',
  pid: namespacer('markless'),
  make: async () => new CompactionMarkLessJournal(),
  capabilities: { compactionMark: false },
};

/** Omits the method and says nothing — the harness is wrong, not the journal. */
const undeclaredHarness: JournalHarness = {
  label: 'CompactionMarkLessJournal (gap undeclared)',
  pid: namespacer('undeclared'),
  make: async () => new CompactionMarkLessJournal(),
};

/** The shape all eleven in-tree journal harnesses have: no capabilities at all. */
const inTreeHarness: JournalHarness = {
  label: 'InMemoryJournal',
  pid: namespacer('inmem-capabilities'),
  make: async () => new InMemoryJournal(),
};

describe('journal contract — capabilities.compactionMark', () => {
  test('a conforming journal that omits raiseCompactionMark passes the whole contract', async () => {
    const outcomes = await resolveJournalContract(declaredHarness);
    const failed = outcomes.filter((outcome) => outcome.failure !== null);
    // Named, not counted: a regression here should print which scenario broke.
    expect(failed.map((outcome) => `${outcome.name}: ${outcome.failure}`)).toEqual([]);
    // Guard against the trivial way to pass this — skipping everything.  Three
    // of the journal scenarios are gated for this harness: the two above, plus
    // the read-side one it has no `makeQuery` for.  Everything else has to have
    // actually run, and a fourth gate appearing here is worth a human looking.
    const ran = outcomes.filter((outcome) => outcome.skipReason === null);
    expect(ran.length).toBe(journalContractScenarios().length - 3);
  });

  test('the capability gates exactly the two raiseCompactionMark scenarios', async () => {
    const outcomes = await resolveJournalContract(declaredHarness);
    const gatedByCapability = outcomes
      .filter((outcome) => outcome.skipReason === 'journal does not implement the optional raiseCompactionMark')
      .map((outcome) => outcome.name)
      .sort();
    expect(gatedByCapability).toEqual([...compactionMarkScenarioNames].sort());
    // The blast radius, pinned: this harness sets no `makeQuery`, so the
    // read-side scenario skips for the reason it always did.  Anything else
    // appearing here means the new flag widened past the two scenarios it owns.
    const otherReasons = [...new Set(
      outcomes
        .filter((outcome) => outcome.skipReason !== null && !gatedByCapability.includes(outcome.name))
        .map((outcome) => outcome.skipReason),
    )];
    expect(otherReasons).toEqual(['backend has no query implementation']);
  });

  test('an undeclared gap still fails — the flag never papers over a divergence', async () => {
    const outcomes = await resolveJournalContract(undeclaredHarness);
    const gated = outcomes.filter((outcome) => compactionMarkScenarioNames.includes(
      outcome.name as (typeof compactionMarkScenarioNames)[number],
    ));
    expect(gated.length).toBe(compactionMarkScenarioNames.length);
    for (const outcome of gated) {
      // Absent capabilities mean "default", which for this flag is `true`, so
      // the scenario runs and the missing method is reported as a real failure.
      // Asserted on the invariant, not on the wording: this case is a guard
      // that has to hold both before and after the capability existed.
      expect(outcome.skipReason).toBeNull();
      expect(outcome.failure).toContain('raiseCompactionMark');
    }
  });

  test('a journal that implements it still runs both scenarios and passes them', async () => {
    const outcomes = await resolveJournalContract(inTreeHarness);
    const gated = outcomes.filter((outcome) => compactionMarkScenarioNames.includes(
      outcome.name as (typeof compactionMarkScenarioNames)[number],
    ));
    expect(gated.length).toBe(compactionMarkScenarioNames.length);
    for (const outcome of gated) {
      expect(outcome.skipReason).toBeNull();
      expect(outcome.failure).toBeNull();
    }
  });
});
