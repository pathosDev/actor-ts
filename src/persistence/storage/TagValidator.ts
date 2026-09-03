/**
 * Validate event tags before they enter a journal (security audit #136, #740).
 *
 * Tags originate from application code (`PersistentActor.tagsFor`), often
 * derived from user input (`'user-' + req.params.id`).  They are always
 * *bound* as query parameters — classic SQL/CQL injection is not reachable —
 * but four real risks remain, so tags are validated at the journal boundary
 * (the single choke point every backend shares):
 *
 *   - **CSV corruption:** `SqliteJournal` stores tags as a comma-separated
 *     column; a tag containing `,` would split into extra tags on read,
 *     letting a caller inject entries into a peer event's tag list.  Commas
 *     are therefore rejected.
 *   - **Log / control-character injection:** control characters (incl.
 *     newlines) in a tag corrupt logs and downstream text handling (#133/#134
 *     family).
 *   - **Cardinality / row-size explosion:** unbounded tag length or count
 *     bloats rows and tag indexes (#131 family), so both are capped —
 *     `MAX_TAG_LENGTH` and `MAX_TAGS_PER_EVENT` in `../Constants.js`.
 *   - **Backend divergence:** an empty or repeated tag means something
 *     different on every store, so one append has a different outcome
 *     depending on where it lands (#740).  An empty tag is skipped by the SQL
 *     tag index but survives in the CSV column those journals read back from,
 *     is indexed as a queryable `''` bucket on MongoDB, opens the single hot
 *     `tag = ''` partition on the Cassandra tag index — the shape that index
 *     exists to avoid — and makes DynamoDB reject the whole item, because a
 *     string-set member may be neither empty nor repeated.  A repeat is
 *     collapsed by Cassandra's `set<text>` and by the idempotent tag-table
 *     insert, kept verbatim by MongoDB and by the CSV column, and rejected
 *     outright by DynamoDB.  Both are rejected here, so the answer is the
 *     same everywhere.
 *
 * Rejecting rather than silently dropping is the deliberate half of that
 * last rule.  A `tagsFor` that returns `['tenant-1', '']` has a bug either
 * way; a caller that never sees an error keeps writing events its projection
 * will not find, and only learns of it when the same code is pointed at
 * DynamoDB and starts failing writes.  This is the same trade the comma rule
 * already makes: one rule at the choke point, set by the strictest backend,
 * beats three copies of a filter that can drift apart again.
 *
 * Only *writes* are held to the list above.  Streams that already carry an
 * empty or repeated tag stay readable — the same promise
 * `assertValidPersistenceId` makes for ids that predate its rules.  The read
 * side has a guard of its own since #738, {@link assertValidFilterTags}, and
 * it is deliberately a much smaller one: it transfers only the two rules whose
 * reason is the query engine rather than the store.  Both live in this file so
 * the divergence is one thing to read rather than two policies to find.
 */
import { MAX_TAG_LENGTH, MAX_TAGS_PER_EVENT } from '../Constants.js';
import type { JournalEntry } from '../JournalTypes.js';

/** True if `s` contains a C0 control char (0x00-0x1F, incl. CR/LF/TAB) or DEL (0x7F). */
function hasControlCharacter(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate the tag list of every entry of one append, before any of them is
 * written.  Runs up front rather than inside the write loop so a batch whose
 * third event carries a bad tag never leaves the first two behind — the same
 * all-or-nothing shape the backends' transactions already have.
 *
 * Per entry is also what makes `MAX_TAGS_PER_EVENT` mean what its name says:
 * while `append` took one batch-wide list, the cap counted a batch (#631).
 */
export function assertValidEntryTags(entries: ReadonlyArray<JournalEntry<unknown>>): void {
  for (const entry of entries) assertValidTags(entry.tags);
}

/**
 * Check one event's tag list against every rule above.
 *
 * Exported so an application can check its own `tagsFor` output without
 * starting an actor — the same escape hatch `assertValidPersistenceId` gives
 * for ids, and the thing that makes the #740 tightening adoptable without a
 * trial run against production traffic.
 */
export function assertValidTags(tags: ReadonlyArray<string> | undefined): void {
  if (tags === undefined) return;
  if (tags.length > MAX_TAGS_PER_EVENT) {
    throw new Error(
      `too many tags on one event: ${tags.length} exceeds the ${MAX_TAGS_PER_EVENT}-tag limit`,
    );
  }
  const seen = new Set<string>();
  // Indexed rather than `for…of` so the empty-tag message can name a position:
  // `JSON.stringify('')` identifies nothing, and the offending entry is
  // usually the one slot of a `[category, subCategory ?? '']` left unfilled.
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index]!;
    if (tag.length === 0) {
      throw new Error(
        `invalid tag at index ${index}: an empty tag is not allowed `
        + '(it vanishes on one backend, becomes a queryable \'\' bucket on another, and fails the append on DynamoDB)',
      );
    }
    if (tag.length > MAX_TAG_LENGTH) {
      throw new Error(
        `tag too long: ${tag.length} characters exceeds the ${MAX_TAG_LENGTH}-character limit`,
      );
    }
    if (tag.includes(',')) {
      throw new Error(
        `invalid tag ${JSON.stringify(tag)}: commas are not allowed (they corrupt the CSV tag column)`,
      );
    }
    if (hasControlCharacter(tag)) {
      throw new Error(
        `invalid tag ${JSON.stringify(tag)}: control characters (including newlines) are not allowed`,
      );
    }
    // Last, so a tag that is both malformed and repeated reports the flaw the
    // caller can act on rather than the symptom.
    if (seen.has(tag)) {
      throw new Error(
        `invalid tag ${JSON.stringify(tag)}: duplicate tags are not allowed `
        + '(a DynamoDB string set rejects a repeated member, and the others silently collapse or keep it)',
      );
    }
    seen.add(tag);
  }
}

/** Name a rejected filter member's runtime type for the error message. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const runtimeType = typeof value;
  return runtimeType === 'object' || runtimeType === 'undefined'
    ? runtimeType
    : `a ${runtimeType}`;
}

/**
 * Validate one operator list of a read-side tag filter — the `all`, `any` or
 * `not` of a `TagFilterSpec` — before a backend builds a query out of it
 * (#738).  `operator` names the list, so the message points at the member the
 * caller has to fix.
 *
 * `TagFilter`'s `ReadonlyArray<string>` is erased at runtime, and an
 * application that derives a filter from request data hands over whatever its
 * body parser produced — Express, Fastify and Hono all turn `?tag[$ne]=x` into
 * an object.  Every other backend binds the value (SQLite through a prepared
 * statement, Cassandra as `WHERE tag = ?`), so a non-string is refused at the
 * driver.  MongoDB has no binding step: `MongoQuery` puts the value into the
 * filter document, where an object is read as an *operator expression*.
 * `{ all: [{ $ne: null }] }` becomes `{ tags: { $ne: null } }`, which the
 * multikey `{ tags: 1, timestamp: 1 }` index can neither serve nor sort from,
 * so one request buys a full collection traversal, a blocking in-memory sort
 * and every surviving document materialised into the application heap — before
 * `eventMatchesTagFilter` discards all of them, because
 * `Array.prototype.includes` never matches an object against a string tag.
 *
 * **This is deliberately not the mirror image of {@link assertValidTags}.**  A
 * write creates storage; a filter is only ever compared against storage that
 * already exists.  So a write rule transfers here when its reason is the value
 * reaching the *query engine*, and does not when its reason is the value being
 * *stored*:
 *
 *   - **Type** — transfers; it is the rule above.  A non-string member could
 *     never have matched a stored tag anyway, so refusing it takes away no
 *     answer a caller could have received.
 *   - **Length** (`MAX_TAG_LENGTH`) — transfers.  It bounds what one request
 *     can push into a filter document and into an index-key comparison, and
 *     since every write has been held to the same cap since #136 a longer
 *     filter member can only ever match nothing.
 *   - **Comma** — does not transfer.  Its reason is SQLite's comma-separated
 *     `tags` column, which the read path splits rather than writes, so a comma
 *     in a filter corrupts nothing.  Refusing it would also refuse a
 *     legitimate diagnostic read of a document store whose array field really
 *     does hold `'a,b'`, put there by something that is not this library.
 *   - **Control characters** — does not transfer, for the same reason: the
 *     value is compared, never persisted or re-emitted, and it stays a bound
 *     scalar on every backend.
 *   - **Empty and duplicate** (#740) — do not transfer, and this is the one
 *     that matters.  The promise above is that only writes are validated, so a
 *     stream already carrying an empty tag stays readable — and `{ all: [''] }`
 *     is exactly the query #740 names for finding the `''` bucket a pre-#740
 *     MongoDB journal indexed.  A read-side empty rule would withdraw the
 *     diagnostic that the write-side rule is what makes necessary.  A repeat
 *     in a filter is merely redundant: `{ all: ['a', 'a'] }` asks the same
 *     question twice and gets the same answer, which is a normal outcome of
 *     concatenating two tag lists rather than a defect to fail on.
 *   - **`MAX_TAGS_PER_EVENT`** — does not transfer.  It counts one event's tag
 *     list, and a filter's list is a different population: `{ any: [...] }`
 *     over five hundred tenant tags is an ordinary union query even though no
 *     event may carry more than 64 tags.  A read-side count cap would need its
 *     own number and its own justification.
 *
 * Exported for the same reason `assertValidTags` is: an application that
 * builds filters from request data can check one ahead of the query.
 */
export function assertValidFilterTags(operator: string, tags: unknown): void {
  if (tags === undefined) return;
  if (!Array.isArray(tags)) {
    // Without this the member checks have nothing to iterate, and the erased
    // type fails quietly instead: `{ all: 'orders' }` walks the string, so
    // `eventMatchesTagFilter` asks for the tags 'o', 'r', 'd', … and answers
    // a question nobody posed.
    throw new Error(
      `invalid tag filter: ${operator} is ${describeValue(tags)}, not an array of tag strings`,
    );
  }
  for (let index = 0; index < tags.length; index++) {
    const tag: unknown = tags[index];
    if (typeof tag !== 'string') {
      throw new Error(
        `invalid tag filter: ${operator}[${index}] is ${describeValue(tag)}, not a string `
        + '(a non-string filter member matches no stored tag, and reaches MongoDB as an operator expression)',
      );
    }
    if (tag.length > MAX_TAG_LENGTH) {
      throw new Error(
        `invalid tag filter: ${operator}[${index}] is ${tag.length} characters, exceeding the `
        + `${MAX_TAG_LENGTH}-character limit every stored tag is held to`,
      );
    }
  }
}
