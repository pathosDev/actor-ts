import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PostgresJournal,
  PostgresJournalOptions,
  SqliteJournal,
  SqliteJournalOptions,
  SqliteSnapshotStore,
  SqliteSnapshotStoreOptions,
} from '../../../../src/persistence/index.js';
import { offsetStart } from '../../../../src/persistence/query/PersistenceQuery.js';
import { SqliteQuery } from '../../../../src/persistence/query/SqliteQuery.js';
import type { Serializer } from '../../../../src/serialization/Serializer.js';
import { FakePgPool } from './FakePgPool.js';

/**
 * The per-store `serializer` option (#888, the persistence half of #450):
 * a configured `Serializer` frames rows self-describingly, which buys what
 * the default tagged-JSON codec cannot — class identity across the store
 * boundary.  The Money fixture proves it: the default codec would return a
 * plain object, the custom serializer returns a working instance.
 */

class Money {
  constructor(readonly currency: string, readonly cents: number) {}
  formatted(): string { return `${this.currency} ${(this.cents / 100).toFixed(2)}`; }
}

const moneySerializer: Serializer = {
  id: 142,
  name: 'money-json',
  includesManifest: true,
  manifest: (obj) => (obj instanceof Money ? 'Money' : ''),
  toBinary: (obj) => new TextEncoder().encode(JSON.stringify(obj)),
  fromBinary: (bytes, manifest) => {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (manifest === 'Money') return new Money(parsed['currency'] as string, parsed['cents'] as number);
    return parsed;
  },
};

const tempDirectory = mkdtempSync(join(tmpdir(), 'actor-ts-serializer-option-'));
afterAll(() => {
  // Best-effort: on Windows the SQLite driver can release its file handle a
  // beat after close(), and a locked file must not fail the suite.
  try { rmSync(tempDirectory, { recursive: true, force: true }); } catch { /* leave the temp dir to the OS */ }
});

describe('per-store serializer option (#888)', () => {
  test('SqliteJournal round-trips class instances through a custom serializer', async () => {
    const journalOptions = SqliteJournalOptions.create()
      .withPath(':memory:')
      .withSerializer(moneySerializer);
    const journal = new SqliteJournal(journalOptions);
    try {
      await journal.append('wallet-1', [{ event: new Money('EUR', 1550) }], 0);
      const [entry] = await journal.read<Money>('wallet-1', 1);
      expect(entry!.event).toBeInstanceOf(Money);
      expect(entry!.event.formatted()).toBe('EUR 15.50');
    } finally {
      await journal.close();
    }
  });

  test('SqliteSnapshotStore honours the serializer for state', async () => {
    const storeOptions = SqliteSnapshotStoreOptions.create()
      .withPath(':memory:')
      .withSerializer(moneySerializer);
    const store = new SqliteSnapshotStore(storeOptions);
    try {
      await store.save('wallet-2', 3, new Money('USD', 99));
      const latest = (await store.loadLatest<Money>('wallet-2')).toNullable();
      expect(latest?.state).toBeInstanceOf(Money);
      expect(latest?.state.formatted()).toBe('USD 0.99');
    } finally {
      await store.close();
    }
  });

  test('SqliteQuery decodes tag reads with the journal serializer', async () => {
    const journalOptions = SqliteJournalOptions.create()
      .withPath(':memory:')
      .withSerializer(moneySerializer);
    const journal = new SqliteJournal(journalOptions);
    try {
      await journal.append('wallet-3', [{ event: new Money('CHF', 500), tags: ['payments'] }], 0);
      const query = new SqliteQuery(journal);
      const tagged = await query.currentEventsByTag<Money>('payments', offsetStart);
      expect(tagged.length).toBe(1);
      // A TaggedEvent wraps the PersistentEvent — the payload sits one level in.
      expect(tagged[0]!.event.event).toBeInstanceOf(Money);
    } finally {
      await journal.close();
    }
  });

  test('mixed history: legacy default rows stay readable after configuring a serializer', async () => {
    const path = join(tempDirectory, 'mixed-history.db');

    const legacyOptions = SqliteJournalOptions.create().withPath(path);
    const legacyJournal = new SqliteJournal(legacyOptions);
    await legacyJournal.append('wallet-4', [{ event: { kind: 'opened', roles: new Set(['owner']) } }], 0);
    await legacyJournal.close();

    const framedOptions = SqliteJournalOptions.create()
      .withPath(path)
      .withSerializer(moneySerializer);
    const framedJournal = new SqliteJournal(framedOptions);
    try {
      await framedJournal.append('wallet-4', [{ event: new Money('EUR', 100) }], 1);
      const events = await framedJournal.read<unknown>('wallet-4', 1);
      // Row 1 was written by the default codec; row 2 carries the frame —
      // decode dispatches per row, so both come back intact.
      const legacy = events[0]!.event as { kind: string; roles: Set<string> };
      expect(legacy.kind).toBe('opened');
      expect(legacy.roles).toBeInstanceOf(Set);
      expect(events[1]!.event).toBeInstanceOf(Money);
    } finally {
      await framedJournal.close();
    }
  });

  test('a framed row fails loudly when read without the serializer', async () => {
    const path = join(tempDirectory, 'missing-serializer.db');

    const framedOptions = SqliteJournalOptions.create()
      .withPath(path)
      .withSerializer(moneySerializer);
    const framedJournal = new SqliteJournal(framedOptions);
    await framedJournal.append('wallet-5', [{ event: new Money('EUR', 1) }], 0);
    await framedJournal.close();

    const plainOptions = SqliteJournalOptions.create().withPath(path);
    const plainJournal = new SqliteJournal(plainOptions);
    try {
      await expect(plainJournal.read('wallet-5', 1)).rejects.toThrow(/no serializer is configured/);
    } finally {
      await plainJournal.close();
    }
  });

  test('the RelationalJournal base threads the serializer (Postgres via fake pool)', async () => {
    const journalOptions = PostgresJournalOptions.create()
      .withPool(new FakePgPool())
      .withSerializer(moneySerializer);
    const journal = new PostgresJournal(journalOptions);
    try {
      await journal.append('wallet-6', [{ event: new Money('GBP', 250) }], 0);
      const [entry] = await journal.read<Money>('wallet-6', 1);
      expect(entry!.event).toBeInstanceOf(Money);
      expect(entry!.event.formatted()).toBe('GBP 2.50');
    } finally {
      await journal.close();
    }
  });
});
