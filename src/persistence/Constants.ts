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

/**
 * Random hex characters in a replicated event's id — 96 bits.
 *
 * `ReplicatedEventSourcedActor` used to identify an event cluster-wide by
 * `${replica}#${seqAtReplica}`, and both halves travelled in the broadcast
 * payload: the replica id is public and `seqAtReplica` is a plain counter, so a
 * peer could compute a victim's *future* ids by arithmetic.  A hit in the
 * deduplication set means *silently discard*, so pre-claiming `victim#42` made
 * every peer drop the victim's genuine 42nd event — permanently, because the
 * forgery is journaled and the set is snapshotted (#706).
 *
 * The same attack and the same remedy as `TAG_ENTROPY_CHARACTERS` in
 * `src/crdt/Constants.ts` (#722), and deliberately the same width.  Entropy is
 * what works here where transport binding does not: a replica id is *not*
 * required to be the sending node's address (a fixed region name is documented
 * and shipped), and the deduplication key has to stay byte-identical across a
 * re-delivery of the same event, which rules out anything derived locally.
 *
 * At 96 bits a replica persisting 10^9 events has a collision chance around
 * 6e-12, and `persist` draws against the observed set anyway.
 */
export const REPLICATED_EVENT_ID_ENTROPY_CHARACTERS = 24;

/**
 * Longest accepted replica id.
 *
 * A replica id is half the identity of every event: it prefixes the event id,
 * keys the vector clock, and is stored in the journal and in every snapshot
 * from then on.  Nothing bounded it, so one peer-supplied envelope could carry
 * a megabyte of replica id into permanent local state — and a vector clock is a
 * `Record<ReplicaId, number>`, so its keys are the same string under the same
 * bound.
 *
 * 255 matches {@link MAX_PERSISTENCE_ID_LENGTH}: the two are the same kind of
 * name in the same records, and a replica id that needs more than a node
 * address or a region name has a different problem.  The actor checks its *own*
 * `replicaId` against this at `preStart` too, so an over-long id fails loudly
 * on the node that chose it instead of being silently rejected by every peer.
 */
export const MAX_REPLICA_ID_LENGTH = 255;

/**
 * Longest accepted replicated event id.
 *
 * Derived rather than chosen: an id minted by `persist` is a replica id, a
 * `#`, and {@link REPLICATED_EVENT_ID_ENTROPY_CHARACTERS} of entropy, so a
 * fixed number small enough to be a useful bound would reject honest peers
 * whose replica id sits near {@link MAX_REPLICA_ID_LENGTH}.
 */
export const MAX_REPLICATED_EVENT_ID_LENGTH =
  MAX_REPLICA_ID_LENGTH + 1 + REPLICATED_EVENT_ID_ENTROPY_CHARACTERS;

/**
 * Most vector-clock entries a peer-supplied replicated envelope may carry.
 *
 * The clock is merged into local state unconditionally and never pruned, so
 * entries a peer invents are permanent: they inflate every subsequent envelope
 * this replica broadcasts and every snapshot it writes.  A cluster legitimately
 * grows one entry per replica ever seen, which is why this sits far above any
 * real deployment — the same figure and the same reasoning as
 * `MAX_CRDT_ENTRIES`.  Vector-clock garbage collection is #535; this only
 * stops one frame from doing the growing.
 */
export const MAX_VECTOR_CLOCK_ENTRIES = 4_096;

/**
 * Default ceiling on the canonical event history a `ReplicatedEventSourcedActor`
 * will accept from its peers, in events.
 *
 * The history is unbounded by construction — there is no compaction yet (#535)
 * — and every accepted remote envelope also costs one journal write and one
 * deduplication-set entry.  Worse, an out-of-order arrival refolds the whole
 * history, so N envelopes crafted to sort early cost O(N²) work.
 *
 * The bound is deliberately a **refusal, not an eviction**.  Dropping an entry
 * from the history changes the fold, and dropping one from the deduplication
 * set reopens double-apply, so silent eviction would trade a bounded leak for
 * unbounded divergence.  It also applies to the *remote* path only: refusing a
 * local `persist` would lose a write the caller was told succeeded, and the
 * local application is not the untrusted party here.
 *
 * 100 000 is above what the documented workload for this pattern reaches
 * (small-write / many-read entities) and far below the point at which a refold
 * storm is survivable, so an actor approaching it wants snapshots or a lower
 * `maxObservedEvents()` rather than a bigger number.
 */
export const DEFAULT_MAX_REPLICATED_OBSERVED_EVENTS = 100_000;

/**
 * Ceiling on one S3 object key, in UTF-8 bytes — 1024.
 *
 * A hard AWS API limit, not a tuning choice, and it is stated in *encoded
 * bytes* rather than characters: S3 answers a longer key with a
 * `KeyTooLongError`.  Checking it locally is what turns that into an
 * attributable rejection naming the offending key, instead of a 400 raised
 * several frames inside the SDK — the same reasoning the DynamoDB batch
 * limits above are chunked on rather than discovered.
 *
 * Enforced through `maxLengthBytes` and not `maxLength`, for exactly the
 * reason the limit is quoted in bytes: a key of 600 CJK characters is 1800
 * UTF-8 bytes, so a character count would let it through and leave the
 * rejection to the service.
 */
export const S3_MAX_KEY_LENGTH_BYTES = 1_024;

/**
 * How many offending keys `ReEncryptIncompleteError` carries when the
 * master-key rotation sweep refuses to certify a corpus.
 *
 * The sweep counts every malformed key it meets, but it only *retains* this
 * many: a corpus whose keys are all malformed would otherwise pin one string
 * per object for the lifetime of the error, turning a diagnostic into a
 * memory bound on the corpus size.  The exact total stays available as
 * `ReEncryptResult.skippedMalformedKey`, so nothing about the verdict depends
 * on the sample.
 *
 * Twenty is sized for the job the sample actually does — showing an operator
 * enough keys to recognise the *pattern* (one bad tenant prefix, one legacy
 * writer, a `keyPrefix` that does not match the store's) rather than
 * enumerating the work.
 */
export const MAX_REPORTED_MALFORMED_KEYS = 20;
