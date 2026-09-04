import { ConfigError } from './Config.js';
import type { Config } from './Config.js';

/**
 * Retired leaf names under one block, mapped to the leaf that replaced them.
 * Keys and values are **leaf** names, not paths — the block's root is passed
 * separately so one table serves every root that shares the block's shape
 * (`actor-ts.cache.in-memory` and every `actor-ts.cache.<name>.in-memory`).
 */
export type RetiredLeaves = Readonly<Record<string, string>>;

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
 * The list is meant to be finite, not to accumulate across every future
 * rename: it can go once the release that introduced the kebab spelling is two
 * releases old, the same shape as `NoDeadConfigKeys`' `KNOWN_DEAD_KEYS`.
 *
 * @param root the block the leaves live under, e.g. `actor-ts.http.client`
 */
export function rejectRetiredLeaves(config: Config, root: string, retired: RetiredLeaves): void {
  for (const [oldLeaf, newLeaf] of Object.entries(retired)) {
    const oldPath = `${root}.${oldLeaf}`;
    if (!config.hasPath(oldPath)) continue;
    throw new ConfigError(
      `${oldPath} has been renamed to ${root}.${newLeaf} — every HOCON leaf in `
      + 'this block is kebab-case now, and the retired spelling is read by '
      + 'nothing.  Rename the key in your application.conf.  The TypeScript '
      + 'field names and builder methods are unchanged, so no code change is '
      + 'needed.',
    );
  }
}
