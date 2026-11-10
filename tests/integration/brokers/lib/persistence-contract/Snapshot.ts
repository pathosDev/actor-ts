/**
 * `SnapshotStore` contract scenarios — shared by the in-process suite and
 * the live Docker suites (#390).
 */
import type { PersistenceOptions } from '../../../../../src/persistence/PersistenceOptions.js';
import { assert, assertEqual } from './Assert.js';
import { closeQuietly, type ContractScenario, type SnapshotHarness } from './Types.js';

function keepNSkip(harness: SnapshotHarness): string | null {
  return harness.capabilities?.keepN === 'none' ? 'store keeps every snapshot (no keepN)' : null;
}

/** Fixture master key for the capability-conformance scenario — 32 bytes (#960). */
const CAPABILITY_MASTER_KEY = new Uint8Array(32).fill(0x2f);

/** HKDF context string; required on every client-side encryption config (#108). */
const CAPABILITY_HKDF_INFO = 'actor-ts/contract/snapshot/v1';

const capabilityProbeOptions: PersistenceOptions = {
  encryption: {
    mode: 'client-aes256-gcm',
    masterKey: CAPABILITY_MASTER_KEY,
    info: CAPABILITY_HKDF_INFO,
  },
};

export function snapshotContractScenarios(): ContractScenario<SnapshotHarness>[] {
  return [
    {
      name: 'save returns the snapshot and loadLatest reads back the newest',
      async run(harness) {
        const store = await harness.make();
        const persistenceId = harness.pid('latest');
        try {
          const saved = await store.save(persistenceId, 5, { balance: 10 });
          assertEqual(saved.sequenceNr, 5, 'save echoes the sequence number');
          assertEqual(saved.persistenceId, persistenceId, 'save echoes the persistence id');
          assertEqual(saved.state, { balance: 10 }, 'save echoes the state');

          await store.save(persistenceId, 9, { balance: 42 });
          const latest = (await store.loadLatest<{ balance: number }>(persistenceId)).toNullable();
          assertEqual(latest?.sequenceNr, 9, 'loadLatest is the highest seq');
          assertEqual(latest?.state.balance, 42, 'loadLatest carries the newest state');
          assert(typeof latest?.timestamp === 'number', 'timestamp is a number');
        } finally {
          await closeQuietly(store);
        }
      },
    },
    {
      name: 'saving twice at the same sequence number overwrites in place',
      async run(harness) {
        const store = await harness.make();
        const persistenceId = harness.pid('upsert');
        try {
          await store.save(persistenceId, 5, { v: 'first' });
          await store.save(persistenceId, 5, { v: 'second' });
          const latest = (await store.loadLatest<{ v: string }>(persistenceId)).toNullable();
          assertEqual(latest?.sequenceNr, 5, 'sequence number is unchanged');
          assertEqual(latest?.state.v, 'second', 'the newer state wins');
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
        // Companion to the journal's rich-type scenario (#888): snapshots take
        // a different write path in every backend, so they need their own proof.
        type RichState = {
          updatedAt: Date;
          members: Set<string>;
          counters: Map<string, bigint>;
          digest: Uint8Array;
          ratio: number;
          pattern: RegExp;
        };
        try {
          await store.save<RichState>(persistenceId, 4, {
            updatedAt: new Date('2024-06-01T12:00:00.000Z'),
            members: new Set(['a', 'b']),
            counters: new Map([['hits', 42n]]),
            digest: new Uint8Array([9, 0, 255]),
            ratio: Infinity,
            pattern: /^v\d+$/,
          });
          const latest = (await store.loadLatest<RichState>(persistenceId)).toNullable();
          assert(latest !== null, 'snapshot is readable');
          assert(latest.state.updatedAt instanceof Date, 'Date survives as a Date instance');
          assertEqual(latest.state.updatedAt.toISOString(), '2024-06-01T12:00:00.000Z', 'Date value is preserved');
          assert(latest.state.members instanceof Set, 'Set survives as a Set instance');
          assertEqual(Array.from(latest.state.members).sort(), ['a', 'b'], 'Set members are preserved');
          assert(latest.state.counters instanceof Map, 'Map survives as a Map instance');
          assert(latest.state.counters.get('hits') === 42n, 'bigint Map value is preserved');
          assert(latest.state.digest instanceof Uint8Array, 'Uint8Array survives as bytes');
          assertEqual(Array.from(latest.state.digest), [9, 0, 255], 'byte values are preserved');
          assert(latest.state.ratio === Infinity, 'Infinity survives instead of becoming null (#889)');
          assert(latest.state.pattern instanceof RegExp, 'RegExp survives as a RegExp instance');
          assert(latest.state.pattern.test('v3'), 'RegExp source is preserved');
        } finally {
          await closeQuietly(store);
        }
      },
    },
    {
      name: 'loadBefore returns the newest snapshot strictly below seq',
      async run(harness) {
        const store = await harness.make();
        const persistenceId = harness.pid('before');
        try {
          await store.save(persistenceId, 3, { v: 'a' });
          await store.save(persistenceId, 7, { v: 'b' });
          const before = (await store.loadBefore<{ v: string }>(persistenceId, 7)).toNullable();
          assertEqual(before?.sequenceNr, 3, 'the bound is exclusive');
          assert((await store.loadBefore(persistenceId, 3)).toNullable() === null, 'nothing below the oldest snapshot');
        } finally {
          await closeQuietly(store);
        }
      },
    },
    {
      name: 'loadLatest and loadBefore are None for an unknown persistence id',
      async run(harness) {
        const store = await harness.make();
        const persistenceId = harness.pid('unknown');
        try {
          assert((await store.loadLatest(persistenceId)).toNullable() === null, 'loadLatest is None');
          assert((await store.loadBefore(persistenceId, 10)).toNullable() === null, 'loadBefore is None');
        } finally {
          await closeQuietly(store);
        }
      },
    },
    {
      name: 'delete removes snapshots up to and including toSeq',
      async run(harness) {
        const store = await harness.make();
        const persistenceId = harness.pid('delete');
        try {
          await store.save(persistenceId, 1, { v: 1 });
          await store.save(persistenceId, 2, { v: 2 });
          await store.delete(persistenceId, 1);
          assertEqual(
            (await store.loadLatest<{ v: number }>(persistenceId)).toNullable()?.sequenceNr, 2,
            'the newer snapshot survives',
          );
          await store.delete(persistenceId, 2);
          assert((await store.loadLatest(persistenceId)).toNullable() === null, 'the inclusive bound removes seq 2');
          await store.delete(persistenceId, 2);   // idempotent
        } finally {
          await closeQuietly(store);
        }
      },
    },
    {
      name: 'keepN prunes the oldest snapshots on save',
      skip: keepNSkip,
      async run(harness) {
        const store = await harness.make(2);
        const persistenceId = harness.pid('keepn');
        try {
          for (const seq of [1, 2, 3, 4]) await store.save(persistenceId, seq, { seq });
          assertEqual(
            (await store.loadLatest<{ seq: number }>(persistenceId)).toNullable()?.sequenceNr, 4,
            'the newest snapshot is kept',
          );
          assertEqual(
            (await store.loadBefore<{ seq: number }>(persistenceId, 4)).toNullable()?.sequenceNr, 3,
            'keepN=2 keeps the runner-up',
          );
          assert((await store.loadBefore(persistenceId, 3)).toNullable() === null, 'older snapshots are pruned');
        } finally {
          await closeQuietly(store);
        }
      },
    },
    {
      name: 'keepN of 0 disables pruning',
      skip: keepNSkip,
      async run(harness) {
        const store = await harness.make(0);
        const persistenceId = harness.pid('keepn-zero');
        try {
          for (const seq of [1, 2, 3, 4]) await store.save(persistenceId, seq, { seq });
          // keepN <= 0 means "keep everything" — the oldest snapshot is still
          // readable.  Guards against an off-by-one that would prune all rows.
          assertEqual(
            (await store.loadBefore<{ seq: number }>(persistenceId, 2)).toNullable()?.sequenceNr, 1,
            'the oldest snapshot survives',
          );
          assertEqual(
            (await store.loadLatest<{ seq: number }>(persistenceId)).toNullable()?.sequenceNr, 4,
            'the newest snapshot is still the newest',
          );
        } finally {
          await closeQuietly(store);
        }
      },
    },
    {
      /**
       * Retention is housekeeping; the write is the contract.  A store that
       * prunes inside the save's error handling reports a snapshot that is
       * already durable as a failed save, so the caller retries a write that
       * succeeded — and an actor treating a snapshot failure as fatal dies
       * over a delete.  Object storage has always got this right; this
       * scenario is what holds the rest of the family to it (#393).
       */
      name: 'a failing prune does not fail the save',
      skip: (harness) =>
        harness.capabilities?.pruneFailure === 'injectable'
          ? null
          : 'no prune-failure injection seam for this store',
      async run(harness) {
        const store = await harness.makeWithFailingPrune!(1);
        const persistenceId = harness.pid('prune-failure');
        try {
          // keepN = 1, so the second save has something to prune — and the
          // prune is rigged to throw.  Neither save may reject.
          await store.save(persistenceId, 1, { seq: 1 });
          const saved = await store.save(persistenceId, 2, { seq: 2 });
          assertEqual(saved.sequenceNr, 2, 'save resolves even though the prune threw');

          const latest = (await store.loadLatest<{ seq: number }>(persistenceId)).toNullable();
          assertEqual(latest?.sequenceNr, 2, 'the snapshot really is durable');
          assertEqual(latest?.state.seq, 2, 'and carries the state that was written');
        } finally {
          await closeQuietly(store);
        }
      },
    },
    {
      /**
       * The `persistenceOptionSupport` declaration is what the framework
       * refuses an actor on (#960), so it has to be measured against
       * behaviour rather than trusted — a declaration nothing checks is the
       * same silent-rot channel the JSDoc it replaces was.
       *
       * The probe is one write with a real client-side encryption directive,
       * read back **without** any options, which separates the two claims
       * cleanly:
       *
       *   - `encryption: false` says the directive is inert.  A plain read
       *     must therefore return the state verbatim — a store that secretly
       *     encrypted would hand back ciphertext or throw here.
       *   - `encryption: true` says the directive took effect.  The plain
       *     read must then FAIL, and only a read carrying the same key may
       *     succeed — which is what makes `true` unfakeable by a store that
       *     accepted the option and wrote plaintext anyway.
       *
       * Sniffed inside `run` and not in `skip`, which executes before
       * `make()` and so has no store to ask.  An undeclared store is
       * "unknown" and asserts nothing, exactly as the actor-side check
       * treats it.
       */
      name: 'the persistenceOptionSupport declaration matches what encryption does',
      async run(harness) {
        const store = await harness.make();
        const persistenceId = harness.pid('option-support');
        type Probe = { readonly secret: string };
        try {
          const support = store.persistenceOptionSupport;
          if (support === undefined) return;
          await store.save<Probe>(persistenceId, 1, { secret: 'probe' }, capabilityProbeOptions);
          let plain: Probe | null | 'unreadable';
          try {
            plain = (await store.loadLatest<Probe>(persistenceId)).toNullable()?.state ?? null;
          } catch {
            plain = 'unreadable';
          }
          if (support.encryption) {
            assert(
              plain === 'unreadable' || plain?.secret !== 'probe',
              'a store declaring encryption support must not yield the plaintext to a keyless read',
            );
            const keyed = (await store.loadLatest<Probe>(persistenceId, capabilityProbeOptions)).toNullable();
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
      name: 'close is idempotent',
      async run(harness) {
        const store = await harness.make();
        await store.save(harness.pid('close'), 1, { v: 1 });
        await closeQuietly(store);
        await closeQuietly(store);
      },
    },
  ];
}
