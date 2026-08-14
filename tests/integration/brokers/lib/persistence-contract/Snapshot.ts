/**
 * `SnapshotStore` contract scenarios — shared by the in-process suite and
 * the live Docker suites (#390).
 */
import { assert, assertEqual } from './Assert.js';
import { closeQuietly, type ContractScenario, type SnapshotHarness } from './Types.js';

function keepNSkip(harness: SnapshotHarness): string | null {
  return harness.capabilities?.keepN === 'none' ? 'store keeps every snapshot (no keepN)' : null;
}

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
