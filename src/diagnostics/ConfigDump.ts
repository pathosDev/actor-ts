import type { Config, ConfigLayers } from '../config/Config.js';
import type { ConfigObject, ConfigValue } from '../config/HoconParser.js';
import {
  CONFIG_NEVER_REDACTED_PATHS,
  CONFIG_REDACTED,
  CONFIG_SECRET_PATTERN,
} from '../util/Constants.js';
import { redactUrlCredentials } from '../util/RedactUrlCredentials.js';

/**
 * The six spellings `Config.getBoolean` accepts, and the reason the value of
 * a leaf can veto its key.
 *
 * A boolean carries no secret whatever the key is called: there are two
 * states, both public, and `<redacted>` in their place is pure noise —
 * `management.auth-protect-health = false` told a reader nothing they did not
 * already know (#867).  Kept in lockstep with `Config.getBoolean` on purpose:
 * a spelling that file accepts and this one does not is a key an operator set
 * to a boolean and still cannot read back.
 */
const HOCON_BOOLEAN_WORDS: ReadonlySet<string> = new Set([
  'true', 'yes', 'on', 'false', 'no', 'off',
]);

/**
 * Which layer's value survived the merge for one key.
 *
 * Five names for the six layers `Config.load` merges (#1546) — see
 * {@link LAYERS_LOWEST_FIRST} for which name each layer is reported under.
 *
 * The same five names `ConfigSource` carries in the DevTools protocol, and
 * deliberately a second declaration rather than an import: that one is wire
 * vocabulary a client validates against and this one is a local rendering
 * detail, so they are free to move apart.  They are structurally identical
 * today, which is what lets `ConfigMethods` assign one to the other without a
 * mapping table.
 */
export type ConfigLayerName = 'reference' | 'application' | 'profile' | 'secrets' | 'override';

/** One layer `Config.load` merged, and the name it is reported under. */
type NamedLayer = {
  readonly name: ConfigLayerName;
  readonly of: (layers: ConfigLayers) => Config;
};

/**
 * The six layers in merge order, lowest first, each with its reported name.
 *
 * Six layers, five names: the secrets file's active profile is reported as
 * `secrets`, as its root is.  What a reader needs to know about such a key is
 * that it came out of the secrets file — its value is withheld either way —
 * and the profile that put it there is in the header.  The application
 * file's profile keeps a name of its own, because there it is the answer to
 * "why is this not what my file's root says".
 */
const LAYERS_LOWEST_FIRST: ReadonlyArray<NamedLayer> = [
  { name: 'reference', of: (layers) => layers.reference },
  { name: 'application', of: (layers) => layers.application },
  { name: 'profile', of: (layers) => layers.applicationProfile },
  { name: 'secrets', of: (layers) => layers.secrets },
  { name: 'secrets', of: (layers) => layers.secretsProfile },
  { name: 'override', of: (layers) => layers.overrides },
];

/** One leaf of the merged tree, with the layer that put it there. */
export type ResolvedConfigLeaf = {
  /**
   * Full dotted path, e.g. `actor-ts.cluster.seed-nodes` — and a key that is
   * not a bare one in double quotes, as HOCON writes it: `my-app."stripe.live"`
   * is one key holding a dot, `my-app.stripe.live` two keys.  See
   * {@link pathOf}.
   */
  readonly path: string;
  /**
   * The effective value, exactly as the merged tree holds it — **not**
   * redacted, by any rule.  Redaction is the renderer's job, because the
   * two renderers replace a withheld value with different things: the panel
   * sends {@link CONFIG_REDACTED} on the wire, the dump prints it.  A value a
   * renderer does show goes through {@link withCredentialFieldsWithheld} and
   * then {@link withUrlCredentialsMasked} first.
   */
  readonly value: ConfigValue;
  /**
   * Which layer won.  `reference` for every leaf when the config was not
   * built by `Config.load` — see {@link attributedConfigLeaves}, which is
   * how a caller tells a real attribution from that fallback.
   */
  readonly layer: ConfigLayerName;
  /** True when a layer below the winning one also set this key. */
  readonly displaced: boolean;
  /**
   * True when a secrets layer holds this key — the secrets file's root or
   * its active profile, or the secrets layer of a load whose tree arrived as
   * the overrides — whichever layer won it (#1546).
   */
  readonly inSecretsFile: boolean;
  /**
   * True when the value is withheld: {@link inSecretsFile}, or
   * {@link namesSecretConfigValue} read the key as a credential.
   */
  readonly secret: boolean;
};

/**
 * Whether `config` can attribute its leaves at all.
 *
 * Only the object `Config.load` returns carries its layers; one built by
 * `parseString` has a single source and no precedence to explain.  Reporting
 * `reference` for all of it would then be a guess dressed as an answer, so
 * both renderers say so instead — the panel with a flag, the dump in its
 * header line.
 */
export function attributedConfigLeaves(config: Config): boolean {
  return config._sources() !== null;
}

/**
 * Every leaf of the merged tree, sorted by path, each carrying the layer it
 * came from.
 *
 * Sorted because a config file's own order is not the merged tree's, and a
 * reader is looking for a key by name rather than by where it happened to
 * land.
 */
export function resolveConfigLeaves(config: Config): ResolvedConfigLeaf[] {
  const layers = config._sources();
  const out: ResolvedConfigLeaf[] = [];
  for (const [segments, value] of leaves(config.toJSON())) {
    const path = pathOf(segments);
    const attribution: Attribution = layers === null
      ? { layer: 'reference', displaced: false }
      : attributionOf(layers, segments);
    const inSecretsFile = layers === null
      ? config._secretPaths().has(path)
      : heldBySecretsLayer(layers, segments, path);
    out.push({
      path,
      value,
      layer: attribution.layer,
      displaced: attribution.displaced,
      inSecretsFile,
      secret: inSecretsFile || namesSecretConfigValue(segments, path, value),
    });
  }
  out.sort((left, right) => left.path.localeCompare(right.path));
  return out;
}

/**
 * The boot dump `actor-ts.diagnostics.log-config-on-start` turns on, as the
 * one string it is logged as (#867).
 *
 * **One record, not one per key.**  A merged tree is a few hundred leaves;
 * that many records buries whatever else the log was saying and gives a
 * structured backend a few hundred rows with nothing to correlate them by.
 * Newlines inside one message survive both shipped loggers — `ConsoleLogger`
 * writes the string, `JsonLogger` escapes it into the `msg` field — so the
 * dump reaches a log aggregator as a single searchable event.
 *
 * **Values are JSON-encoded, and that is a guard rather than a formatting
 * choice.**  A config value can contain a newline — `application.conf` may
 * quote one, and `${?SOMETHING}` can substitute one out of the environment —
 * and an un-encoded value could then forge lines into the dump it is part of.
 * `JSON.stringify` escapes them, and it renders a list as a list instead of
 * flattening the one shape an operator most needs to read.  A key gets the
 * same treatment for the same reason: a quoted HOCON key may hold an escaped
 * newline too, so a key that is not a bare one prints quoted, escapes and all
 * — see {@link pathOf}.
 *
 * The header states what the body cannot: how many keys were withheld, and
 * why — their name, or the secrets file holding them — how many of the lists
 * it does print had a credential field withheld, how many of the values it
 * does print had a URL's credentials masked, the active profile, the two
 * files it looked for and whether each was there, and whether the layer
 * column is an answer or the unattributed fallback.
 */
export function configDumpLines(config: Config): string {
  const entries = resolveConfigLeaves(config);
  const attributed = attributedConfigLeaves(config);
  const layers = config._sources();
  // A key in the secrets file is counted there even when its name says
  // `password` too: the file is the stronger of the two reasons, and each
  // withheld key is counted once.
  const redactedByName = entries.filter((entry) => entry.secret && !entry.inSecretsFile).length;
  const redactedFromSecrets = entries.filter((entry) => entry.inSecretsFile).length;
  // A withheld key is never shown, so nothing in it is withheld or masked
  // again.  The two value-side counts are per kind of hiding: a list with a
  // withheld field AND a masked URL is in both, since each says something
  // different about what the line no longer shows.
  const fieldsWithheld = entries.map((entry) => (entry.secret ? entry.value : withCredentialFieldsWithheld(entry.value)));
  const shown = fieldsWithheld.map((value, index) => (entries[index]!.secret ? value : withUrlCredentialsMasked(value)));
  const withheldFields = entries.filter((entry, index) => fieldsWithheld[index] !== entry.value).length;
  const masked = shown.filter((value, index) => value !== fieldsWithheld[index]).length;

  const head = `configuration in effect — ${entries.length} keys`
    + `, ${redactedByName} redacted by key name`
    + `, ${redactedFromSecrets} redacted from a secrets file`
    + `, ${withheldFields} with credential fields withheld`
    + `, ${masked} with URL credentials masked`
    + `; profile: ${layers?.profile ?? '(none)'}`
    + `; application.conf: ${fileLabel(layers?.applicationPath ?? null, layers?.applicationFound ?? false)}`
    + `; secrets.conf: ${fileLabel(layers?.secretsPath ?? null, layers?.secretsFound ?? false)}`
    + (attributed ? '' : '; layers unavailable, every key shown as reference');

  const body = entries.map((entry, index) => {
    const value = entry.secret ? CONFIG_REDACTED : JSON.stringify(shown[index]);
    const origin = entry.displaced ? `${entry.layer}, overrides a lower layer` : entry.layer;
    return `  ${entry.path} = ${value}  [${origin}]`;
  });

  return [head, ...body].join('\n');
}

/**
 * `value` with the userinfo of every URL in it replaced by `***` — the half
 * of the redaction that reads the value rather than the key, applied by both
 * renderers to everything they show (#1458).
 *
 * The key-name half cannot catch a password inside a `dsn` or a
 * `${?REDIS_URL}`: nothing about the key says so, and by the time the merged
 * tree exists nothing about the value says where it came from.  A URL marks
 * its credential by syntax, though — `scheme://user:password@host` — so this
 * needs no guess about what a key means, and it is why
 * {@link CONFIG_SECRET_PATTERN} is not widened to `url` or `dsn` instead.
 *
 * `redactUrlCredentials` rather than `redactedUrlLabel`, deliberately.  The
 * first keeps scheme, host, port, path and query byte-identical, which is
 * what tells an operator which Redis is configured; the second normalises the
 * host, drops the query, and turns memjs's scheme-less `user:pass@host` into
 * a `user://pass@host` that looks like a URL it never was.  What neither
 * masks — a bare password under an innocent key, a query-string token, SQL
 * Server's `Password=` form, memjs's server list — prints, and both docs
 * pages say so.
 *
 * Every string the value holds is covered: a list is one leaf, so its
 * elements are masked one by one, and so are the fields of an object inside
 * it — a list of endpoints is the one shape that carries several credentials
 * at once.  Returns `value` itself when nothing in it needed masking, so a
 * caller can count what it masked by identity.
 */
export function withUrlCredentialsMasked(value: ConfigValue): ConfigValue {
  if (typeof value === 'string') return redactUrlCredentials(value);
  if (Array.isArray(value)) {
    const masked = value.map(withUrlCredentialsMasked);
    return masked.some((element, index) => element !== value[index]) ? masked : value;
  }
  if (typeof value === 'object' && value !== null) {
    const fields = Object.entries(value);
    const masked = fields.map(([key, field]) => [key, withUrlCredentialsMasked(field)] as const);
    return masked.some(([, field], index) => field !== fields[index]![1])
      ? Object.fromEntries(masked)
      : value;
  }
  return value;
}

/**
 * `value` with every field of an object inside it that names a credential
 * replaced by {@link CONFIG_REDACTED} — the key-name half of the redaction,
 * carried past the end of the path (found while #1458).
 *
 * A list is one leaf, so {@link namesSecretConfigValue} reads the path down to
 * the list and stops: `my-app.upstreams = [ { host = "db-1", password =
 * "hunter2" } ]` names no secret in its path, and both renderers printed the
 * password in full.  An object inside a list is read the way the tree above it
 * is — each field name by every word of it, a field that names a credential
 * withholding everything beneath it, a boolean never withheld — so a list and
 * the same settings written as paths withhold the same values.  Whatever a
 * credential-named field holds goes as one value, a list included, the way a
 * list leaf under a secret path does.
 *
 * Both renderers apply it before {@link withUrlCredentialsMasked}, and like
 * that one it returns `value` itself when nothing was withheld, so a caller
 * can count by identity.
 */
export function withCredentialFieldsWithheld(value: ConfigValue): ConfigValue {
  return fieldsWithheldBelow(value, false);
}

/** {@link withCredentialFieldsWithheld}, knowing whether a field above `value` named a credential. */
function fieldsWithheldBelow(value: ConfigValue, underCredential: boolean): ConfigValue {
  if (isBranch(value)) {
    const fields = Object.entries(value);
    const withheld = fields.map(
      ([name, field]) => [name, fieldsWithheldBelow(field, underCredential || namesCredential(name))] as const,
    );
    return withheld.some(([, field], index) => field !== fields[index]![1])
      ? Object.fromEntries(withheld)
      : value;
  }
  if (underCredential) return statesOnlyABoolean(value) ? value : CONFIG_REDACTED;
  if (Array.isArray(value)) {
    const withheld = value.map((element) => fieldsWithheldBelow(element, false));
    return withheld.some((element, index) => element !== value[index]) ? withheld : value;
  }
  return value;
}

/**
 * Whether the key `segments` lead to says its value is a credential — `path`
 * being the same key as {@link pathOf} spells it, for the one lookup that is
 * by spelling.
 *
 * The withholding decision both renderers share, so a key withheld from the
 * DevTools panel cannot still reach a log file — the masking one,
 * {@link withUrlCredentialsMasked}, is shared the same way, and so is
 * {@link withCredentialFieldsWithheld}, which reads the fields of an object
 * inside a list by this same rule.  Three steps, in the order that makes each
 * one cheap to justify:
 *
 * 1. A key `reference.conf` ships and this project has read is answered from
 *    {@link CONFIG_NEVER_REDACTED_PATHS} rather than guessed at.
 * 2. A value that is a boolean carries nothing — see
 *    {@link HOCON_BOOLEAN_WORDS}.  This is the only say the value has in
 *    whether a key is withheld; everything else is decided by the name.
 * 3. **Every word of every segment** of the path is read — see
 *    {@link namesCredential}.  Every segment because a branch named
 *    `credentials` or `secrets` declares its whole subtree — dropping to the
 *    leaf alone would print `my-app.secrets.stripe` in full.
 */
function namesSecretConfigValue(segments: readonly string[], path: string, value: ConfigValue): boolean {
  if (CONFIG_NEVER_REDACTED_PATHS.has(path)) return false;
  if (statesOnlyABoolean(value)) return false;
  return segments.some(namesCredential);
}

/**
 * Whether one key names a credential — a segment of a path, or the name of a
 * field in an object inside a list.  One function for both, so the two places
 * a key name is read cannot come to read it differently.
 *
 * **Any** whole word of the name, wherever it stands (#867).  Reading only
 * the word a name ends on looked like grammar — `api-key` is a key,
 * `key-prefix` a prefix — and printed `auth-header`, `secret-value`,
 * `password-plain` and `token-string` in full: the order of the words in a
 * name says nothing about which of them names the value.  What this rule
 * costs is a tuning value with a credential word in its name, a
 * `token-bucket-size`, read back as `<redacted>`; an unreadable number costs
 * less than a printed password, and the keys `reference.conf` ships that read
 * that way are named in {@link CONFIG_NEVER_REDACTED_PATHS}.  *Whole* words
 * still, so `passivation` is not `pass` and `keyspace` is not `key` — what a
 * substring test could not tell apart.
 */
function namesCredential(name: string): boolean {
  return wordsOf(name).some((word) => CONFIG_SECRET_PATTERN.test(word));
}

/** True when `value` can only be one of HOCON's two boolean states. */
function statesOnlyABoolean(value: ConfigValue): boolean {
  if (typeof value === 'boolean') return true;
  return typeof value === 'string' && HOCON_BOOLEAN_WORDS.has(value.toLowerCase());
}

/**
 * One path segment, lower-cased and cut into words.
 *
 * Kebab-case is this project's own convention, but the tree also carries an
 * application's keys and nothing forces those into it — so camel humps split
 * too, `APIKey` included.  A redaction that understands one spelling of
 * `apiKey` and not another is a redaction with a hole in it.
 */
function wordsOf(segment: string): string[] {
  return segment
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

/** Which layer won one key, and whether a layer below it also set the key. */
type Attribution = {
  readonly layer: ConfigLayerName;
  readonly displaced: boolean;
};

/**
 * The layer whose value survived the merge for `path`, and whether one below
 * it also set the path.
 *
 * Highest first: the merge resolves the same way, so this cannot disagree
 * with the tree it is describing.  "Below" is counted in the six layers, not
 * the five names, so a secrets-profile key over the secrets root's value of
 * the same key reports that it displaced one.
 *
 * Asked by `segments`, never by a dotted path: a quoted key holding a dot is
 * one key, and a dotted path would ask every layer about two (#1546).
 */
function attributionOf(layers: ConfigLayers, segments: readonly string[]): Attribution {
  for (let index = LAYERS_LOWEST_FIRST.length - 1; index >= 0; index--) {
    const winner = LAYERS_LOWEST_FIRST[index]!;
    if (!winner.of(layers)._hasPathSegments(segments)) continue;
    const displaced = LAYERS_LOWEST_FIRST.slice(0, index)
      .some((lower) => lower.of(layers)._hasPathSegments(segments));
    return { layer: winner.name, displaced };
  }
  return { layer: 'reference', displaced: false };
}

/**
 * Whether a secrets layer holds `path` — **any** of them, not only the one
 * that won it (#1546).
 *
 * The winning layer would be the obvious rule and is the wrong one.  A
 * WorkerMesh worker receives its main thread's whole effective tree as one
 * overrides object, so `override` wins every leaf of a worker's config, and a
 * rule keyed on the winner would print a secrets-file value under an innocent
 * name in that worker's boot dump.  A key the code overrode is withheld for
 * the same reason: whether the value that won is the secret is not something
 * this can know, and the file says the key is secret.
 *
 * A layer is asked by `segments`, as {@link attributionOf} asks it; the paths
 * a worker carries are compared as {@link pathOf} spells them, which is how
 * {@link secretLayerPaths} wrote them.  Either one keyed on a dot-joined path
 * prints a key the file quotes because it holds a dot — a host or a domain
 * name, the usual key of a map of credentials — in full.
 */
function heldBySecretsLayer(layers: ConfigLayers, segments: readonly string[], path: string): boolean {
  if (layers.secrets._hasPathSegments(segments) || layers.secretsProfile._hasPathSegments(segments)) return true;
  // The overrides may be a tree that already left a load — and with it the
  // secrets layer that load read.  Either as a loaded `Config` passed back
  // in, which is how code names a secrets file for a system
  // (`withConfig(Config.load({ secretsConfPath }))`) and which still carries
  // its own layers; or as a WorkerMesh worker's copy of its main thread's
  // tree, which carries the paths instead.
  const overrides = layers.overrides;
  if (overrides._secretPaths().has(path)) return true;
  const inner = overrides._sources();
  return inner !== null && heldBySecretsLayer(inner, segments, path);
}

/**
 * The leaf paths of `config` a secrets layer holds — the keys both renderers
 * withhold by layer rather than by name, sorted.
 *
 * What WorkerMesh hands each worker beside the effective tree (#1546), so a
 * worker whose own load cannot see the file still withholds what the file
 * set: computed over the merged leaves rather than the file's own, so the
 * worker withholds exactly the keys its main thread does.  Spelled as
 * {@link pathOf} spells them — the one spelling of a path that tells a key
 * holding a dot from two keys, which a list of strings has to.
 */
export function secretLayerPaths(config: Config): string[] {
  return resolveConfigLeaves(config).filter((leaf) => leaf.inSecretsFile).map((leaf) => leaf.path);
}

/** A file the loader looked for, as the dump header names it. */
function fileLabel(path: string | null, found: boolean): string {
  if (path === null) return '(none)';
  return found ? path : `${path} (not found)`;
}

/**
 * Every leaf in the tree, as the keys that lead to it.
 *
 * Keys, not a dotted path: a quoted HOCON key may hold a dot, and a path
 * joined by dots could no longer say where one key ends (#1546).
 *
 * An array is a leaf: `seed-nodes` is one setting whose value is a list,
 * and splitting it into `seed-nodes.0` and `seed-nodes.1` would turn one
 * answer into several that no one configured.
 */
function* leaves(
  tree: ConfigObject,
  prefix: readonly string[] = [],
): Generator<[readonly string[], ConfigValue]> {
  for (const [key, value] of Object.entries(tree)) {
    const segments = [...prefix, key];
    if (isBranch(value)) {
      yield* leaves(value, segments);
      continue;
    }
    yield [segments, value];
  }
}

/**
 * A key HOCON reads without quotes — the characters the parser's bare key
 * segment takes, which is why it is a copy of that test rather than a looser
 * one: a key printed bare here has to read back as the same key.
 */
const BARE_KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * `segments` as the path both renderers print: joined by `.`, and a key that
 * is not a bare one in double quotes, escaped the way a quoted HOCON string
 * is — `my-app."stripe.live"`, `"db.dsn"`.
 *
 * One spelling per path, and a different path never shares it, which is what
 * lets it stand for the keys where only a string travels: the paths
 * WorkerMesh carries to a worker, and {@link CONFIG_NEVER_REDACTED_PATHS}.
 * Joining with bare dots would print `my-app."region.name"` and
 * `my-app.region.name` as one key, and the quoting is HOCON's own, so a path
 * an operator copies out of the dump reads back as the key it came from.  It
 * is also what keeps a key from writing a line of the dump: a newline in one
 * prints as `\n`.
 */
function pathOf(segments: readonly string[]): string {
  return segments
    .map((segment) => (BARE_KEY_SEGMENT.test(segment) ? segment : JSON.stringify(segment)))
    .join('.');
}

function isBranch(value: ConfigValue): value is ConfigObject {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && !('__substitution' in value);
}
