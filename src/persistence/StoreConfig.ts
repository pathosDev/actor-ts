import type { Config } from '../config/Config.js';

/**
 * The seam through which a persistence plug-in reads its own HOCON block
 * (#872).
 *
 * Until this existed, nothing under `src/persistence/` read configuration at
 * all: `PersistenceExtension` resolved two plugin *ids* and every store took
 * its settings constructor-only, so a table name, a retention bound or a
 * database path could only be changed by editing code.
 *
 * The block a plug-in reads is named by the id it was registered under — the
 * framework's rule that a plugin id *is* its config section — which is why
 * every reader takes a `blockRoot` rather than hard-coding a path: a plug-in
 * registered under a custom id reads a custom block, and the two cannot drift
 * apart.  {@link storeLeaf} is what makes that work without a second copy of
 * the leaf names: it rebases a canonical `ConfigKeys` path onto the block in
 * force, so `ConfigKeys` stays the single place a leaf is spelled.
 *
 * Modelled on `src/logging/SinkConfig.ts`, which is the same problem already
 * solved for a family of plug-in blocks — with one deliberate difference.
 * `sinkLeaf` takes the leaf as a string literal at the call site, so its
 * `ConfigKeys` entries are documentation rather than the thing being read.
 * That is a shape `NoDeadConfigKeys` cannot check: its `coveringAccessor`
 * falls back to the nearest root, so a leaf under a block root passes the
 * guard whether or not anything reads it.  Rebasing keeps the constants
 * load-bearing.
 *
 * **Only scalars are readable.**  A pool, a driver, a serializer, a pre-opened
 * database handle and a client are live objects; they have no HOCON spelling
 * and deliberately no leaf, so a config file cannot reach them.  The same is
 * true of anything carrying key material.
 *
 * **Leaf naming is kebab-case, mapped to the camelCase field by the reader** —
 * `events-table` → `eventsTable`, `busy-timeout` → `busyTimeoutMs`.  That is
 * the dominant convention (`GelfSinkOptions`' `host-name` → `hostName`,
 * `ClusterOptions`' `gossip-interval` → `gossipIntervalMs`).  The camelCase
 * blocks under `cache.in-memory` and `http.websocket` are the exception, and
 * `Reference.ts` justifies each by the block being passed through wholesale —
 * a justification unavailable here, since the object-valued fields have to be
 * filtered out either way.
 *
 * **An absent leaf is omitted, never written as `undefined`.**  That is what
 * lets the result be spread under explicit options without shadowing them:
 * `mergeOptions` drops `undefined` from a layer, but a consumer that spreads
 * the reader's output directly would not, and the difference is invisible to
 * `toEqual`.
 */

/**
 * Rebase a canonical `ConfigKeys` leaf path onto the block root a plug-in was
 * actually registered under.
 *
 * `storeLeaf('actor-ts.persistence.journal.app', keys.root, keys.eventsTable)`
 * yields `actor-ts.persistence.journal.app.events-table`.  When the plug-in
 * runs under its canonical id — the overwhelmingly common case — the canonical
 * path is returned unchanged.
 */
export function storeLeaf(blockRoot: string, canonicalRoot: string, canonicalLeafPath: string): string {
  if (blockRoot === canonicalRoot) return canonicalLeafPath;
  return `${blockRoot}${canonicalLeafPath.slice(canonicalRoot.length)}`;
}

/**
 * Read a string leaf, treating `""` as **unset**.
 *
 * The empty string is how a block publishes the *shape* of a coordinate an
 * operator has to supply — a database path, a connection URL — without the
 * placeholder becoming a value.  Passed through verbatim it would be a value:
 * `''` is a legal SQLite path (an anonymous on-disk database), so a published
 * placeholder would silently outrank the store's own default rather than fall
 * through to it.  Same idiom as `readGelfSinkOptionsFromConfig`'s `url`.
 */
export function readStoreString(config: Config, path: string): string | undefined {
  if (!config.hasPath(path)) return undefined;
  const raw = config.getString(path);
  return raw === '' ? undefined : raw;
}

/**
 * Read an identifier leaf — a table or collection name.
 *
 * Distinct from {@link readStoreString} only in that `""` is *not* special: an
 * empty identifier is a mistake rather than a placeholder, and passing it
 * through is what lets `assertSafeIdentifier` refuse it by name at
 * construction, instead of the store quietly falling back to the built-in
 * table and writing somewhere the operator did not ask for.
 */
export function readStoreIdentifier(config: Config, path: string): string | undefined {
  return config.hasPath(path) ? config.getString(path) : undefined;
}

/** Read an integer leaf — a count or a bound. */
export function readStoreInt(config: Config, path: string): number | undefined {
  return config.hasPath(path) ? config.getInt(path) : undefined;
}

/** Read a boolean leaf — a switch. */
export function readStoreBoolean(config: Config, path: string): boolean | undefined {
  return config.hasPath(path) ? config.getBoolean(path) : undefined;
}

/**
 * Read a duration leaf as milliseconds.  The value carries the unit, so the
 * leaf name does not — `busy-timeout = 1s` maps to `busyTimeoutMs: 1000`.
 */
export function readStoreDuration(config: Config, path: string): number | undefined {
  return config.hasPath(path) ? config.getDuration(path) : undefined;
}
