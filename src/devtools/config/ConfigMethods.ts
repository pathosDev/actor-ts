/**
 * The resolved-config inspector (#553).
 *
 * A merged HOCON tree answers "what is this setting now".  The question
 * that actually brings someone here is "why is it not what I wrote", and
 * that needs the layer as well as the value — the bundled default won,
 * `application.conf` won, or a code override won.
 *
 * A pull, not a stream: configuration is fixed when the system is built,
 * so there is nothing to push.  It is read once per panel open.
 */
import type { ActorSystem } from '../../ActorSystem.js';
import type { Config } from '../../config/Config.js';
import type { ConfigObject, ConfigValue } from '../../config/HoconParser.js';
import { toWireValue } from '../internal/WireSerializer.js';
import {
  CONFIG_REDACTED,
  CONFIG_SECRET_PATTERN,
  type ConfigSource,
  type ResolvedConfigEntry,
  type ResolvedConfigResult,
} from '../protocol/index.js';
import type { DevToolsServer } from '../DevToolsServer.js';

/** Wires `config.resolved` onto the server. */
export class ConfigMethods {
  constructor(private readonly system: ActorSystem) {}

  /** Register the method on `server`. */
  install(server: DevToolsServer): void {
    server.registerMethod('config.resolved', async () => this.onResolved());
  }

  private async onResolved(): Promise<ResolvedConfigResult> {
    const config = this.system.config;
    const layers = config._sources();
    const entries: ResolvedConfigEntry[] = [];

    for (const [path, value] of leaves(config.toJSON())) {
      const source = layers === null ? 'reference' : sourceOf(layers, path);
      entries.push(entryFor(path, value, source, layers === null
        ? false
        : displaced(layers, path, source)));
    }

    // Sorted, because a config file's own order is not the merged tree's and
    // the reader is looking for a key by name, not by where it happened to
    // land.
    entries.sort((left, right) => left.path.localeCompare(right.path));

    return {
      entries,
      applicationPath: layers?.applicationPath ?? null,
      attributed: layers !== null,
    };
  }
}

/** Which layer's value survived the merge for `path`. */
function sourceOf(
  layers: { reference: Config; application: Config; overrides: Config },
  path: string,
): ConfigSource {
  // Highest first: the merge resolves the same way, so this cannot
  // disagree with the tree it is describing.
  if (layers.overrides.hasPath(path)) return 'override';
  if (layers.application.hasPath(path)) return 'application';
  return 'reference';
}

/** True when a layer below the winning one also set `path`. */
function displaced(
  layers: { reference: Config; application: Config; overrides: Config },
  path: string,
  source: ConfigSource,
): boolean {
  if (source === 'override') {
    return layers.application.hasPath(path) || layers.reference.hasPath(path);
  }
  if (source === 'application') return layers.reference.hasPath(path);
  return false;
}

function entryFor(
  path: string,
  value: ConfigValue,
  source: ConfigSource,
  overridden: boolean,
): ResolvedConfigEntry {
  if (CONFIG_SECRET_PATTERN.test(path)) {
    // Redacted by PATH rather than by value: a password that happens to
    // look ordinary is still a password, and the key is what names it.
    return { path, value: CONFIG_REDACTED, source, overridden, truncated: false };
  }
  const wire = toWireValue(value);
  return { path, value: wire.value, source, overridden, truncated: wire.truncated };
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
