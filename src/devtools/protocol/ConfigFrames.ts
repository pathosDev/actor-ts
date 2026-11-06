/**
 * The `config.resolved` pull (#553) — every HOCON key, its effective
 * value, and which layer put it there.
 *
 * "Why is this setting not what I wrote?" is a question with six possible
 * answers — the bundled default won, the project's own `reference.conf` won,
 * `application.conf` won, the active profile won, the secrets file won, or a
 * code override won — and a merged tree alone cannot tell you which.  So the
 * panel reports the source per key rather than only the value, and the
 * environment variables that supplied it.
 */

/**
 * Which layer a key's effective value came from.
 *
 * Six names for the eight layers `Config.load` merges (#1546, #1785): a key
 * the secrets file's active profile set is reported as `secrets`, because
 * what a reader needs to know about it is that it came from the secrets file
 * — its value is withheld either way — not which block of that file held it,
 * and the project `reference.conf`'s profile reports as `project-reference`
 * the same way.  `reference` is the `reference.conf` bundled with actor-ts.
 * Widened from three names in protocol version 2, and to six before that
 * version was released.
 */
export type ConfigSource = 'reference' | 'project-reference' | 'application' | 'profile' | 'secrets' | 'override';

/** One resolved key. */
export type ResolvedConfigEntry = {
  /** Full dotted path, e.g. `actor-ts.cluster.seed-nodes`. */
  readonly path: string;
  /**
   * The effective value, sanitised for the wire.
   *
   * Lists and nested objects arrive as they are — a seed-node list is a
   * list, and flattening it to a string would make it unreadable exactly
   * where reading it matters.
   */
  readonly value: unknown;
  /** Which layer won. */
  readonly source: ConfigSource;
  /**
   * True when a lower layer also set this key.
   *
   * The interesting keys in a misbehaving system are the overridden ones,
   * and a source alone does not say whether anything was displaced.
   */
  readonly overridden: boolean;
  /** True when the value was cut to fit the wire limits. */
  readonly truncated: boolean;
  /**
   * The environment variables whose values make up the effective value, by
   * name, sorted (#1788) — read directly, through a reference to another
   * key, or as a piece of a concatenation.  Absent when no variable supplied
   * it.  Names only: a value one of them names as a credential arrives as
   * {@link CONFIG_REDACTED}, and this is what says why.
   */
  readonly variables?: ReadonlyArray<string>;
};

/** What `config.resolved` answers. */
export type ResolvedConfigResult = {
  readonly entries: ReadonlyArray<ResolvedConfigEntry>;
  /**
   * Where `application.conf` was read from, or `null` when there was none.
   *
   * Shown because "my file is being ignored" and "my file says something
   * else" are different problems, and the path is what separates them.
   */
  readonly applicationPath: string | null;
  /**
   * The active config profile, or `null` when none was selected (#1546).
   * Optional, as a field added to an answer is.
   */
  readonly profile?: string | null;
  /**
   * Where the secrets file was read from, or `null` when none was read
   * (#1546) — "read from", like {@link applicationPath}, so a path here
   * always names a file that was there.
   */
  readonly secretsPath?: string | null;
  /**
   * Where the project's own `reference.conf` was read from, or `null` when
   * none was read (#1785) — "read from", like {@link applicationPath}.
   */
  readonly referencePath?: string | null;
  /**
   * Where the `.env` file whose variables answered substitutions was read
   * from, or `null` when none was read (#1785).
   */
  readonly environmentFilePath?: string | null;
  /**
   * False when this config was not built by `Config.load` and so has no
   * layers to attribute against — every entry is then reported as
   * `reference`, which would be a guess rather than an answer.
   */
  readonly attributed: boolean;
};

/**
 * The key-name rule that redacts a value before it leaves the process — its
 * whole words, its glued spellings and the words it reads only inside a
 * longer name — its exemptions, and what a withheld value is replaced with.
 *
 * Re-exported rather than declared: all five now also guard the boot config
 * dump (#867), which is core and imports nothing from `src/devtools/`, so
 * the declarations live in `src/util/Constants.ts` — the one tier two
 * subsystems may share.  The names stay here because `<redacted>` is wire
 * vocabulary the panel compares against, and a protocol constant that
 * moved would be a protocol change.
 *
 * The exemption list travels with the pattern deliberately: a client that
 * reads one to explain why a value is missing needs the other to explain why
 * one it expected to be missing is not.  Neither explains every missing
 * value, though: a value the secrets file set is withheld whatever its key
 * is called (#1546), and arrives with `source: 'secrets'` — or `'override'`,
 * when code replaced a key the secrets file had set — and a value a variable
 * named by this rule supplied arrives with that variable among its
 * `variables` (#1788).
 */
export {
  CONFIG_REDACTED,
  CONFIG_SECRET_PATTERN,
  CONFIG_SECRET_COMPOUND_PATTERN,
  CONFIG_SECRET_WORDS_IN_LONGER_NAMES,
  CONFIG_NEVER_REDACTED_PATHS,
} from '../../util/Constants.js';
