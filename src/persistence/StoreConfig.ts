import { ConfigError, type Config } from '../config/Config.js';

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
 * `sinkLeaf` takes the leaf as a string literal at the call site, so
 * `ConfigKeys` lists only the sink roots and a leaf is spelled where it is
 * read: a misspelling there compiles, and surfaces only when
 * `NoDeadConfigKeys` finds the published leaf read by no registered reader
 * (#1425).  Rebasing a `ConfigKeys` path keeps each leaf spelled once, where
 * the compiler checks every use of it.
 *
 * **What is readable: scalars, string lists and one typed list — never an
 * object handed to a driver.**  Every reader here returns a value it built: a
 * string, a number, a switch, a duration, a size, a list of strings, or the
 * member of an enum its table maps a kebab-case word to.  The one list of
 * objects in the family, Cassandra's `replication.data-centers`, is read by a
 * helper beside its own reader that takes each entry field by field into the
 * map the keyspace DDL wants, so the HOCON node never leaves the reader —
 * `Config.getObject` hands out the config tree's own mutable node, and a
 * driver writing into what it was given would be writing into the system's
 * configuration.  The free-form driver objects (`poolConfig`,
 * `clientOptions`, `clientConfig`) therefore stay code-only, and what an
 * operator actually tunes gets a typed leaf instead (#1490).  A pool, a
 * driver, a serializer, a pre-opened database handle and a client are live
 * objects; they have no HOCON spelling and deliberately no leaf, so a config
 * file cannot reach them.  The same is true of anything carrying key
 * material.
 *
 * **Leaf naming is kebab-case, mapped to the camelCase field by the reader** —
 * `events-table` → `eventsTable`, `busy-timeout` → `busyTimeoutMs`.  That is
 * the project-wide convention (`GelfSinkOptions`' `host-name` → `hostName`,
 * `ClusterOptions`' `gossip-interval` → `gossipIntervalMs`), and since #1405
 * it has no exception: no block in the shipped file is passed through to a
 * driver with its camelCase keys.
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
 * placeholder becoming a value.  Passed through verbatim it would be a value
 * the operator never wrote: a SQLite store would refuse an empty path the
 * file only published (#1492), and the Postgres driver handed an empty URL
 * would connect to whatever its `PG*` environment variables name.  Read as
 * unset, a coordinate nobody supplied is reported as missing rather than as
 * a wrong value.  Same idiom as `readGelfSinkOptionsFromConfig`'s `url`.
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

/**
 * Read a string-list leaf, treating `[]` as **unset**.
 *
 * The list shape of {@link readStoreString}'s idiom, and it needs the same
 * treatment for the same reason: Cassandra's `contact-points` is the operator's
 * own seed list, published empty so the key's name and nesting are discoverable
 * without the placeholder becoming a value.  An empty seed list is not a
 * cluster to connect to — the driver would reject it — so passing `[]` through
 * would let a published placeholder outrank the seeds the register helper was
 * given.
 */
export function readStoreStringList(config: Config, path: string): string[] | undefined {
  if (!config.hasPath(path)) return undefined;
  const raw = config.getStringList(path);
  return raw.length === 0 ? undefined : raw;
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

/**
 * Read a size leaf as bytes.  The value carries the unit, as a duration's
 * does — `max-response-bytes = 64M` maps to `maxResponseBytes: 67108864` — and
 * {@link readStoreInt} cannot stand in for it: it refuses `64M` as no number,
 * and a bare byte count published to suit it would name no unit at all.
 */
export function readStoreBytes(config: Config, path: string): number | undefined {
  return config.hasPath(path) ? config.getBytes(path) : undefined;
}

/**
 * Read an enum leaf through the table of its values.
 *
 * Every HOCON value is kebab-case (`pay-per-request`), and what a store hands
 * its driver often is not (`PAY_PER_REQUEST`), so the table is the one place
 * the two spellings meet: its keys are what a config file may say, its values
 * what the reader returns.  Anything else is refused with a `ConfigError`
 * naming the leaf and the values it takes — the driver's own spelling too,
 * since reading that verbatim would make the file the one place the
 * kebab-case rule does not hold, and the message then names the value to
 * write instead.  Refusing here rather than passing the word on is what lets
 * the error name the *key*: the options validator downstream knows only the
 * field.  `Object.hasOwn` keeps an inherited name such as `toString` from
 * resolving to a member of `Object.prototype`.
 */
export function readStoreEnum<T>(config: Config, path: string, values: Readonly<Record<string, T>>): T | undefined {
  if (!config.hasPath(path)) return undefined;
  const raw = config.getString(path);
  if (Object.hasOwn(values, raw)) return values[raw];
  const codeSpelling = Object.entries(values).find(([, value]) => value === raw);
  throw new ConfigError(
    `${path} must be one of ${Object.keys(values).join(' | ')} (got ${JSON.stringify(raw)})`
    + (codeSpelling === undefined ? '' : ` — that is how code spells it; in a config file, write ${codeSpelling[0]}`),
  );
}
