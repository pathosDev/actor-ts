import { ConfigError, isPlainObject, type Config, type ConfigObject } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';

/**
 * The key tree {@link refuseUnknownPersistenceKeys} derives what it accepts
 * from — `ConfigKeys.persistence`, unless a caller hands it another.  Typed by
 * the three selectors it reads by name; every other key in the tree is found
 * by walking it.
 */
export type PersistenceConfigKeys = {
  readonly journal: { readonly plugin: string };
  readonly snapshotStore: { readonly plugin: string };
  readonly durableState: { readonly plugin: string };
};

/** One axis block, and the one leaf of its own a reader takes there: its selector. */
type AxisKeys = {
  /** The block, `actor-ts.persistence.journal` and its two siblings. */
  readonly path: string;
  /** The selector's leaf within it, `plugin`. */
  readonly selectorLeaf: string;
};

/**
 * @internal Refuse a key under `actor-ts.persistence` that no reader takes
 * (#1729), naming the full key.
 *
 * Read by nothing, such a key was ignored, and the cost of that falls on the
 * selection: `actor-ts.persistence.journal.plugn = "…"` or a `jornal` block
 * left the axis on the in-memory store reference.conf selects, the startup
 * reported ready without a log line even at debug, and a journal kept in
 * memory had lost its events by the next restart.  So it is refused the way a
 * retired spelling is: a `ConfigError` saying what to do.
 *
 * **Two levels, the two the framework reads itself.**  Directly under
 * `actor-ts.persistence` go the three axis blocks and the behaviour keys;
 * directly in an axis block goes its selector, beside the blocks of its
 * plug-ins.  A block in an axis is a plug-in's settings — a third-party
 * plug-in's included, whose leaves the framework cannot know — so it is left
 * to the plug-in that reads it, and a misspelt leaf inside it is that
 * plug-in's to refuse.  Anything else in an axis is a value where only the
 * selector may stand: a misspelt selector, a plug-in's setting written a
 * level too high, or a plug-in's id written as a value where its block
 * belongs.
 *
 * **Derived from `keys`, never listed.**  The names accepted directly under
 * `actor-ts.persistence` are the first segment of every key `keys` declares
 * there, so a behaviour key `ConfigKeys` gains is accepted the day it is
 * declared, published in reference.conf or comment-only alike; an axis takes
 * the leaf of its own `plugin` entry.  The plug-in ids an axis group also
 * declares (`journal.in-memory`, `durable-state.object-storage`) are not
 * leaves: a plug-in's id is its config section, so written there they are a
 * block and pass as one.
 *
 * Nothing at all under `actor-ts.persistence`, or a value standing where that
 * block or an axis block belongs, gives this nothing to read, and a selector
 * passes whatever it holds.  Those are the selection reader's to refuse, with
 * messages of their own — which is what lets the extension run this check
 * before the reader without taking one of the reader's refusals over.
 */
export function refuseUnknownPersistenceKeys(config: Config, keys: PersistenceConfigKeys = ConfigKeys.persistence): void {
  const axes = [keys.journal.plugin, keys.snapshotStore.plugin, keys.durableState.plugin].map(axisOf);
  // `ConfigKeys.persistence` has no root of its own (its JSDoc says why), so
  // the root is the block the axes hang in.
  const root = parentOf(parentOf(keys.journal.plugin));
  const rootBlock = blockAt(config, root);
  if (rootBlock === undefined) return;
  const taken = namesDirectlyUnder(root, keys);
  for (const name of Object.keys(rootBlock)) {
    if (!taken.has(name)) throw new ConfigError(notTakenUnderRoot(pathOf(root, name), root, axes, taken));
  }
  for (const axis of axes) {
    const axisBlock = blockAt(config, axis.path);
    if (axisBlock === undefined) continue;
    for (const [name, value] of Object.entries(axisBlock)) {
      if (name === axis.selectorLeaf || isPlainObject(value)) continue;
      throw new ConfigError(notTakenInAxis(pathOf(axis.path, name), axis));
    }
  }
}

function axisOf(selector: string): AxisKeys {
  return { path: parentOf(selector), selectorLeaf: selector.slice(selector.lastIndexOf('.') + 1) };
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('.'));
}

/** The first segment below `root` of every key `keys` declares under it. */
function namesDirectlyUnder(root: string, keys: PersistenceConfigKeys): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      if (node.startsWith(`${root}.`)) names.add(node.slice(root.length + 1).split('.')[0]!);
    } else if (typeof node === 'object' && node !== null) {
      for (const child of Object.values(node)) visit(child);
    }
  };
  visit(keys);
  return names;
}

/** The block at `path`, or `undefined` when nothing is there or a value stands where it belongs. */
function blockAt(config: Config, path: string): ConfigObject | undefined {
  if (!config.hasPath(path)) return undefined;
  try {
    return config.getObject(path);
  } catch (error) {
    if (error instanceof ConfigError) return undefined;
    throw error;
  }
}

/**
 * `name` appended to `parent` as HOCON spells it: bare when it is a plain
 * word, quoted when it holds a dot or anything else a bare key cannot, so the
 * key named is the key written.
 */
function pathOf(parent: string, name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? `${parent}.${name}` : `${parent}.${JSON.stringify(name)}`;
}

function notTakenUnderRoot(key: string, root: string, axes: readonly AxisKeys[], taken: ReadonlySet<string>): string {
  const axisNames = axes.map((axis) => axis.path.slice(root.length + 1));
  const otherNames = [...taken].filter((name) => !axisNames.includes(name));
  return `Config at "${key}" is not a key ${root} takes — it takes the ${listOf(axisNames)} blocks and `
    + `${listOf(otherNames)}.  Read by nothing, it would leave a default in force, so it is refused rather `
    + 'than ignored: correct the spelling, or move a plug-in\'s settings into its block under the axis it '
    + `serves, such as ${axes[0]!.path}.<plug-in> { … }.`;
}

function notTakenInAxis(key: string, axis: AxisKeys): string {
  const blockName = axis.path.slice(axis.path.lastIndexOf('.') + 1);
  return `Config at "${key}" is not a key the ${blockName} block takes — it takes ${axis.selectorLeaf} = `
    + `"<plugin id>" beside the blocks of its plug-ins.  Read by nothing, it would leave the store its `
    + `${axis.selectorLeaf} field selects in force, so it is refused rather than ignored: correct the spelling, `
    + `or move a plug-in's settings into its block, ${axis.path}.<plug-in> { … }.`;
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
