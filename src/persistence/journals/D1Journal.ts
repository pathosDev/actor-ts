import { sqliteDialect } from '../relational/SqliteDialect.js';
import { RelationalJournal } from '../relational/RelationalJournal.js';
import { adaptD1Client, buildD1Client } from './D1Client.js';
import {
  D1JournalOptionsValidator,
  type D1JournalOptions,
  type D1JournalOptionsType,
} from './D1JournalOptions.js';

/**
 * Journal backed by Cloudflare D1 — SQLite at the edge, over D1's REST API.
 *
 * Behaviour lives in `RelationalJournal`, and the SQL is `sqliteDialect`'s, so the
 * schema is **identical** to the local SQLite and libSQL backends: a database can
 * move between all three without a migration.  This backend cost a client and
 * three constructors, which is the payoff the relational base was built for.
 *
 * **No transactions, by transport.**  D1's HTTP API exposes one statement per
 * request — no `BEGIN`, and no parameterized batch either (that is a Workers
 * binding feature).  The append is still correct: optimistic concurrency rests on
 * the events primary key rejecting a racing writer, which `sqliteDialect`
 * translates into `JournalConcurrencyError`, not on the transaction.  Appends are
 * contiguous from the head, so a losing writer fails on its *first* insert and
 * writes nothing.
 *
 * What the missing transaction does cost: if the connection fails partway through
 * a multi-event append, the events already written stay written.  The stream is
 * gap-free and the next append continues from the new head, so recovery is
 * consistent — but the caller's error does not mean "nothing was written".
 * Single-event appends are unaffected.  MongoDB carries the same caveat for the
 * same reason.
 *
 * Every statement is an HTTPS round-trip to Cloudflare's API, so this is the
 * slowest backend per operation by a wide margin.  It exists for Workers-adjacent
 * deployments where the data must live in D1, not as a general-purpose journal.
 */
export class D1Journal extends RelationalJournal {
  constructor(options: D1JournalOptions = {}) {
    const resolvedOptions = (options as D1JournalOptionsType);
    new D1JournalOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'D1Journal',
      dialect: sqliteDialect,
      eventsTable: resolvedOptions.eventsTable,
      tagsTable: resolvedOptions.tagsTable,
      autoCreateTables: resolvedOptions.autoCreateTables,
      ownsPool: resolvedOptions.client === undefined,
      openPool: async () => adaptD1Client(buildD1Client(resolvedOptions)),
    });
  }
}
