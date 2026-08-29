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
 * Only *writes* are validated.  Streams that already carry an empty or
 * repeated tag stay readable — the same promise `assertValidPersistenceId`
 * makes for ids that predate its rules.
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
