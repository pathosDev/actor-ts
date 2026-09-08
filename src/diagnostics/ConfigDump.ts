import type { Config, ConfigLayers } from '../config/Config.js';
import type { ConfigObject, ConfigValue } from '../config/HoconParser.js';
import {
  CONFIG_NEVER_REDACTED_PATHS,
  CONFIG_REDACTED,
  CONFIG_SECRET_PATTERN,
} from '../util/Constants.js';

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
 * Words after which the head of a config key's name moves in front of them.
 *
 * An English compound is head-final — `api-key` is a key — but a preposition
 * inverts that: `max-subscribers-per-key` is a count of *subscribers*, and the
 * `key` is only what they are counted per.  Reading it the other way is how a
 * tuning number came to print as `<redacted>` (#867).
 *
 * The particles of a phrasal verb are deliberately absent.  `in` would make
 * `sign-in-key` a `sign`, and a redaction with that hole in it is worse than
 * the false positive it removes.
 */
const NAME_PREPOSITIONS: ReadonlySet<string> = new Set(['per', 'of', 'by', 'for']);

/**
 * Which layer's value survived the merge for one key.
 *
 * The same three names `ConfigSource` carries in the DevTools protocol, and
 * deliberately a second declaration rather than an import: that one is wire
 * vocabulary a client validates against and this one is a local rendering
 * detail, so they are free to move apart.  They are structurally identical
 * today, which is what lets `ConfigMethods` assign one to the other without a
 * mapping table.
 */
export type ConfigLayerName = 'reference' | 'application' | 'override';

/** One leaf of the merged tree, with the layer that put it there. */
export type ResolvedConfigLeaf = {
  /** Full dotted path, e.g. `actor-ts.cluster.seed-nodes`. */
  readonly path: string;
  /**
   * The effective value, exactly as the merged tree holds it — **not**
   * redacted.  Redaction is the renderer's job, because the two renderers
   * replace a withheld value with different things: the panel sends
   * {@link CONFIG_REDACTED} on the wire, the dump prints it.
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
  /** True when {@link namesSecretConfigValue} read the key as a credential. */
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
  for (const [path, value] of leaves(config.toJSON())) {
    const layer = layers === null ? 'reference' : layerOf(layers, path);
    out.push({
      path,
      value,
      layer,
      displaced: layers === null ? false : displaced(layers, path, layer),
      secret: namesSecretConfigValue(path, value),
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
 * flattening the one shape an operator most needs to read.  Keys need no such
 * treatment: they are literals in a file, not substituted values.
 *
 * The header states what the body cannot: how many keys were withheld, and
 * whether the layer column is an answer or the unattributed fallback.
 */
export function configDumpLines(config: Config): string {
  const entries = resolveConfigLeaves(config);
  const attributed = attributedConfigLeaves(config);
  const applicationPath = config._sources()?.applicationPath ?? null;
  const redacted = entries.filter((entry) => entry.secret).length;

  const head = `configuration in effect — ${entries.length} keys`
    + `, ${redacted} redacted by key name`
    + `; application.conf: ${applicationPath ?? '(none)'}`
    + (attributed ? '' : '; layers unavailable, every key shown as reference');

  const body = entries.map((entry) => {
    const value = entry.secret ? CONFIG_REDACTED : JSON.stringify(entry.value);
    const origin = entry.displaced ? `${entry.layer}, overrides a lower layer` : entry.layer;
    return `  ${entry.path} = ${value}  [${origin}]`;
  });

  return [head, ...body].join('\n');
}

/**
 * Whether the key at `path` says its value is a credential.
 *
 * The single decision both renderers share, so a key withheld from the
 * DevTools panel cannot still reach a log file.  Three steps, in the order
 * that makes each one cheap to justify:
 *
 * 1. A key `reference.conf` ships and this project has read is answered from
 *    {@link CONFIG_NEVER_REDACTED_PATHS} rather than guessed at.
 * 2. A value that is a boolean carries nothing — see
 *    {@link HOCON_BOOLEAN_WORDS}.  This is the only thing the value gets a
 *    say in; everything else is decided by the name.
 * 3. **Every segment** of the path is read, not just the leaf, and each is
 *    reduced to its head word.  Every segment because a branch named
 *    `credentials` or `secrets` declares its whole subtree — dropping to the
 *    leaf alone would print `my-app.secrets.stripe` in full.  The head word
 *    because `passivation` is not `pass` and `key-prefix` is a prefix, which
 *    is what a bare substring test could not tell apart (#867).
 */
function namesSecretConfigValue(path: string, value: ConfigValue): boolean {
  if (CONFIG_NEVER_REDACTED_PATHS.has(path)) return false;
  if (statesOnlyABoolean(value)) return false;
  return path.split('.').some((segment) => CONFIG_SECRET_PATTERN.test(headWordOf(segment)));
}

/** True when `value` can only be one of HOCON's two boolean states. */
function statesOnlyABoolean(value: ConfigValue): boolean {
  if (typeof value === 'boolean') return true;
  return typeof value === 'string' && HOCON_BOOLEAN_WORDS.has(value.toLowerCase());
}

/**
 * The word in one path segment that says what the value **is**.
 *
 * Head-final, unless a {@link NAME_PREPOSITIONS} entry intervenes, in which
 * case the head is the word in front of it.  Taking the *first* preposition
 * and not the last is what keeps `max-requests-per-token-per-tenant` a count
 * of requests, and it errs the safe way besides: in `secret-per-tenant` the
 * word in front is the one that names a credential.
 */
function headWordOf(segment: string): string {
  const words = wordsOf(segment);
  if (words.length === 0) return '';
  const preposition = words.findIndex((word) => NAME_PREPOSITIONS.has(word));
  if (preposition > 0) return words[preposition - 1]!;
  return words[words.length - 1]!;
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

/** Which layer's value survived the merge for `path`. */
function layerOf(layers: ConfigLayers, path: string): ConfigLayerName {
  // Highest first: the merge resolves the same way, so this cannot
  // disagree with the tree it is describing.
  if (layers.overrides.hasPath(path)) return 'override';
  if (layers.application.hasPath(path)) return 'application';
  return 'reference';
}

/** True when a layer below the winning one also set `path`. */
function displaced(layers: ConfigLayers, path: string, layer: ConfigLayerName): boolean {
  if (layer === 'override') {
    return layers.application.hasPath(path) || layers.reference.hasPath(path);
  }
  if (layer === 'application') return layers.reference.hasPath(path);
  return false;
}

/**
 * Every leaf in the tree, as dotted paths.
 *
 * An array is a leaf: `seed-nodes` is one setting whose value is a list,
 * and splitting it into `seed-nodes.0` and `seed-nodes.1` would turn one
 * answer into several that no one configured.
 */
function* leaves(tree: ConfigObject, prefix = ''): Generator<[string, ConfigValue]> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isBranch(value)) {
      yield* leaves(value, path);
      continue;
    }
    yield [path, value];
  }
}

function isBranch(value: ConfigValue): value is ConfigObject {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && !('__substitution' in value);
}
