/**
 * Shared live-DB persistence contract — exercised by both the Postgres
 * and MariaDB suites against a REAL database container.  The behaviour
 * under test is identical (same `Journal` / `SnapshotStore` /
 * `DurableStateStore` contract); only construction differs, so each
 * runner builds the concrete backends, drops them into the context, and runs
 * these scenarios.  This is the live counterpart to the in-process
 * Fake{Pg,MariaDb}Pool unit tests.
 *
 * Each scenario resets its persistence-id up front (delete) so re-running
 * a suite without `down -v` is idempotent.
 */
import type { Journal } from '../../../../src/persistence/Journal.js';
import type { SnapshotStore } from '../../../../src/persistence/SnapshotStore.js';
import type { DurableStateStore } from '../../../../src/persistence/DurableStateStore.js';
import type { BrokerScenario, BrokerScenarioContext } from './scenario.js';

export interface SqlPersistenceContext extends BrokerScenarioContext {
  /** Short label — used in messages and to namespace persistence-ids ("pg", "mariadb"). */
  readonly label: string;
  readonly journal: Journal;
  /** Constructed with `keepN: 2` so the prune assertion is meaningful. */
  readonly snapshotStore: SnapshotStore;
  readonly durableState: DurableStateStore;
}

const MAX_SEQ = Number.MAX_SAFE_INTEGER;

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

async function expectThrows(fn: () => Promise<unknown>, name: string, what: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if ((e as Error).name === name) return;
    throw new Error(`${what}: expected ${name}, got ${(e as Error).name}: ${(e as Error).message}`);
  }
  throw new Error(`${what}: expected ${name} to be thrown, but nothing was`);
}

export function sqlPersistenceScenarios(): BrokerScenario<SqlPersistenceContext>[] {
  return [
    {
      name: 'journal — append / read / range / concurrency / tags / delete / ids',
      async run(context) {
        const persistenceId = `${context.label}:journal`;
        await context.journal.delete(persistenceId, MAX_SEQ);   // reset for idempotent re-runs

        const written = await context.journal.append(persistenceId, ['e1', 'e2', 'e3'], 0, ['tagA', 'tagB']);
        assert(written.map((e) => e.sequenceNr).join(',') === '1,2,3', 'monotonic seq 1,2,3');

        const all = await context.journal.read<string>(persistenceId, 1);
        assert(all.length === 3, `read 3, got ${all.length}`);
        assert(all[0]!.event === 'e1', 'payload round-trip');
        assert(typeof all[0]!.sequenceNr === 'number', 'sequenceNr coerced to number');
        assert(JSON.stringify(all[0]!.tags) === JSON.stringify(['tagA', 'tagB']), 'tags round-trip');

        assert(await context.journal.highestSeq(persistenceId) === 3, 'highestSeq is 3');

        const ranged = await context.journal.read(persistenceId, 2, 2);
        assert(ranged.length === 1 && ranged[0]!.sequenceNr === 2, 'inclusive range read');

        await expectThrows(() => context.journal.append(persistenceId, ['x'], 0), 'JournalConcurrencyError', 'stale append');

        const more = await context.journal.append(persistenceId, ['e4'], 3);
        assert(more[0]!.sequenceNr === 4, 'append resumes after correct expectedSeq');

        await context.journal.delete(persistenceId, 2);
        const afterDelete = await context.journal.read(persistenceId, 1);
        assert(afterDelete.map((e) => e.sequenceNr).join(',') === '3,4', 'delete compacts up to toSeq');

        assert((await context.journal.persistenceIds()).includes(persistenceId), 'persistenceIds includes our pid');
      },
    },
    {
      name: 'snapshot — save / loadLatest / loadBefore / keepN prune / delete',
      async run(context) {
        const persistenceId = `${context.label}:snap`;
        await context.snapshotStore.delete(persistenceId, MAX_SEQ);   // reset

        await context.snapshotStore.save(persistenceId, 1, { v: 1 });
        await context.snapshotStore.save(persistenceId, 2, { v: 2 });
        await context.snapshotStore.save(persistenceId, 3, { v: 3 });   // keepN=2 → seq 1 pruned

        const latest = (await context.snapshotStore.loadLatest<{ v: number }>(persistenceId)).toNullable();
        assert(latest?.sequenceNr === 3 && latest.state.v === 3, 'loadLatest is seq 3');

        const before = (await context.snapshotStore.loadBefore<{ v: number }>(persistenceId, 3)).toNullable();
        assert(before?.sequenceNr === 2, 'loadBefore(3) is seq 2');

        const pruned = (await context.snapshotStore.loadBefore(persistenceId, 2)).toNullable();
        assert(pruned === null, 'seq 1 pruned by keepN=2');

        await context.snapshotStore.delete(persistenceId, 3);
        assert((await context.snapshotStore.loadLatest(persistenceId)).toNullable() === null, 'delete removes snapshots');
      },
    },
    {
      name: 'durable-state — insert / load / update / CAS conflict / re-insert / delete',
      async run(context) {
        const persistenceId = `${context.label}:ds`;
        await context.durableState.delete(persistenceId);   // reset

        const r1 = await context.durableState.upsert(persistenceId, 0, { count: 1 });
        assert(r1.revision === 1, 'insert yields revision 1');

        const loaded = (await context.durableState.load<{ count: number }>(persistenceId)).toNullable();
        assert(loaded?.revision === 1 && loaded.state.count === 1, 'load reflects insert');

        const r2 = await context.durableState.upsert(persistenceId, 1, { count: 2 });
        assert(r2.revision === 2, 'update bumps revision to 2');

        await expectThrows(() => context.durableState.upsert(persistenceId, 1, { count: 9 }), 'DurableStateConcurrencyError', 'stale update');
        await expectThrows(() => context.durableState.upsert(persistenceId, 0, { count: 9 }), 'DurableStateConcurrencyError', 're-insert on existing key');

        await context.durableState.delete(persistenceId);
        assert((await context.durableState.load(persistenceId)).toNullable() === null, 'delete removes the record');
      },
    },
  ];
}
