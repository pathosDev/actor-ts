/**
 * `DurableStateStore` contract scenarios — shared by the in-process suite and
 * the live Docker suites (#390).
 */
import { DurableStateConcurrencyError } from '../../../../../src/persistence/DurableStateStore.js';
import { assert, assertEqual, expectThrows } from './assert.js';
import { closeQuietly, type ContractScenario, type DurableStateHarness } from './types.js';

export function durableStateContractScenarios(): ContractScenario<DurableStateHarness>[] {
  return [
    {
      name: 'insert at revision 0 yields revision 1 and load reflects it',
      async run(harness) {
        const store = await harness.make();
        const persistenceId = harness.pid('insert');
        try {
          const written = await store.upsert(persistenceId, 0, { count: 1 });
          assertEqual(written.revision, 1, 'insert yields revision 1');
          assertEqual(written.persistenceId, persistenceId, 'record echoes the persistence id');
          const loaded = (await store.load<{ count: number }>(persistenceId)).toNullable();
          assertEqual(loaded?.revision, 1, 'load sees revision 1');
          assertEqual(loaded?.state.count, 1, 'load sees the state');
          assert(typeof loaded?.timestamp === 'number', 'timestamp is a number');
        } finally {
          await closeQuietly(store);
        }
      },
    },
    {
      name: 'update with the matching revision bumps it',
      async run(harness) {
        const store = await harness.make();
        const persistenceId = harness.pid('update');
        try {
          await store.upsert(persistenceId, 0, { count: 1 });
          const written = await store.upsert(persistenceId, 1, { count: 2 });
          assertEqual(written.revision, 2, 'update bumps the revision');
          const loaded = (await store.load<{ count: number }>(persistenceId)).toNullable();
          assertEqual(loaded?.revision, 2, 'load sees the bumped revision');
          assertEqual(loaded?.state.count, 2, 'load sees the new state');
        } finally {
          await closeQuietly(store);
        }
      },
    },
    {
      name: 'stale expectedRevision throws DurableStateConcurrencyError with the actual revision',
      async run(harness) {
        const store = await harness.make();
        const persistenceId = harness.pid('stale');
        try {
          await store.upsert(persistenceId, 0, { v: 'a' });   // revision 1
          await store.upsert(persistenceId, 1, { v: 'b' });   // revision 2
          const error = await expectThrows(
            () => store.upsert(persistenceId, 1, { v: 'c' }),
            'DurableStateConcurrencyError',
            'update with a stale expectedRevision',
          ) as DurableStateConcurrencyError;
          assertEqual(error.expected, 1, 'error reports the rejected revision');
          assertEqual(error.actual, 2, 'error reports the stored revision');
          // The rejected write must not have landed.
          assertEqual((await store.load<{ v: string }>(persistenceId)).toNullable()?.state.v, 'b', 'state unchanged');
        } finally {
          await closeQuietly(store);
        }
      },
    },
    {
      name: 're-inserting at revision 0 over an existing record conflicts',
      async run(harness) {
        const store = await harness.make();
        const persistenceId = harness.pid('reinsert');
        try {
          await store.upsert(persistenceId, 0, { v: 'a' });
          const error = await expectThrows(
            () => store.upsert(persistenceId, 0, { v: 'duplicate' }),
            'DurableStateConcurrencyError',
            'insert over an existing record',
          ) as DurableStateConcurrencyError;
          assertEqual(error.actual, 1, 'error reports the stored revision');
          assertEqual((await store.load<{ v: string }>(persistenceId)).toNullable()?.state.v, 'a', 'state unchanged');
        } finally {
          await closeQuietly(store);
        }
      },
    },
    {
      name: 'load is None for an unknown persistence id',
      async run(harness) {
        const store = await harness.make();
        try {
          assert((await store.load(harness.pid('unknown'))).toNullable() === null, 'load is None');
        } finally {
          await closeQuietly(store);
        }
      },
    },
    {
      name: 'delete removes the record, is idempotent, and frees the key for re-insert',
      async run(harness) {
        const store = await harness.make();
        const persistenceId = harness.pid('delete');
        try {
          await store.upsert(persistenceId, 0, { v: 'a' });
          await store.delete(persistenceId);
          assert((await store.load(persistenceId)).toNullable() === null, 'the record is gone');
          await store.delete(persistenceId);   // idempotent
          // The revision counter resets with the record — unlike a journal's
          // high-water mark, durable state has no history to protect.
          const reinserted = await store.upsert(persistenceId, 0, { v: 'b' });
          assertEqual(reinserted.revision, 1, 're-insert starts at revision 1');
        } finally {
          await closeQuietly(store);
        }
      },
    },
    {
      name: 'a negative or non-integer expectedRevision is rejected as an argument error',
      async run(harness) {
        const store = await harness.make();
        const persistenceId = harness.pid('bad-revision');
        try {
          // A bogus revision is a caller bug, not a lost race — reporting it as
          // a concurrency conflict would send the caller into a retry loop.
          await expectThrows(() => store.upsert(persistenceId, -1, { v: 'x' }), 'JournalError', 'negative revision');
          await expectThrows(() => store.upsert(persistenceId, 1.5, { v: 'x' }), 'JournalError', 'fractional revision');
          assert((await store.load(persistenceId)).toNullable() === null, 'nothing was written');
        } finally {
          await closeQuietly(store);
        }
      },
    },
  ];
}
