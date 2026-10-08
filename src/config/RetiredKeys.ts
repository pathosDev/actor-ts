import { ConfigError } from './Config.js';
import type { Config } from './Config.js';

/**
 * Retired spellings under one block, mapped to the spelling that replaced them.
 * Keys and values are paths **relative to the block's root**, which is passed
 * separately so one table serves every root that shares the block's shape
 * (`actor-ts.cache.in-memory` and every `actor-ts.cache.<name>.in-memory`, or
 * every broker's `actor-ts.io.broker.<name>`).
 *
 * Most entries are a single leaf (`maxEntries`).  A dotted entry reaches into a
 * group, and a rename needs one in two shapes: a renamed child under an
 * unchanged parent (`reconnect.initialDelayMs`), and the old child under a
 * renamed parent (`circuit-breaker.failureThreshold`).  The renamed group's own
 * entry (`circuitBreaker`) already refuses the old group whatever it holds, so
 * it is only the new group's old children that need entries of their own.
 */
export type RetiredLeaves = Readonly<Record<string, string>>;

/**
 * What the refusal says about the operator's code unless the table says
 * otherwise: true of a rename that moved only the HOCON spelling, which every
 * table is but the TCP framing caps' — those fields were renamed in code as
 * well, so that table passes a note of its own.
 */
const HOCON_ONLY_RENAME_NOTE =
  'The TypeScript field names and builder methods are unchanged, so no code change is needed.';

/**
 * Refuse a leaf that has been renamed, naming both spellings.
 *
 * There is no unknown-key detection anywhere in this package: an unrecognised
 * leaf sits in the parsed tree read by nobody, `mergeOptions` sees `undefined`
 * for the field, and the built-in default applies.  That is the worst
 * available failure mode for a rename, because the leaves that move are the
 * ones an operator sets *on purpose* — `max-frame-bytes`, `max-buffered-bytes`
 * and `max-response-bytes` are security caps the docs tell semi-trusted
 * deployments to lower, and silently restoring the framework default on an
 * upgrade is a security regression delivered by a spelling change.
 *
 * Throwing rather than warning follows what these blocks already do with a bad
 * *value*: an unknown `actor-ts.http.backend` is a `ConfigError` at startup,
 * because a configuration mistake should surface where the mistake is rather
 * than deep in a request path.  A WARN about a cap that is not in force is a
 * line in a container log nobody reads; startup is the last moment the
 * operator can still fix it.
 *
 * The message states the convention rather than the state of the block.  A
 * block can be converted in steps — the leaves every broker shares went first,
 * ahead of each protocol's own (#1443) — and "every leaf in this block is
 * kebab-case now" would be false in between.
 *
 * Each table is meant to be finite, not to accumulate across every future
 * rename, and each runs on **its own** clock: it can go once the release that
 * introduced *its* kebab spelling is two releases old, the same shape as
 * `NoDeadConfigKeys`' `KNOWN_DEAD_KEYS`.  The tables #1405 retired are #1444's
 * to remove; a block renamed in a later release keeps its table for two
 * releases after that one, whatever happens to the others.
 *
 * @param root the block the leaves live under, e.g. `actor-ts.http.client`
 * @param codeNote what the message tells the operator about their code.  The
 *   default says nothing in code changed, which holds for a rename of the HOCON
 *   spelling alone.  A table whose rename moved a TypeScript field or a builder
 *   method too passes its own, so the message never tells an operator to leave
 *   code alone that has stopped compiling.
 */
export function rejectRetiredLeaves(
  config: Config,
  root: string,
  retired: RetiredLeaves,
  codeNote: string = HOCON_ONLY_RENAME_NOTE,
): void {
  for (const [oldLeaf, newLeaf] of Object.entries(retired)) {
    const oldPath = `${root}.${oldLeaf}`;
    if (!config.hasPath(oldPath)) continue;
    throw new ConfigError(
      `${oldPath} has been renamed to ${root}.${newLeaf} — HOCON keys are `
      + 'kebab-case, and the retired spelling is read by nothing.  Rename the '
      + `key in your application.conf.  ${codeNote}`,
    );
  }
}
