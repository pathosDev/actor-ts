import { PATH_TRAVERSAL_SEGMENTS } from '../../util/Constants.js';

/**
 * Validate a `persistenceId` before it becomes a storage key (security
 * audit #133).
 *
 * A persistence id is application-supplied and routinely derived from user
 * input (`'account-' + request.params.id`, a sharding entity id).  It is
 * always *bound* as a query parameter, so classic SQL/CQL injection is not
 * reachable — but the id is not only a value: it is the **name of a
 * stream**, and several backends build a structured key out of it.  The
 * risks that follow from that each map to one rule below.
 *
 *   - **Empty id.** Every backend would happily write under `''`, so a
 *     `persistenceId` some code path forgot to fill in silently shares one
 *     stream with every other actor that forgot the same thing.
 *   - **Length.** The relational DDL declares `persistence_id
 *     VARCHAR(255)` / `NVARCHAR(255)` and makes it part of the primary
 *     key, so a longer id is either truncated (two ids collapsing onto one
 *     stream) or rejected deep inside a driver.  {@link
 *     MAX_PERSISTENCE_ID_LENGTH} is that width, not one more.
 *   - **Path separators.** The object-storage stores lay an id out as a
 *     *directory*: `<prefix><persistenceId>/<seq>.json`, and read it back
 *     by listing the prefix `<prefix><persistenceId>/`.  A `/` in the id
 *     therefore nests one stream *inside* another — `a`'s listing then
 *     also returns `a/b`'s snapshots, and since the seq is parsed off the
 *     key's tail, `loadLatest` hands actor `a` actor `a/b`'s state and
 *     `delete` prunes it.  `\` is a separator too on the filesystem
 *     backend under Windows.  Same reasoning, same rule as
 *     `assertValidName` for actor names (#134): a separator does not make
 *     a name look wrong, it changes the *structure* the name sits in.
 *   - **`.` / `..`.** Traversal meaning rather than a separator, and the
 *     same consequence one level up.  (The filesystem backend's own key
 *     validator already rejects a `..` *segment*; this closes the id
 *     before it reaches any backend that does not.)
 *   - **Control characters.** Ids are interpolated into log lines and
 *     trace spans on every recovery and every persist, so a newline lets a
 *     caller forge log records.
 *
 * **What is deliberately allowed.**  `,` is not a delimiter for ids: the
 * comma-separated column in `SqliteJournal` carries *tags*, and the id is
 * a separate bound column (`assertValidTags` owns that rule).  `|` is not
 * either: `OffsetStore` joins keys as
 * `<projection>|seq|<persistenceId>` with the id **last**, so a `|` inside
 * it cannot split off an extra field, nothing anywhere splits an id back
 * apart, and the repository's own chat example ships
 * `dm-channel-alice|bob` as a legitimate id.  Banning a character that
 * costs a real use case and closes no hole is the wrong trade.
 *
 * **Read paths deliberately do not validate.**  Only writes are refused,
 * so data already stored under an id that is invalid under these rules
 * stays readable — `journal.read(oldId, 1)` still returns it, which is
 * what makes this breaking change recoverable.
 */

/**
 * Longest accepted id — the width of the `persistence_id` column in every
 * relational dialect's DDL.  Anything longer cannot round-trip.
 */
export const MAX_PERSISTENCE_ID_LENGTH = 255;

/**
 * True when `persistenceId` contains a C0 control character or DEL.
 *
 * A codepoint scan rather than a regex, for the reason `ActorPath` gives:
 * a character class for these would either embed literal control bytes —
 * making this source file read as binary to git — or depend on escape
 * sequences surviving every tool that rewrites the file.
 */
function hasControlCharacter(persistenceId: string): boolean {
  for (let index = 0; index < persistenceId.length; index++) {
    const code = persistenceId.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Why `persistenceId` is unusable as a storage key, or `null` when it is
 * fine.
 *
 * Split out from {@link assertValidPersistenceId} so a caller that owes
 * its own error type can reuse the rules rather than restate them —
 * `DurableStateOptionsValidator` turns the same reason into an
 * `OptionsError`, because there the id arrives as an option and the
 * options layer owns that failure.
 */
export function persistenceIdRejection(persistenceId: string): string | null {
  if (typeof persistenceId !== 'string' || persistenceId.length === 0) {
    return 'must be a non-empty string';
  }
  if (persistenceId.length > MAX_PERSISTENCE_ID_LENGTH) {
    return `must be at most ${MAX_PERSISTENCE_ID_LENGTH} characters `
      + `(got ${persistenceId.length}) — the width of the persistence_id column`;
  }
  if (persistenceId.includes('/') || persistenceId.includes('\\')) {
    return 'must not contain a path separator ("/" or "\\") — object-storage '
      + 'keys use it to separate one stream from the next';
  }
  if (PATH_TRAVERSAL_SEGMENTS.has(persistenceId)) {
    return 'must not be "." or ".."';
  }
  if (hasControlCharacter(persistenceId)) {
    return 'must not contain control characters (including newlines)';
  }
  return null;
}

/**
 * Reject a `persistenceId` that would corrupt the storage key it becomes.
 *
 * `origin` names the site that supplied the id (`'PersistentActor'`, a
 * journal class name) — an invalid id is otherwise hard to attribute,
 * because by the time a backend sees it the declaring actor is several
 * frames away.
 */
export function assertValidPersistenceId(persistenceId: string, origin?: string): void {
  const reason = persistenceIdRejection(persistenceId);
  if (reason === null) return;
  const where = origin === undefined ? '' : ` (${origin})`;
  throw new Error(`Invalid persistenceId ${JSON.stringify(persistenceId)}${where}: ${reason}`);
}
