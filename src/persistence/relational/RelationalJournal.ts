import type { Journal } from '../Journal.js';
import {
  JournalConcurrencyError,
  type PersistentEvent,
} from '../JournalTypes.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import { assertSafeIdentifier } from '../storage/SqlIdentifier.js';
import { assertValidPersistenceId } from '../storage/PersistenceIdValidator.js';
import { assertValidTags } from '../storage/TagValidator.js';
import { expandPlaceholders, type JournalTableNames } from './SqlDialect.js';
import { RelationalStore, type RelationalStoreConfig } from './RelationalStore.js';
import type { SqlExecutor } from './SqlPool.js';

type EventRow = {
  persistence_id: string;
  sequence_nr: string | number | bigint;
  payload: string;
  tags: string | null;
  timestamp: string | number | bigint;
};

export interface RelationalJournalConfig extends RelationalStoreConfig {
  /** Events table.  Default `'events'`. */
  readonly eventsTable?: string;
  /** Tags join table.  Default `` `${eventsTable}_tags` ``. */
  readonly tagsTable?: string;
}

/**
 * Journal over any SQL database, parameterized by `SqlDialect`.
 *
 * Three tables: events keyed on `(persistence_id, sequence_nr)`, a tags join
 * table for indexed tag queries, and a metadata table holding the compaction
 * high-water mark.
 *
 * **Optimistic concurrency** is enforced twice over, deliberately.  `append`
 * reads the head and inserts inside one transaction, which handles the
 * ordinary case; a writer that slips between the read and the insert trips the
 * primary key, and that duplicate-key error is translated back into a
 * `JournalConcurrencyError`.  The backstop is what makes the contract correct
 * rather than merely likely — and it is why a dialect whose transport cannot
 * offer real transaction isolation (an HTTP-fronted SQLite such as libSQL or
 * Cloudflare D1) can still implement the journal safely.
 *
 * **The high-water mark never rewinds.**  After a full compaction the events
 * table reports `MAX(sequence_nr) = 0`, but `deleted_to` still holds the
 * highest sequence number ever written, so a recovered actor appending at its
 * pre-compaction head is accepted instead of being rejected as stale.
 *
 * No in-process event bus: a relational store spans processes, so `events` is
 * left undefined and the query layer falls back to polling.
 */
export class RelationalJournal extends RelationalStore implements Journal {
  private readonly tables: JournalTableNames;
  private readonly statements: {
    readonly head: string;
    readonly deletedTo: string;
    readonly insertEvent: string;
    readonly insertTag: string;
    readonly readFrom: string;
    readonly readRange: string;
    readonly deleteTags: string;
    readonly deleteEvents: string;
    readonly upsertDeletedTo: string;
    readonly persistenceIds: string;
  };

  constructor(config: RelationalJournalConfig) {
    super(config);
    const events = assertSafeIdentifier(config.eventsTable ?? 'events', 'events table');
    const tags = assertSafeIdentifier(config.tagsTable ?? `${events}_tags`, 'tags table');
    const meta = assertSafeIdentifier(`${events}_meta`, 'meta table');
    this.tables = { events, tags, meta };

    // Expanded once here rather than per call: table names are fixed at
    // construction, so the hot path does no string work.
    const expand = (sql: string): string => expandPlaceholders(sql, config.dialect);
    this.statements = {
      head: expand(`SELECT COALESCE(MAX(sequence_nr), 0) AS hi FROM ${events} WHERE persistence_id = ?`),
      deletedTo: expand(`SELECT COALESCE(deleted_to, 0) AS d FROM ${meta} WHERE persistence_id = ?`),
      insertEvent: expand(
        `INSERT INTO ${events}(persistence_id, sequence_nr, payload, tags, timestamp) VALUES (?, ?, ?, ?, ?)`,
      ),
      insertTag: config.dialect.insertTagSql(tags),
      readFrom: expand(
        `SELECT persistence_id, sequence_nr, payload, tags, timestamp FROM ${events} WHERE persistence_id = ? AND sequence_nr >= ? ORDER BY sequence_nr ASC`,
      ),
      readRange: expand(
        `SELECT persistence_id, sequence_nr, payload, tags, timestamp FROM ${events} WHERE persistence_id = ? AND sequence_nr >= ? AND sequence_nr <= ? ORDER BY sequence_nr ASC`,
      ),
      deleteTags: expand(`DELETE FROM ${tags} WHERE persistence_id = ? AND sequence_nr <= ?`),
      deleteEvents: expand(`DELETE FROM ${events} WHERE persistence_id = ? AND sequence_nr <= ?`),
      upsertDeletedTo: config.dialect.upsertDeletedToSql(meta),
      persistenceIds: `SELECT DISTINCT persistence_id FROM ${events}`,
    };
  }

  protected ddl(): string[] {
    return this.dialect.journalDdl(this.tables);
  }

  async append<E>(
    persistenceId: string,
    events: ReadonlyArray<E>,
    expectedSeq: number,
    tags?: ReadonlyArray<string>,
  ): Promise<PersistentEvent<E>[]> {
    if (events.length === 0) return [];
    assertValidPersistenceId(persistenceId, 'RelationalJournal.append');
    assertValidTags(tags);
    const pool = await this.ensureOpen();
    const now = Date.now();
    try {
      return await pool.withTransaction(async (transaction) => {
        const actualSeq = await this.readHead(transaction, persistenceId);
        if (actualSeq !== expectedSeq) {
          throw new JournalConcurrencyError(persistenceId, expectedSeq, actualSeq);
        }
        const written: PersistentEvent<E>[] = [];
        const tagString = tags && tags.length ? tags.join(',') : null;
        let seq = actualSeq;
        for (const event of events) {
          seq++;
          await transaction.query(this.statements.insertEvent, [
            persistenceId, seq, encodePayload(event, this.serializer), tagString, now,
          ]);
          if (tags) {
            for (const tag of tags) {
              if (tag.length === 0) continue;
              await transaction.query(this.statements.insertTag, [persistenceId, seq, tag, now]);
            }
          }
          written.push({
            persistenceId,
            sequenceNr: seq,
            event,
            timestamp: now,
            tags: tags ? [...tags] : undefined,
          });
        }
        return written;
      });
    } catch (e) {
      if (e instanceof JournalConcurrencyError) throw e;
      // A concurrent writer claimed the same (persistenceId, seq) between our
      // head read and the insert.  Report the now-current head so the caller
      // can re-read and retry.
      if (this.dialect.isDuplicateKeyError(e)) {
        const actual = await this.highestSeq(persistenceId).catch(() => expectedSeq);
        throw new JournalConcurrencyError(persistenceId, expectedSeq, actual);
      }
      // The engine may also abort the loser to resolve contention *before* the
      // primary key is checked — MariaDB does exactly that (#479).  Same race,
      // so it owes the caller the same JournalConcurrencyError; but unlike a
      // duplicate key, a contention abort is not proof of one.  Only translate
      // when the head actually moved, so an ordinary lock-wait timeout against
      // an unrelated long transaction stays the storage failure it is.
      if (this.dialect.isSerializationConflictError(e)) {
        const actual = await this.highestSeq(persistenceId).catch(() => expectedSeq);
        if (actual !== expectedSeq) {
          throw new JournalConcurrencyError(persistenceId, expectedSeq, actual);
        }
      }
      this.fail('append', e);
    }
  }

  async read<E>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    const pool = await this.ensureOpen();
    try {
      const result = toSeq === undefined
        ? await pool.query(this.statements.readFrom, [persistenceId, fromSeq])
        : await pool.query(this.statements.readRange, [persistenceId, fromSeq, toSeq]);
      return (result.rows as unknown as EventRow[]).map((row) => ({
        persistenceId: row.persistence_id,
        sequenceNr: Number(row.sequence_nr),
        event: decodePayload(row.payload, this.serializer) as E,
        timestamp: Number(row.timestamp),
        tags: row.tags ? String(row.tags).split(',') : undefined,
      }));
    } catch (e) {
      this.fail('read', e);
    }
  }

  async highestSeq(persistenceId: string): Promise<number> {
    const pool = await this.ensureOpen();
    try {
      return await this.readHead(pool, persistenceId);
    } catch (e) {
      this.fail('highestSeq', e);
    }
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    const pool = await this.ensureOpen();
    try {
      // Tags first: a crash mid-delete then leaves events without tag rows
      // rather than tag rows pointing at deleted events, which the JOIN-based
      // query path would silently miss.
      await pool.query(this.statements.deleteTags, [persistenceId, toSeq]);
      await pool.query(this.statements.deleteEvents, [persistenceId, toSeq]);
      // Record the high-water mark so `highestSeq` and the append concurrency
      // check don't rewind once the highest events are compacted away.
      await pool.query(this.statements.upsertDeletedTo, [persistenceId, toSeq]);
    } catch (e) {
      this.fail('delete', e);
    }
  }

  async persistenceIds(): Promise<string[]> {
    const pool = await this.ensureOpen();
    try {
      const result = await pool.query(this.statements.persistenceIds);
      return (result.rows as ReadonlyArray<{ persistence_id: string }>).map((row) => row.persistence_id);
    } catch (e) {
      this.fail('persistenceIds', e);
    }
  }

  /* --------------------------- internals -------------------------------- */

  /** Highest sequence number ever written — the events head or the compaction mark. */
  private async readHead(runner: SqlExecutor, persistenceId: string): Promise<number> {
    const head = await runner.query(this.statements.head, [persistenceId]);
    const stored = (head.rows[0] as { hi: string | number | bigint } | undefined)?.hi ?? 0;
    const mark = await runner.query(this.statements.deletedTo, [persistenceId]);
    const deletedTo = (mark.rows[0] as { d: string | number | bigint } | undefined)?.d ?? 0;
    return Math.max(Number(stored), Number(deletedTo));
  }
}
