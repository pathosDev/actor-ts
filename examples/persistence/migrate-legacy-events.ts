/**
 * One-shot migration script for repos adopting schema-evolution
 * after-the-fact (#9).
 *
 *   bun run examples/persistence/migrate-legacy-events.ts
 *
 * The shape:
 *
 *   1. Open the journal you want to migrate (here: in-memory; in
 *      production: SQLite, Cassandra, S3, …).
 *   2. Define a `manifestFor(event)` that derives a stable type id
 *      from the legacy raw event.
 *   3. Bulk-wrap every event with `migrateInMemoryJournal` (or the
 *      backend-specific equivalent — for SQL/CQL it's a one-row-at-a-
 *      time UPDATE using the `wrapEventAsEnvelope` primitive).
 *   4. Optionally migrate the snapshot store too.
 *   5. Run the script ONCE before deploying the version of your code
 *      that ships an `EventAdapter`.  Subsequent re-runs are no-ops
 *      (`wrapped: 0`).
 *
 * After the migration completes, your actor with `eventAdapter()` set
 * can replay the journal without `MigrationError`s about missing
 * envelopes.
 */
import { InMemoryJournal } from '../../src/persistence/journals/InMemoryJournal.js';
import { InMemorySnapshotStore } from '../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import {
  formatMigrationResult,
  migrateInMemoryJournal,
  migrateSnapshotStore,
} from '../../src/persistence/migration/wrapLegacy.js';

interface LegacyDeposited { kind: 'deposited'; amount: number }
interface LegacyWithdrawn { kind: 'withdrawn'; amount: number }
type LegacyEvent = LegacyDeposited | LegacyWithdrawn;

interface LegacyState { balance: number }

async function main(): Promise<void> {
  // === Setup: simulate an existing journal + snapshot store with raw events. ===
  const journal = new InMemoryJournal();
  const snapshots = new InMemorySnapshotStore();

  await journal.append<LegacyEvent>('account-alice', [
    { kind: 'deposited', amount: 100 },
    { kind: 'deposited', amount: 50 },
    { kind: 'withdrawn', amount: 30 },
  ], 0);
  await journal.append<LegacyEvent>('account-bob', [
    { kind: 'deposited', amount: 200 },
  ], 0);
  await snapshots.save<LegacyState>('account-alice', 3, { balance: 120 });
  await snapshots.save<LegacyState>('account-bob', 1, { balance: 200 });

  // === Migration: wrap every entry in a v1 envelope. ===
  const eventResult = await migrateInMemoryJournal<LegacyEvent>(journal, (e) =>
    `BankAccount.${e.kind === 'deposited' ? 'Deposited' : 'Withdrawn'}`);
  console.log(formatMigrationResult('events   ', eventResult));

  const pids = await journal.persistenceIds();
  const stateResult = await migrateSnapshotStore<LegacyState>(snapshots, pids,
    (_state) => 'BankAccount.State');
  console.log(formatMigrationResult('snapshots', stateResult));

  // === Verify: re-running is a no-op. ===
  const second = await migrateInMemoryJournal<LegacyEvent>(journal, (e) =>
    `BankAccount.${e.kind === 'deposited' ? 'Deposited' : 'Withdrawn'}`);
  console.log(formatMigrationResult('re-run   ', second));
}

void main();
