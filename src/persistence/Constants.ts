/**
 * Tuned values shared across the persistence subsystem.
 *
 * A constant lives here when it is a cap, bound, timeout or size that more
 * than one persistence file reads — not when it is the built-in default of
 * an options field (that belongs in the matching `XOptions.ts`), and not
 * when it is part of a storage format defined in the file beside it (the
 * `BodyCodec` flags and `ATS1_MAGIC` stay there, because a second copy of
 * a format definition is how the format silently forks).
 *
 * Vendor API limits are prefixed with the vendor.  A bare `MAX_BATCH_ITEMS`
 * is unambiguous inside one driver and meaningless in a shared namespace,
 * where DynamoDB's 25 sits next to whatever the next backend caps at.
 *
 * This module imports nothing, so it can never close an import cycle —
 * the same property `XOptions.ts` has by construction.
 */

/**
 * DynamoDB caps one `BatchWriteItem` call at 25 items.  A hard API limit,
 * not a tuning choice: exceeding it is a `ValidationException`, so both the
 * journal's and the snapshot store's delete loops chunk on it.  They must
 * agree, because they chunk the same shape of request against the same API.
 */
export const DYNAMODB_MAX_BATCH_ITEMS = 25;

/**
 * DynamoDB caps one `TransactWriteItems` call at 100 items.  This is the
 * ceiling on how many events a single `append` can write atomically — the
 * journal rejects a larger batch up front rather than letting AWS reject it,
 * so the caller gets a message naming the limit instead of a driver error.
 */
export const DYNAMODB_MAX_TRANSACTION_ITEMS = 100;

/**
 * Busy timeout applied to every SQLite handle this package opens, in
 * milliseconds.
 *
 * Setting one at all is a portability fix rather than a tuning knob (#124).
 * The drivers disagree on their built-in default — measured: `bun:sqlite` 0,
 * `node:sqlite` 0, `better-sqlite3` 5000 — so with no explicit pragma the
 * *same* store code fails a contended write instantly on Bun and Deno and
 * blocks for five seconds on Node.  Identical behaviour across Bun, Node and
 * Deno is a project-wide promise, and this broke it silently.
 *
 * The value is deliberately far below `better-sqlite3`'s 5000.  `SqliteDriver`
 * is synchronous, so the busy handler blocks the whole event loop for the
 * duration of the wait — nothing else in the process runs, cluster heartbeats
 * included.  `defaultFailureDetectorOptions` declares a peer `unreachable`
 * after 2000 ms and `down` after 5000 ms, so inheriting 5000 would let a
 * single contended write stall a node long enough for its own cluster to
 * evict it.  1000 ms caps the worst case at half the `unreachable` threshold
 * and is still three orders of magnitude more than a local commit needs.
 *
 * `busyTimeoutMs: 0` opts out and restores fail-fast `SQLITE_BUSY`.
 *
 * Lives here rather than beside one options type because it backs the
 * `busyTimeoutMs` field of *both* `SqliteJournalOptions` and
 * `SqliteSnapshotStoreOptions`, and applies to any handle the package opens
 * — including one built directly through `buildSqliteDatabase`.
 */
export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 1_000;

/**
 * Ceiling on one Cloudflare D1 REST response body, in bytes — 64 MiB.
 *
 * D1 is the one backend that speaks over `HttpClient`, so it inherited that
 * client's generic 8 MiB response ceiling the moment the ceiling existed
 * (#602).  8 MiB is the wrong number here in both directions of the trade-off
 * it was sized for: it bounds an *untrusted third-party API*, whereas this
 * peer is the operator's own database, reached with the operator's own token,
 * returning the operator's own rows.
 *
 * And the response it has to fit is not a page.  `RelationalJournal.readFrom`
 * selects an actor's entire event history in one statement with no `LIMIT`,
 * and the D1 transport is one statement per HTTP request — so this bounds a
 * whole replay.  Under 8 MiB an actor whose history outgrew that number
 * stopped *recovering*, having recovered fine the day before, which is why
 * the D1 default is its own number rather than the client's.
 *
 * 64 MiB is the figure the HTTP docs already use for a call that legitimately
 * downloads a lot, and it is still a bound: the body is materialised in memory
 * before it is parsed, so "no ceiling" is not on the table for a transport
 * that a hostile or misconfigured proxy can also answer.  A history that
 * routinely approaches it wants snapshots or compaction rather than a bigger
 * buffer — but `maxResponseBytes` on any of the three D1 option families
 * raises it when that is genuinely the answer.
 *
 * Lives here rather than beside one options type because it backs the
 * `maxResponseBytes` field of *all three* D1 families (journal, snapshot
 * store, durable-state store), which share it through `D1Connection`.
 */
export const DEFAULT_D1_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * Longest accepted id — the width of the `persistence_id` column in every
 * relational dialect's DDL.  Anything longer cannot round-trip.
 */
export const MAX_PERSISTENCE_ID_LENGTH = 255;

/**
 * Longest accepted event tag, and most tags one event may carry.  Both cap
 * the row-size and tag-index growth an application can cause from user input
 * (#131 family) — see `TagValidator` for the full set of risks tag validation
 * closes.
 */
export const MAX_TAG_LENGTH = 255;
export const MAX_TAGS_PER_EVENT = 64;

/** Sequence-number padding — matches `Number.MAX_SAFE_INTEGER`'s 16 digits with headroom. */
export const SEQ_PADDING = 20;
