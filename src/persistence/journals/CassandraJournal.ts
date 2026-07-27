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
import { assertValidTags } from '../storage/TagValidator.js';
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
 * Appends are serialized by a **lightweight transaction** on the metadata
 * row: the writer claims its sequence range with a conditional statement
 * before a single event is written, so two writers that both read head `N`
 * can never both proceed (#475).  A plain read-check would not be enough —
 * a Cassandra `INSERT` is an upsert, so the loser of that race would
 * silently overwrite the winner's event instead of being rejected the way
 * the relational backends' primary key rejects it.  Costs one Paxos
 * round-trip per `append`; `lightweightTransactions: false` trades the
 * guarantee back for the round-trip.
 */
export class CassandraJournal implements Journal {
  private readonly options: Partial<CassandraJournalOptionsType>;
  private client: CassandraClientLike;
  /** True once `ensureStarted()` has run keyspace + table DDL. */
  private started = false;
  /** Single-flight guard so two concurrent first calls don't both connect + run DDL. */
  private startPromise: Promise<void> | null = null;
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

  /**
   * Explicitly connect + ensure schema.  Called lazily on first use.
   * Single-flight: concurrent callers share one in-flight start; a failed
   * start clears the guard so a later call can retry.
   */
  async start(): Promise<void> {
    if (this.started) return;
    if (!this.startPromise) {
      this.startPromise = this.doStart().catch((e) => {
        this.startPromise = null;
        throw e;
      });
    }
    await this.startPromise;
  }

  private async doStart(): Promise<void> {
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

  /** CQL query options for data-path reads/writes, honouring the configured consistency level. */
  private readOptions(): { prepare: boolean; consistency?: number } {
    return this.options.consistency === undefined
      ? { prepare: true }
      : { prepare: true, consistency: this.options.consistency };
  }

  /**
   * Query options for the LWT claim.  Adds the serial consistency governing
   * the Paxos phase: left unset the driver uses cluster-wide `SERIAL`, which
   * drags every append across datacenters on a multi-DC keyspace — the exact
   * cost `consistency: LOCAL_QUORUM` exists to avoid.
   */
  private conditionalOptions(): { prepare: boolean; consistency?: number; serialConsistency?: number } {
    return this.options.serialConsistency === undefined
      ? this.readOptions()
      : { ...this.readOptions(), serialConsistency: this.options.serialConsistency };
  }

  /** CQL batch options — unlogged (see `append`), honouring the configured consistency level. */
  private batchOptions(): { prepare: boolean; logged: boolean; consistency?: number } {
    return this.options.consistency === undefined
      ? { prepare: true, logged: false }
      : { prepare: true, logged: false, consistency: this.options.consistency };
  }

  async append<E>(
    persistenceId: string,
    events: ReadonlyArray<E>,
    expectedSeq: number,
    tags?: ReadonlyArray<string>,
  ): Promise<PersistentEvent<E>[]> {
    if (events.length === 0) return [];
    assertValidTags(tags);
    await this.ensureStarted();

    // 1) Read current max-seq from metadata; throw on mismatch.  Under LWT
    //    this is only a cheap pre-check that spares an obviously-stale
    //    caller a Paxos round — the claim in step 2 is the authority, and a
    //    read that raced a concurrent commit is caught there.  Whether the
    //    row EXISTS (not merely whether it reads 0) picks the claim variant.
    const metadata = await this.readMetadata(persistenceId);
    const actualSeq = metadata?.maxSequenceNr ?? 0;
    if (actualSeq !== expectedSeq) {
      throw new JournalConcurrencyError(persistenceId, expectedSeq, actualSeq);
    }

    const now = Date.now();
    const partitionSize = this.options.partitionSize ?? 500_000;
    const tagList = tags ? Array.from(tags) : null;
    const written: PersistentEvent<E>[] = [];
    const lastSeq = actualSeq + events.length;

    // 2) Claim the whole range [actualSeq+1, lastSeq] on the metadata row
    //    BEFORE writing any event.  Ordering matters: the events insert is
    //    an upsert, so a claim taken afterwards would let a loser overwrite
    //    the winner's payload and still be told it won.  Claiming first
    //    inverts the crash window instead — see `releaseSequenceRange`.
    if (this.lightweightTransactions) {
      await this.claimSequenceRange(persistenceId, metadata !== null, expectedSeq, lastSeq, now);
    }

    // 3) Batch INSERT events, one unlogged batch per partition.  Unlogged
    //    (not atomic across rows) is fine here: the sequence range is already
    //    claimed, so no concurrent writer races these inserts, and a partial
    //    batch is recovered by re-running from the last committed max-seq.
    //    Splitting per partition avoids Cassandra's multi-partition
    //    logged-batch warning — and the claim can't join the batch anyway,
    //    since a conditional batch must stay inside one partition.
    let batchPartition: number | null = null;
    let batchOps: Array<{ query: string; params: ReadonlyArray<unknown> }> = [];
    const flush = async (): Promise<void> => {
      if (batchOps.length === 0) return;
      try {
        await this.client.batch(batchOps, this.batchOptions());
      } catch (e) {
        throw new JournalError(`CassandraJournal.append: batch failed: ${(e as Error).message}`, e);
      }
      batchOps = [];
      batchPartition = null;
    };

    let seq = actualSeq;
    try {
      for (const ev of events) {
        seq++;
        const partition = Math.floor((seq - 1) / partitionSize);
        if (batchPartition !== null && partition !== batchPartition) await flush();
        batchPartition = partition;
        const payload = JSON.stringify(ev);
        batchOps.push({
          query:
            `INSERT INTO ${this.qualified(this.eventsTable)} (persistence_id, partition_nr, sequence_nr, timestamp, payload, tags) VALUES (?, ?, ?, ?, ?, ?)`,
          params: [persistenceId, partition, seq, now, payload, tagList],
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
              params: [tag, now, persistenceId, seq, payload, tagList],
            });
          }
        }
        written.push({
          persistenceId: persistenceId,
          sequenceNr: seq,
          event: ev,
          timestamp: now,
          tags: tagList ? [...tagList] : undefined,
        });
      }
      await flush();
    } catch (e) {
      if (this.lightweightTransactions) {
        await this.releaseSequenceRange(persistenceId, actualSeq, lastSeq, now);
      }
      throw e;
    }

    // 4) Publish the new max-seq.  Under LWT the claim in step 2 already
    //    wrote it — re-writing here would clobber a newer writer's head.
    if (!this.lightweightTransactions) {
      try {
        await this.client.execute(
          `INSERT INTO ${this.qualified(this.metadataTable)} (persistence_id, max_sequence_nr, updated_at) VALUES (?, ?, ?)`,
          [persistenceId, seq, now],
          this.readOptions(),
        );
      } catch (e) {
        throw new JournalError(`CassandraJournal.append: metadata update failed: ${(e as Error).message}`, e);
      }
    }

    // 5) Index the persistence id so `persistenceIds()` can enumerate them.
    //    Skipped on re-inserts thanks to the PK — no-ops are free.
    if (actualSeq === 0) {
      try {
        await this.client.execute(
          `INSERT INTO ${this.qualified(this.allIdsTable)} (tag, persistence_id) VALUES (?, ?)`,
          ['_all', persistenceId],
          this.readOptions(),
        );
      } catch { /* non-fatal — listing is best-effort */ }
    }

    return written;
  }

  async read<E>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    await this.ensureStarted();
    const partitionSize = this.options.partitionSize ?? 500_000;
    const highest = await this.readHighestSeq(persistenceId);
    const hi = toSeq !== undefined ? Math.min(toSeq, highest) : highest;
    if (hi < fromSeq) return [];

    const firstPartition = Math.floor(Math.max(fromSeq - 1, 0) / partitionSize);
    const lastPartition = Math.floor(Math.max(hi - 1, 0) / partitionSize);

    const out: PersistentEvent<E>[] = [];
    try {
      for (let partition = firstPartition; partition <= lastPartition; partition++) {
        const response = await this.client.execute(
          `SELECT persistence_id, partition_nr, sequence_nr, timestamp, payload, tags FROM ${this.qualified(this.eventsTable)} WHERE persistence_id = ? AND partition_nr = ? AND sequence_nr >= ? AND sequence_nr <= ?`,
          [persistenceId, partition, fromSeq, hi],
          this.readOptions(),
        );
        for (const row of response.rows as unknown as EventRow[]) {
          out.push({
            persistenceId: row.persistence_id,
            sequenceNr: Number(row.sequence_nr),
            event: JSON.parse(row.payload) as E,
            timestamp: Number(row.timestamp),
            tags: row.tags && row.tags.length > 0 ? row.tags : undefined,
          });
        }
      }
    } catch (e) {
      throw new JournalError(`CassandraJournal.read failed: ${(e as Error).message}`, e);
    }
    // Partition reads come back sorted by clustering order; stitching is cheap.
    out.sort((a, b) => a.sequenceNr - b.sequenceNr);
    return out;
  }

  async highestSeq(persistenceId: string): Promise<number> {
    await this.ensureStarted();
    return this.readHighestSeq(persistenceId);
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    await this.ensureStarted();
    const partitionSize = this.options.partitionSize ?? 500_000;
    const lastPartition = Math.floor(Math.max(toSeq - 1, 0) / partitionSize);
    for (let partition = 0; partition <= lastPartition; partition++) {
      try {
        await this.client.execute(
          `DELETE FROM ${this.qualified(this.eventsTable)} WHERE persistence_id = ? AND partition_nr = ? AND sequence_nr <= ?`,
          [persistenceId, partition, toSeq],
          this.readOptions(),
        );
      } catch (e) {
        throw new JournalError(`CassandraJournal.delete failed: ${(e as Error).message}`, e);
      }
    }
  }

  async persistenceIds(): Promise<string[]> {
    await this.ensureStarted();
    try {
      const response = await this.client.execute(
        `SELECT persistence_id FROM ${this.qualified(this.allIdsTable)} WHERE tag = ?`,
        ['_all'],
        this.readOptions(),
      );
      return (response.rows as unknown as Array<{ persistence_id: string }>).map(r => r.persistence_id);
    } catch (e) {
      throw new JournalError(`CassandraJournal.persistenceIds failed: ${(e as Error).message}`, e);
    }
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
  /** Whether appends claim their sequence range with an LWT (#475).  On by default. */
  private get lightweightTransactions(): boolean { return this.options.lightweightTransactions ?? true; }

  private qualified(table: string): string {
    // keyspace + table are interpolated into CQL (identifiers can't be bound)
    // — validate both so a config-sourced value can't inject CQL
    // (security audit #6).
    const ks = this.options.keyspace;
    if (ks !== undefined) assertSafeIdentifier(ks, 'keyspace');
    return `${ks}.${assertSafeIdentifier(table, 'table')}`;
  }

  private async readHighestSeq(persistenceId: string): Promise<number> {
    return (await this.readMetadata(persistenceId))?.maxSequenceNr ?? 0;
  }

  /**
   * Read the metadata row, distinguishing "no row yet" (`null`) from "row
   * holding 0" — `append` needs that difference to pick between the
   * `IF NOT EXISTS` and `IF max_sequence_nr = ?` claim variants.
   */
  private async readMetadata(persistenceId: string): Promise<{ maxSequenceNr: number } | null> {
    try {
      const response = await this.client.execute(
        `SELECT max_sequence_nr FROM ${this.qualified(this.metadataTable)} WHERE persistence_id = ?`,
        [persistenceId],
        this.readOptions(),
      );
      const row = response.rows[0] as { max_sequence_nr?: string | number } | undefined;
      if (row?.max_sequence_nr === undefined || row.max_sequence_nr === null) return null;
      return { maxSequenceNr: Number(row.max_sequence_nr) };
    } catch (e) {
      throw new JournalError(`CassandraJournal.highestSeq failed: ${(e as Error).message}`, e);
    }
  }

  /**
   * Claim `[…, lastSeq]` on the metadata row with a lightweight transaction.
   * Returns normally only when Paxos accepted OUR claim; a rejected claim
   * means another writer took the same range, and Cassandra hands back the
   * row as it actually stands — so the loser reports an accurate
   * `actualSeq` without paying for a second read.
   */
  private async claimSequenceRange(
    persistenceId: string,
    metadataExists: boolean,
    expectedSeq: number,
    lastSeq: number,
    now: number,
  ): Promise<void> {
    // `IF NOT EXISTS` and `IF max_sequence_nr = ?` are both guarded by the
    // same Paxos round, so picking the wrong variant off a stale read is
    // safe: it fails to apply rather than overwriting anything.
    const claim = metadataExists
      ? await this.executeConditional(
        `UPDATE ${this.qualified(this.metadataTable)} SET max_sequence_nr = ?, updated_at = ? WHERE persistence_id = ? IF max_sequence_nr = ?`,
        [lastSeq, now, persistenceId, expectedSeq],
      )
      : await this.executeConditional(
        `INSERT INTO ${this.qualified(this.metadataTable)} (persistence_id, max_sequence_nr, updated_at) VALUES (?, ?, ?) IF NOT EXISTS`,
        [persistenceId, lastSeq, now],
      );
    if (claim.applied) return;
    throw new JournalConcurrencyError(persistenceId, expectedSeq, claim.currentSeq ?? expectedSeq);
  }

  /**
   * Best-effort undo of a claim whose event batch then failed, so a retry
   * can re-claim the same range instead of leaving a permanent gap.
   * Conditional on the value WE claimed — a writer that has legitimately
   * moved the head on past us is never rewound.  Failures are swallowed:
   * the append is already throwing, and the residual gap (claim committed,
   * events missing, release lost too) is the documented crash window.
   */
  private async releaseSequenceRange(
    persistenceId: string,
    previousSeq: number,
    claimedSeq: number,
    now: number,
  ): Promise<void> {
    try {
      await this.client.execute(
        `UPDATE ${this.qualified(this.metadataTable)} SET max_sequence_nr = ?, updated_at = ? WHERE persistence_id = ? IF max_sequence_nr = ?`,
        [previousSeq, now, persistenceId, claimedSeq],
        this.conditionalOptions(),
      );
    } catch { /* best-effort — the original failure is what the caller sees */ }
  }

  /**
   * Run a conditional statement and decode Cassandra's LWT result row —
   * `[applied]`, plus the current column values when the condition failed.
   * A missing `[applied]` marker means the statement did not run as an LWT
   * at all; that is raised loudly rather than assumed to have applied,
   * because assuming success is exactly the silent-overwrite this guards.
   */
  private async executeConditional(
    query: string,
    params: ReadonlyArray<unknown>,
  ): Promise<{ applied: boolean; currentSeq: number | null }> {
    let response;
    try {
      response = await this.client.execute(query, params, this.conditionalOptions());
    } catch (e) {
      throw new JournalError(`CassandraJournal.append: sequence claim failed: ${(e as Error).message}`, e);
    }
    const row = (response.rows[0] ?? {}) as Record<string, unknown>;
    const applied = row['[applied]'];
    if (typeof applied !== 'boolean') {
      throw new JournalError(
        `CassandraJournal.append: conditional metadata write returned no [applied] marker`
        + ` — the driver did not execute it as a lightweight transaction.`
        + ` Set lightweightTransactions: false to opt out of LWT-serialized appends.`,
      );
    }
    const current = row['max_sequence_nr'];
    return {
      applied,
      currentSeq: current === undefined || current === null ? null : Number(current),
    };
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
