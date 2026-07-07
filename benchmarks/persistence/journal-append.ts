/**
 * Journal append throughput — InMemory vs. SQLite (memory & file).  Each
 * op = one `append(pid, [event], expectedSeq)` call.
 *
 *   bun run benchmarks/persistence/journal-append.ts
 */
import {
  InMemoryJournal,
  SqliteJournal,
  SqliteJournalOptions,
  type Journal,
} from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

async function main(): Promise<void> {
  const inMem = new InMemoryJournal();
  const sqliteMemOptions = SqliteJournalOptions.create()
    .withPath(':memory:');
  const sqliteMem = new SqliteJournal(sqliteMemOptions);
  const tmpFile = `./.bench-journal-${Date.now()}.sqlite`;
  const sqliteFileOptions = SqliteJournalOptions.create()
    .withPath(tmpFile);
  const sqliteFile = new SqliteJournal(sqliteFileOptions);

  const appendOne = (j: Journal, pid: string, seq: { n: number }) => async (): Promise<void> => {
    await j.append(pid, [{ body: 'x'.repeat(32) }], seq.n);
    seq.n++;
  };

  const inMemSeq = { n: 0 };
  const sqliteMemSeq = { n: 0 };
  const sqliteFileSeq = { n: 0 };

  await runGroup('persistence · journal append (per-event)', [
    { name: 'InMemoryJournal',      unit: 'event', iterations: 5_000, run: appendOne(inMem,       'im', inMemSeq) },
    { name: 'SqliteJournal (mem)',  unit: 'event', iterations: 5_000, run: appendOne(sqliteMem,   'sm', sqliteMemSeq) },
    { name: 'SqliteJournal (file)', unit: 'event', iterations: 2_000, run: appendOne(sqliteFile,  'sf', sqliteFileSeq) },
  ]);

  // Batch-test persistence IDs are fresh streams — each needs its own
  // sequence counter starting at 0 (the per-event counters above are already
  // deep in the thousands against the "im"/"sm" streams).
  const inMemBatchSeq = { n: 0 };
  const sqliteMemBatchSeq = { n: 0 };

  await runGroup('persistence · journal append (batch of 10)', [
    {
      name: 'InMemoryJournal batch',
      unit: 'event',
      iterations: 1_000, opsPerIteration: 10,
      run: async () => {
        const batch = Array.from({ length: 10 }, () => ({ body: 'x'.repeat(32) }));
        await inMem.append('im2', batch, inMemBatchSeq.n);
        inMemBatchSeq.n += 10;
      },
    },
    {
      name: 'SqliteJournal batch (mem)',
      unit: 'event',
      iterations: 1_000, opsPerIteration: 10,
      run: async () => {
        const batch = Array.from({ length: 10 }, () => ({ body: 'x'.repeat(32) }));
        await sqliteMem.append('sm2', batch, sqliteMemBatchSeq.n);
        sqliteMemBatchSeq.n += 10;
      },
    },
  ]);

  await inMem.close?.();
  await sqliteMem.close?.();
  await sqliteFile.close?.();
  try { await Bun.file(tmpFile).exists() && await Bun.$`rm -f ${tmpFile}`; } catch { /* ignore */ }
}

void main();
