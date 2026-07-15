import type { Journal } from '../Journal.js';
import {
  JournalConcurrencyError,
  JournalError,
  type PersistentEvent,
} from '../JournalTypes.js';
import {
  createCassandraClient,
  keyspaceDdl,
  type CassandraClientLike,
  type CassandraConnection,
} from './CassandraClient.js';
import { CassandraJournalOptionsValidator } from './CassandraJournalOptions.js';
import { assertSafeIdentifier } from '../storage/SqlIdentifier.js';
import type { CassandraJournalOptions, CassandraJournalOptionsType } from './CassandraJournalOptions.js';

interface EventRow {
  persistence_id: string;
  partition_nr: string | number; // bigint comes back as driver type
  sequence_nr: string | number;
  timestamp: string | number;
  payload: string;
  tags: string[] | null;
}

/**
 * Journal backed by Apache Cassandra or ScyllaDB — same CQL protocol, one
 * plug-in serves both.  Schema:
 *   - composite partition key `(persistence_id, partition_nr)` — keeps
 *     individual partitions bounded even for long-lived event streams;
 *   - clustering column `sequence_nr` for in-stream ordering;
 *   - a small metadata row per persistence_id tracking `max_sequence_nr`.
 *
 * The journal relies on a *single writer per persistence id* — the
 * standard PersistentActor contract, one instance per id at a time.
 * Under that assumption the "read max-seq → append → write max-seq"
 * sequence is safe without server-side LWT.  If you need multi-writer
 * safety, wrap the metadata update in an LWT (`IF max_sequence_nr = ?`).
 */
export class CassandraJournal implements Journal {
  private readonly options: Partial<CassandraJournalOptionsType>;
  private client: CassandraClientLike;
  /** True once `ensureStarted()` has run keyspace + table DDL. */
  private started = false;
  /** Toggle so shutdown only happens once. */
  private stopped = false;
  /** Only shut down the client if WE created it — don't close someone else's. */
  private ownsClient: boolean;

  constructor(options: CassandraJournalOptions) {
    this.options = (options as CassandraJournalOptionsType);
    new CassandraJournalOptionsValidator().validate(this.options);
    this.client = this.options.client ?? (undefined as unknown as CassandraClientLike);
    this.ownsClient = !this.options.client;
  }

  /** Explicitly connect + ensure schema.  Called lazily on first use. */
  async start(): Promise<void> {
    if (this.started) return;
    if (this.ownsClient && !this.client) {
      this.client = await createCassandraClient(this.options as CassandraConnection);
    }
    await this.client.connect();
    if (this.options.autoCreateKeyspace) {
      await this.client.execute(keyspaceDdl(this.options as CassandraConnection));
    }
    if (this.options.autoCreateTables ?? true) {
      await this.ensureTables();
    }
    this.started = true;
  }

  async append<E>(
    pid: string,
    events: ReadonlyArray<E>,
    expectedSeq: number,
    tags?: ReadonlyArray<string>,
  ): Promise<PersistentEvent<E>[]> {
    if (events.length === 0) return [];
    await this.ensureStarted();

    // 1) Read current max-seq from metadata; throw on mismatch.
    const actualSeq = await this.readHighestSeq(pid);
    if (actualSeq !== expectedSeq) {
      throw new JournalConcurrencyError(pid, expectedSeq, actualSeq);
    }

    const now = Date.now();
    const partitionSize = this.options.partitionSize ?? 500_000;
    const tagList = tags ? Array.from(tags) : null;
    const written: PersistentEvent<E>[] = [];

    // 2) Batch INSERT events.  We use a logged batch only if every insert
    //    lands in the same partition — otherwise Cassandra logs a warning.
    //    To keep it simple we build one batch per partition.
    let batchPartition: number | null = null;
    let batchOps: Array<{ query: string; params: ReadonlyArray<unknown> }> = [];
    const flush = async (): Promise<void> => {
      if (batchOps.length === 0) return;
      try {
        await this.client.batch(batchOps, { prepare: true, logged: false });
      } catch (e) {
        throw new JournalError(`CassandraJournal.append: batch failed: ${(e as Error).message}`, e);
      }
      batchOps = [];
      batchPartition = null;
    };

    let seq = actualSeq;
    for (const ev of events) {
      seq++;
      const partition = Math.floor((seq - 1) / partitionSize);
      if (batchPartition !== null && partition !== batchPartition) await flush();
      batchPartition = partition;
      const payload = JSON.stringify(ev);
      batchOps.push({
        query:
          `INSERT INTO ${this.qualified(this.eventsTable)} (persistence_id, partition_nr, sequence_nr, timestamp, payload, tags) VALUES (?, ?, ?, ?, ?, ?)`,
        params: [pid, partition, seq, now, payload, tagList],
      });
      // Tag-index side-table dual-write (#44).  One row per (event, tag)
      // pair so a tag-query walks a single (tag) partition.  Each row
      // also carries the full tag set, letting `CassandraQuery` JS-
      // refine multi-tag filters without a follow-up read.
      if (this.options.useTagIndex && tagList && tagList.length > 0) {
        for (const tag of tagList) {
          batchOps.push({
            query:
              `INSERT INTO ${this.qualified(this.tagIndexTable)} (tag, timestamp, persistence_id, sequence_nr, payload, tags) VALUES (?, ?, ?, ?, ?, ?)`,
            params: [tag, now, pid, seq, payload, tagList],
          });
        }
      }
      written.push({
        persistenceId: pid,
        sequenceNr: seq,
        event: ev,
        timestamp: now,
        tags: tagList ? [...tagList] : undefined,
      });
    }
    await flush();

    // 3) Upsert the metadata row with the new max-seq.
    try {
      await this.client.execute(
        `INSERT INTO ${this.qualified(this.metadataTable)} (persistence_id, max_sequence_nr, updated_at) VALUES (?, ?, ?)`,
        [pid, seq, now],
        { prepare: true },
      );
    } catch (e) {
      throw new JournalError(`CassandraJournal.append: metadata update failed: ${(e as Error).message}`, e);
    }

    // 4) Index the persistence id so `persistenceIds()` can enumerate them.
    //    Skipped on re-inserts thanks to the PK — no-ops are free.
    if (actualSeq === 0) {
      try {
        await this.client.execute(
          `INSERT INTO ${this.qualified(this.allIdsTable)} (tag, persistence_id) VALUES (?, ?)`,
          ['_all', pid],
          { prepare: true },
        );
      } catch { /* non-fatal — listing is best-effort */ }
    }

    return written;
  }

  async read<E>(pid: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    await this.ensureStarted();
    const partitionSize = this.options.partitionSize ?? 500_000;
    const highest = await this.readHighestSeq(pid);
    const hi = toSeq !== undefined ? Math.min(toSeq, highest) : highest;
    if (hi < fromSeq) return [];

    const firstPartition = Math.floor(Math.max(fromSeq - 1, 0) / partitionSize);
    const lastPartition = Math.floor(Math.max(hi - 1, 0) / partitionSize);

    const out: PersistentEvent<E>[] = [];
    for (let partition = firstPartition; partition <= lastPartition; partition++) {
      const res = await this.client.execute(
        `SELECT persistence_id, partition_nr, sequence_nr, timestamp, payload, tags FROM ${this.qualified(this.eventsTable)} WHERE persistence_id = ? AND partition_nr = ? AND sequence_nr >= ? AND sequence_nr <= ?`,
        [pid, partition, fromSeq, hi],
        { prepare: true },
      );
      for (const row of res.rows as unknown as EventRow[]) {
        out.push({
          persistenceId: row.persistence_id,
          sequenceNr: Number(row.sequence_nr),
          event: JSON.parse(row.payload) as E,
          timestamp: Number(row.timestamp),
          tags: row.tags && row.tags.length > 0 ? row.tags : undefined,
        });
      }
    }
    // Partition reads come back sorted by clustering order; stitching is cheap.
    out.sort((a, b) => a.sequenceNr - b.sequenceNr);
    return out;
  }

  async highestSeq(pid: string): Promise<number> {
    await this.ensureStarted();
    return this.readHighestSeq(pid);
  }

  async delete(pid: string, toSeq: number): Promise<void> {
    await this.ensureStarted();
    const partitionSize = this.options.partitionSize ?? 500_000;
    const lastPartition = Math.floor(Math.max(toSeq - 1, 0) / partitionSize);
    for (let partition = 0; partition <= lastPartition; partition++) {
      try {
        await this.client.execute(
          `DELETE FROM ${this.qualified(this.eventsTable)} WHERE persistence_id = ? AND partition_nr = ? AND sequence_nr <= ?`,
          [pid, partition, toSeq],
          { prepare: true },
        );
      } catch (e) {
        throw new JournalError(`CassandraJournal.delete failed: ${(e as Error).message}`, e);
      }
    }
  }

  async persistenceIds(): Promise<string[]> {
    await this.ensureStarted();
    const res = await this.client.execute(
      `SELECT persistence_id FROM ${this.qualified(this.allIdsTable)} WHERE tag = ?`,
      ['_all'],
      { prepare: true },
    );
    return (res.rows as unknown as Array<{ persistence_id: string }>).map(r => r.persistence_id);
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ownsClient && this.started) {
      try { await this.client.shutdown(); } catch { /* ignore */ }
    }
  }

  /* ========================== internal ========================== */

  private get eventsTable(): string { return this.options.eventsTable ?? 'events'; }
  private get metadataTable(): string { return this.options.metadataTable ?? 'metadata'; }
  private get allIdsTable(): string { return this.options.allIdsTable ?? 'all_persistence_ids'; }
  /** Side-table name used when `useTagIndex` is set — visible so
   *  `CassandraQuery` can target it directly. */
  get tagIndexTable(): string { return this.options.tagIndexTable ?? 'events_by_tag'; }
  /** Whether dual-writes to the tag-index side table are enabled. */
  get useTagIndex(): boolean { return this.options.useTagIndex === true; }

  private qualified(table: string): string {
    // keyspace + table are interpolated into CQL (identifiers can't be bound)
    // — validate both so a config-sourced value can't inject CQL
    // (security audit #6).
    const ks = this.options.keyspace;
    if (ks !== undefined) assertSafeIdentifier(ks, 'keyspace');
    return `${ks}.${assertSafeIdentifier(table, 'table')}`;
  }

  private async readHighestSeq(pid: string): Promise<number> {
    const res = await this.client.execute(
      `SELECT max_sequence_nr FROM ${this.qualified(this.metadataTable)} WHERE persistence_id = ?`,
      [pid],
      { prepare: true },
    );
    const row = res.rows[0] as { max_sequence_nr?: string | number } | undefined;
    return row?.max_sequence_nr !== undefined ? Number(row.max_sequence_nr) : 0;
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    await this.start();
  }

  private async ensureTables(): Promise<void> {
    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS ${this.qualified(this.eventsTable)} (`
      + ` persistence_id text,`
      + ` partition_nr bigint,`
      + ` sequence_nr bigint,`
      + ` timestamp bigint,`
      + ` payload text,`
      + ` tags set<text>,`
      + ` PRIMARY KEY ((persistence_id, partition_nr), sequence_nr)`
      + ` ) WITH CLUSTERING ORDER BY (sequence_nr ASC)`,
    );
    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS ${this.qualified(this.metadataTable)} (`
      + ` persistence_id text PRIMARY KEY,`
      + ` max_sequence_nr bigint,`
      + ` updated_at bigint`
      + ` )`,
    );
    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS ${this.qualified(this.allIdsTable)} (`
      + ` tag text,`
      + ` persistence_id text,`
      + ` PRIMARY KEY (tag, persistence_id)`
      + ` )`,
    );
    if (this.useTagIndex) {
      // Side table for indexed `eventsByTag` queries (#44).  Each row
      // is one (event, tag) pair; a tag-query walks a single (tag)
      // partition ordered by `(timestamp, persistence_id, sequence_nr)`
      // — bounded scan cost regardless of total journal size.  Carrying
      // the full `tags` set on every row lets the query layer JS-refine
      // multi-tag filters without an extra read of `events`.
      await this.client.execute(
        `CREATE TABLE IF NOT EXISTS ${this.qualified(this.tagIndexTable)} (`
        + ` tag text,`
        + ` timestamp bigint,`
        + ` persistence_id text,`
        + ` sequence_nr bigint,`
        + ` payload text,`
        + ` tags set<text>,`
        + ` PRIMARY KEY ((tag), timestamp, persistence_id, sequence_nr)`
        + ` ) WITH CLUSTERING ORDER BY (timestamp ASC, persistence_id ASC, sequence_nr ASC)`,
      );
    }
  }
}
