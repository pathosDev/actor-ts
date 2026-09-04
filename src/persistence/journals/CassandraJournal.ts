import type { Journal } from '../Journal.js';
import {
  JournalConcurrencyError,
  JournalError,
  type JournalEntry,
  type PersistentEvent,
} from '../JournalTypes.js';
import {
  DEFAULT_CASSANDRA_TAG_INDEX_TABLE,
  createCassandraClient,
  keyspaceDdl,
  type CassandraClientLike,
  type CassandraConnection,
} from './CassandraClient.js';
import {
  CassandraJournalOptionsValidator,
  DEFAULT_CASSANDRA_ALL_IDS_TABLE,
  DEFAULT_CASSANDRA_LIGHTWEIGHT_TRANSACTIONS,
  DEFAULT_CASSANDRA_METADATA_TABLE,
  DEFAULT_CASSANDRA_PARTITION_SIZE,
} from './CassandraJournalOptions.js';
import type { Serializer } from '../../serialization/Serializer.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import { assertSafeIdentifier } from '../storage/SqlIdentifier.js';
import { DEFAULT_AUTO_CREATE_TABLES, DEFAULT_EVENTS_TABLE, STORAGE_IDENTITY_TABLE } from '../Constants.js';
import { assertValidPersistenceId } from '../storage/PersistenceIdValidator.js';
import { assertValidEntryTags } from '../storage/TagValidator.js';
import type { StorageLocality } from '../StorageLocality.js';
import type { CassandraJournalOptions, CassandraJournalOptionsType } from './CassandraJournalOptions.js';

type EventRow = {
  persistence_id: string;
  partition_nr: string | number; // bigint comes back as driver type
  sequence_nr: string | number;
  timestamp: string | number;
  payload: string;
  tags: string[] | null;
};

/**
 * The narrow projection `delete` reads back to rebuild the `events_by_tag`
 * primary key `(tag, timestamp, persistence_id, sequence_nr)` — deliberately
 * payload-free, see `deleteTagIndexRows`.
 */
type TagIndexKeyRow = {
  sequence_nr: string | number;
  timestamp: string | number;
  tags: string[] | null;
};

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
  /** A Cassandra/Scylla cluster any node can reach (#1356). */
  readonly storageLocality: StorageLocality = 'shared';
  private cachedStorageIdentity: string | null = null;

  /** Identity of the keyspace's database — journal and snapshot store over one keyspace share it (#1358). */
  async storageIdentity(): Promise<string> {
    if (this.cachedStorageIdentity !== null) return this.cachedStorageIdentity;
    await this.ensureStarted();
    const table = this.qualified(STORAGE_IDENTITY_TABLE);
    if (this.options.autoCreateTables ?? DEFAULT_AUTO_CREATE_TABLES) {
      await this.client.execute(
        `CREATE TABLE IF NOT EXISTS ${table} ( singleton int PRIMARY KEY, identity text )`,
      );
    }
    // The same LWT the append path trusts — losing the claim to a sibling
    // store on the same keyspace is the expected path.
    await this.client.execute(
      `INSERT INTO ${table} (singleton, identity) VALUES (?, ?) IF NOT EXISTS`,
      [1, crypto.randomUUID()],
      this.conditionalOptions(),
    );
    const response = await this.client.execute(
      `SELECT identity FROM ${table} WHERE singleton = ?`,
      [1],
      this.readOptions(),
    );
    const identity = (response.rows[0] as { identity?: unknown } | undefined)?.identity;
    if (typeof identity !== 'string' || identity.length === 0) {
      throw new JournalError('CassandraJournal.storageIdentity: identity row missing after insert');
    }
    this.cachedStorageIdentity = identity;
    return identity;
  }

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

  /** The configured payload serializer — read by `CassandraQuery` so tag reads decode like the journal. */
  get serializer(): Serializer | undefined { return this.options.serializer; }

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
    if (this.options.autoCreateTables ?? DEFAULT_AUTO_CREATE_TABLES) {
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
    entries: ReadonlyArray<JournalEntry<E>>,
    expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    if (entries.length === 0) return [];
    assertValidPersistenceId(persistenceId, 'CassandraJournal.append');
    assertValidEntryTags(entries);
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
    const partitionSize = this.options.partitionSize ?? DEFAULT_CASSANDRA_PARTITION_SIZE;
    const written: PersistentEvent<E>[] = [];
    const lastSeq = actualSeq + entries.length;

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
      for (const entry of entries) {
        seq++;
        const partition = Math.floor((seq - 1) / partitionSize);
        if (batchPartition !== null && partition !== batchPartition) await flush();
        batchPartition = partition;
        const tagList = entry.tags ? Array.from(entry.tags) : null;
        const payload = encodePayload(entry.event, this.options.serializer);
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
          event: entry.event,
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
    const partitionSize = this.options.partitionSize ?? DEFAULT_CASSANDRA_PARTITION_SIZE;
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
            event: decodePayload(row.payload, this.options.serializer) as E,
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

  /**
   * Compaction has to reach the tag index too (#654).  `events_by_tag` is a
   * separate physical table this class dual-writes in `append` — not a
   * secondary index Cassandra maintains — so nothing removes its rows when
   * the events go, and each of them carries the **full payload**.  Left
   * behind, a compacted event stayed both readable through
   * `CassandraQuery.currentEventsByTag` and stored forever, which is a
   * correctness defect and a data-retention one at the same time.
   *
   * The tag rows go first, matching `SqliteJournal` and `RelationalJournal`:
   * a crash between the two deletes then leaves events whose tag rows are
   * already gone — a re-run of the same `delete` still reaches them — rather
   * than tag rows pointing at events that no longer exist, which no later
   * compaction could ever find.
   */
  async delete(persistenceId: string, toSeq: number): Promise<void> {
    await this.ensureStarted();
    const partitionSize = this.options.partitionSize ?? DEFAULT_CASSANDRA_PARTITION_SIZE;
    const lastPartition = Math.floor(Math.max(toSeq - 1, 0) / partitionSize);
    for (let partition = 0; partition <= lastPartition; partition++) {
      try {
        if (this.useTagIndex) await this.deleteTagIndexRows(persistenceId, partition, toSeq);
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

  /**
   * Drop the `events_by_tag` rows of one partition's compacted prefix.
   *
   * It has to be read-then-delete rather than a range delete: the side table
   * is partitioned by `(tag)` and clustered on `timestamp` first, and neither
   * is derivable from `(persistenceId, toSeq)`.  The events row is the only
   * place the `(timestamp, tags)` pair is recorded — which is also why this
   * runs *before* the events are deleted rather than after.
   *
   * One statement per (event, tag) pair, deliberately not a batch: every tag
   * is its own partition, so batching them is exactly the multi-partition
   * batch `append` splits itself up to avoid.
   */
  private async deleteTagIndexRows(
    persistenceId: string,
    partition: number,
    toSeq: number,
  ): Promise<void> {
    // Only the three columns the side table's key is rebuilt from — pulling
    // `payload` back for a prefix being compacted would be the largest read
    // in the delete path and nothing here reads it.
    const response = await this.client.execute(
      `SELECT sequence_nr, timestamp, tags FROM ${this.qualified(this.eventsTable)} WHERE persistence_id = ? AND partition_nr = ? AND sequence_nr <= ?`,
      [persistenceId, partition, toSeq],
      this.readOptions(),
    );
    for (const row of response.rows as unknown as TagIndexKeyRow[]) {
      // A CQL `set<text>` comes back null (or empty) for an untagged event,
      // which never produced a side-table row in the first place.
      if (!row.tags || row.tags.length === 0) continue;
      for (const tag of row.tags) {
        await this.client.execute(
          `DELETE FROM ${this.qualified(this.tagIndexTable)} WHERE tag = ? AND timestamp = ? AND persistence_id = ? AND sequence_nr = ?`,
          [tag, Number(row.timestamp), persistenceId, Number(row.sequence_nr)],
          this.readOptions(),
        );
      }
    }
  }

  /**
   * Here the high-water mark IS `max_sequence_nr` — there is no separate
   * `deleted_to` column, which is why `delete` leaves the metadata row alone
   * and why raising the mark goes through the very same claim `append` uses.
   * Taking the LWT rather than a bare `INSERT` matters: the metadata row is
   * the append serializer, so an unconditional write would clobber a
   * concurrent writer's claim and hand two writers the same sequence range.
   * A losing claim surfaces as `JournalConcurrencyError`, exactly as it does
   * for an append that raced.
   */
  async raiseCompactionMark(persistenceId: string, throughSeq: number): Promise<void> {
    await this.ensureStarted();
    const metadata = await this.readMetadata(persistenceId);
    const current = metadata?.maxSequenceNr ?? 0;
    // Monotonic: a mark already at or above `throughSeq` is left alone rather
    // than rewound, and a re-run of a migration is therefore free.
    if (current >= throughSeq) return;
    const now = Date.now();
    if (this.lightweightTransactions) {
      await this.claimSequenceRange(persistenceId, metadata !== null, current, throughSeq, now);
    } else {
      try {
        await this.client.execute(
          `INSERT INTO ${this.qualified(this.metadataTable)} (persistence_id, max_sequence_nr, updated_at) VALUES (?, ?, ?)`,
          [persistenceId, throughSeq, now],
          this.readOptions(),
        );
      } catch (e) {
        throw new JournalError(`CassandraJournal.raiseCompactionMark failed: ${(e as Error).message}`, e);
      }
    }
    // Index the id the way `append` does at seq 0, so a stream that carries a
    // mark but no surviving events still enumerates — which is what a fully
    // compacted stream looks like once it has been migrated.
    try {
      await this.client.execute(
        `INSERT INTO ${this.qualified(this.allIdsTable)} (tag, persistence_id) VALUES (?, ?)`,
        ['_all', persistenceId],
        this.readOptions(),
      );
    } catch { /* non-fatal — listing is best-effort */ }
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

  /**
   * A clustering-column range over the `all_persistence_ids` partition.
   *
   * `PRIMARY KEY (tag, persistence_id)` makes `persistence_id` the clustering
   * column of the single `'_all'` partition, so `AND persistence_id > ?
   * LIMIT ?` is a seek into that partition's sorted run — not the
   * `token(persistence_id)` scan over `events` an earlier sketch of this
   * called for, which would have paid a coordinator fan-out per page and
   * handed back ids in ring order, in which no cursor is monotonic.
   *
   * The single partition is itself a scaling limit at very large id counts —
   * one replica set owns every id — but that is the shape `persistenceIds()`
   * already had, and bucketing it is a schema migration rather than a paging
   * concern.
   */
  async persistenceIdsPaginated(
    afterPersistenceId: string | undefined,
    limit: number,
  ): Promise<string[]> {
    await this.ensureStarted();
    const table = this.qualified(this.allIdsTable);
    try {
      const response = afterPersistenceId === undefined
        ? await this.client.execute(
          `SELECT persistence_id FROM ${table} WHERE tag = ? LIMIT ?`,
          ['_all', limit],
          this.readOptions(),
        )
        : await this.client.execute(
          `SELECT persistence_id FROM ${table} WHERE tag = ? AND persistence_id > ? LIMIT ?`,
          ['_all', afterPersistenceId, limit],
          this.readOptions(),
        );
      return (response.rows as unknown as Array<{ persistence_id: string }>)
        .map(r => r.persistence_id);
    } catch (e) {
      throw new JournalError(
        `CassandraJournal.persistenceIdsPaginated failed: ${(e as Error).message}`, e,
      );
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

  private get eventsTable(): string { return this.options.eventsTable ?? DEFAULT_EVENTS_TABLE; }
  private get metadataTable(): string { return this.options.metadataTable ?? DEFAULT_CASSANDRA_METADATA_TABLE; }
  private get allIdsTable(): string { return this.options.allIdsTable ?? DEFAULT_CASSANDRA_ALL_IDS_TABLE; }
  private get tagIndexTable(): string { return this.options.tagIndexTable ?? DEFAULT_CASSANDRA_TAG_INDEX_TABLE; }
  /**
   * `keyspace.tagIndexTable`, validated — the form `CassandraQuery` targets.
   *
   * The bare name used to be the public getter, and the query class rebuilt
   * `${keyspace}.${name}` from it by hand, which skipped the guard every
   * other CQL site here goes through (security audit #614).  Exposing only
   * the qualified form removes the seam rather than documenting around it.
   */
  get qualifiedTagIndexTable(): string { return this.qualified(this.tagIndexTable); }
  /** Whether dual-writes to the tag-index side table are enabled. */
  get useTagIndex(): boolean { return this.options.useTagIndex === true; }
  /** Whether appends claim their sequence range with an LWT (#475).  On by default. */
  private get lightweightTransactions(): boolean { return this.options.lightweightTransactions ?? DEFAULT_CASSANDRA_LIGHTWEIGHT_TRANSACTIONS; }

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
