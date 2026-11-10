/**
 * `DurableStateStore` contract scenarios — shared by the in-process suite and
 * the live Docker suites (#390).
 */
import { DurableStateConcurrencyError } from '../../../../../src/persistence/DurableStateStore.js';
import type { PersistenceOptions } from '../../../../../src/persistence/PersistenceOptions.js';
import { assert, assertEqual, expectThrows } from './Assert.js';
import { closeQuietly, type ContractScenario, type DurableStateHarness } from './Types.js';

/** Fixture master key for the capability-conformance scenario — 32 bytes (#960). */
const CAPABILITY_MASTER_KEY = new Uint8Array(32).fill(0x2f);

/** HKDF context string; required on every client-side encryption config (#108). */
const CAPABILITY_HKDF_INFO = 'actor-ts/contract/durable-state/v1';

const capabilityProbeOptions: PersistenceOptions = {
  encryption: {
    mode: 'client-aes256-gcm',
    masterKey: CAPABILITY_MASTER_KEY,
    info: CAPABILITY_HKDF_INFO,
  },
};

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
      name: 'rich state types survive the store round-trip',
      async run(harness) {
        const store = await harness.make();
        const persistenceId = harness.pid('rich-types');
        // Companion to the journal/snapshot rich-type scenarios (#888).
        type RichState = {
          updatedAt: Date;
          members: Set<string>;
          counters: Map<string, bigint>;
          digest: Uint8Array;
          missing: number;
          histogram: Int32Array;
        };
        try {
          await store.upsert<RichState>(persistenceId, 0, {
            updatedAt: new Date('2024-06-01T12:00:00.000Z'),
            members: new Set(['a', 'b']),
            counters: new Map([['hits', 42n]]),
            digest: new Uint8Array([3, 1, 4]),
            missing: NaN,
            histogram: new Int32Array([7, -8]),
          });
          const loaded = (await store.load<RichState>(persistenceId)).toNullable();
          assert(loaded !== null, 'record is readable');
          assert(loaded.state.updatedAt instanceof Date, 'Date survives as a Date instance');
          assertEqual(loaded.state.updatedAt.toISOString(), '2024-06-01T12:00:00.000Z', 'Date value is preserved');
          assert(loaded.state.members instanceof Set, 'Set survives as a Set instance');
          assertEqual(Array.from(loaded.state.members).sort(), ['a', 'b'], 'Set members are preserved');
          assert(loaded.state.counters instanceof Map, 'Map survives as a Map instance');
          assert(loaded.state.counters.get('hits') === 42n, 'bigint Map value is preserved');
          assert(loaded.state.digest instanceof Uint8Array, 'Uint8Array survives as bytes');
          assertEqual(Array.from(loaded.state.digest), [3, 1, 4], 'byte values are preserved');
          assert(Number.isNaN(loaded.state.missing), 'NaN survives instead of becoming null (#889)');
          assert(loaded.state.histogram instanceof Int32Array, 'typed arrays survive as instances');
          assertEqual(Array.from(loaded.state.histogram), [7, -8], 'typed-array values are preserved');
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
      /**
       * Twin of the snapshot family's capability-conformance scenario — see
       * the commentary there for why the probe reads back keyless (#960).
       * It matters more on this contract, because `DurableStateActor`
       * *reads* in `preStart` before it ever writes: a declaration that lied
       * about encryption here would hand the actor a plaintext record it
       * believes was ciphertext, with no write involved at all.
       */
      name: 'the persistenceOptionSupport declaration matches what encryption does',
      async run(harness) {
        const store = await harness.make();
        const persistenceId = harness.pid('option-support');
        type Probe = { readonly secret: string };
        try {
          // Sniffed here, not in `skip`, which runs before `make()`.
          const support = store.persistenceOptionSupport;
          if (support === undefined) return;
          await store.upsert<Probe>(persistenceId, 0, { secret: 'probe' }, capabilityProbeOptions);
          let plain: Probe | null | 'unreadable';
          try {
            plain = (await store.load<Probe>(persistenceId)).toNullable()?.state ?? null;
          } catch {
            plain = 'unreadable';
          }
          if (support.encryption) {
            assert(
              plain === 'unreadable' || plain?.secret !== 'probe',
              'a store declaring encryption support must not yield the plaintext to a keyless read',
            );
            const keyed = (await store.load<Probe>(persistenceId, capabilityProbeOptions)).toNullable();
            assertEqual(keyed?.state.secret, 'probe', 'the keyed read recovers the state');
          } else {
            assertEqual(
              plain, { secret: 'probe' },
              'a store declaring no encryption support must have stored the state unchanged — '
              + 'if this read failed, the store acts on options it declares it ignores',
            );
          }
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
