/**
 * Validate event tags before they enter a journal (security audit #136).
 *
 * Tags originate from application code (`PersistentActor.tagsFor`), often
 * derived from user input (`'user-' + req.params.id`).  They are always
 * *bound* as query parameters — classic SQL/CQL injection is not reachable —
 * but three real risks remain, so tags are validated at the journal boundary
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
 *     bloats rows and tag indexes (#131 family), so both are capped.
 *
 * Empty tags are ignored here — every backend already skips them on write.
 */
export const MAX_TAG_LENGTH = 255;
export const MAX_TAGS_PER_EVENT = 64;

/** True if `s` contains a C0 control char (0x00-0x1F, incl. CR/LF/TAB) or DEL (0x7F). */
function hasControlCharacter(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function assertValidTags(tags: ReadonlyArray<string> | undefined): void {
  if (tags === undefined) return;
  if (tags.length > MAX_TAGS_PER_EVENT) {
    throw new Error(
      `too many tags on one event: ${tags.length} exceeds the ${MAX_TAGS_PER_EVENT}-tag limit`,
    );
  }
  for (const tag of tags) {
    if (tag.length === 0) continue; // skipped by every backend on write
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
  }
}
