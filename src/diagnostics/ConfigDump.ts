import type { Config, ConfigLayers } from '../config/Config.js';
import type { ConfigObject, ConfigValue } from '../config/HoconParser.js';
import { CONFIG_REDACTED, CONFIG_SECRET_PATTERN } from '../util/Constants.js';

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
  /** True when {@link CONFIG_SECRET_PATTERN} matched the path. */
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
      secret: CONFIG_SECRET_PATTERN.test(path),
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
