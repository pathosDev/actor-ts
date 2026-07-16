/**
 * Shared live-DB persistence contract — exercised by both the Postgres
 * and MariaDB suites against a REAL database container.  The behaviour
 * under test is identical (same `Journal` / `SnapshotStore` /
 * `DurableStateStore` contract); only construction differs, so each
 * runner builds the concrete backends, drops them into the ctx, and runs
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

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
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
      async run(ctx) {
        const pid = `${ctx.label}:journal`;
        await ctx.journal.delete(pid, MAX_SEQ);   // reset for idempotent re-runs

        const written = await ctx.journal.append(pid, ['e1', 'e2', 'e3'], 0, ['tagA', 'tagB']);
        assert(written.map((e) => e.sequenceNr).join(',') === '1,2,3', 'monotonic seq 1,2,3');

        const all = await ctx.journal.read<string>(pid, 1);
        assert(all.length === 3, `read 3, got ${all.length}`);
        assert(all[0]!.event === 'e1', 'payload round-trip');
        assert(typeof all[0]!.sequenceNr === 'number', 'sequenceNr coerced to number');
        assert(JSON.stringify(all[0]!.tags) === JSON.stringify(['tagA', 'tagB']), 'tags round-trip');

        assert(await ctx.journal.highestSeq(pid) === 3, 'highestSeq is 3');

        const ranged = await ctx.journal.read(pid, 2, 2);
        assert(ranged.length === 1 && ranged[0]!.sequenceNr === 2, 'inclusive range read');

        await expectThrows(() => ctx.journal.append(pid, ['x'], 0), 'JournalConcurrencyError', 'stale append');

        const more = await ctx.journal.append(pid, ['e4'], 3);
        assert(more[0]!.sequenceNr === 4, 'append resumes after correct expectedSeq');

        await ctx.journal.delete(pid, 2);
        const afterDelete = await ctx.journal.read(pid, 1);
        assert(afterDelete.map((e) => e.sequenceNr).join(',') === '3,4', 'delete compacts up to toSeq');

        assert((await ctx.journal.persistenceIds()).includes(pid), 'persistenceIds includes our pid');
      },
    },
    {
      name: 'snapshot — save / loadLatest / loadBefore / keepN prune / delete',
      async run(ctx) {
        const pid = `${ctx.label}:snap`;
        await ctx.snapshotStore.delete(pid, MAX_SEQ);   // reset

        await ctx.snapshotStore.save(pid, 1, { v: 1 });
        await ctx.snapshotStore.save(pid, 2, { v: 2 });
        await ctx.snapshotStore.save(pid, 3, { v: 3 });   // keepN=2 → seq 1 pruned

        const latest = (await ctx.snapshotStore.loadLatest<{ v: number }>(pid)).toNullable();
        assert(latest?.sequenceNr === 3 && latest.state.v === 3, 'loadLatest is seq 3');

        const before = (await ctx.snapshotStore.loadBefore<{ v: number }>(pid, 3)).toNullable();
        assert(before?.sequenceNr === 2, 'loadBefore(3) is seq 2');

        const pruned = (await ctx.snapshotStore.loadBefore(pid, 2)).toNullable();
        assert(pruned === null, 'seq 1 pruned by keepN=2');

        await ctx.snapshotStore.delete(pid, 3);
        assert((await ctx.snapshotStore.loadLatest(pid)).toNullable() === null, 'delete removes snapshots');
      },
    },
    {
      name: 'durable-state — insert / load / update / CAS conflict / re-insert / delete',
      async run(ctx) {
        const pid = `${ctx.label}:ds`;
        await ctx.durableState.delete(pid);   // reset

        const r1 = await ctx.durableState.upsert(pid, 0, { count: 1 });
        assert(r1.revision === 1, 'insert yields revision 1');

        const loaded = (await ctx.durableState.load<{ count: number }>(pid)).toNullable();
        assert(loaded?.revision === 1 && loaded.state.count === 1, 'load reflects insert');

        const r2 = await ctx.durableState.upsert(pid, 1, { count: 2 });
        assert(r2.revision === 2, 'update bumps revision to 2');

        await expectThrows(() => ctx.durableState.upsert(pid, 1, { count: 9 }), 'DurableStateConcurrencyError', 'stale update');
        await expectThrows(() => ctx.durableState.upsert(pid, 0, { count: 9 }), 'DurableStateConcurrencyError', 're-insert on existing key');

        await ctx.durableState.delete(pid);
        assert((await ctx.durableState.load(pid)).toNullable() === null, 'delete removes the record');
      },
    },
  ];
}
