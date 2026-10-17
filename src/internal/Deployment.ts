/**
 * The per-path deployment layer — `actor-ts.deployment."<path pattern>"`
 * (#868).
 *
 * An operator names actors by path and gives them a throughput and a mailbox
 * without editing a spawn site.  The layer sits between the spawn options and
 * the system-wide `actor-ts.actor.throughput` / `actor-ts.mailbox.default`,
 * one leaf at a time.  Keys are address-less (`/user/ingest`), as
 * `actor-ts.parallelism.offload` writes them, so a key keeps matching when
 * the system is renamed and inside a worker-mesh worker, whose system has a
 * name of its own; and they are path patterns in that block's grammar,
 * because the actors an operator most needs to reach — entities, routees,
 * WebSocket connections — have no static name.
 *
 * Two halves, both run once per system: {@link readDeploymentFromConfig}
 * checks the block and returns it as written, and {@link compileDeployment}
 * turns that into the index `ActorCell` asks once per spawn.  Not exported
 * from the package: the cell is the only consumer, and the block is
 * configured in HOCON, never in code — a code-level setter would be a second
 * way to say what `ActorOptions` already says at the spawn site.
 */
import type { ActorPath } from '../ActorPath.js';
import { Config, ConfigError, isPlainObject } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import type { ConfigValue } from '../config/HoconParser.js';
import type { BoundedMailboxOverflow } from '../mailbox/BoundedMailboxOptions.js';
import { compilePathPattern, type PathPattern } from '../parallelism/PathPattern.js';
import { PATH_TRAVERSAL_SEGMENTS } from '../util/Constants.js';

/**
 * What one entry sets.  A leaf the entry does not set is **absent**, never
 * `undefined`: the cell layers each field over the system layer with `??`,
 * and an entry is chosen whole, so an unset leaf has to fall through to the
 * system default rather than read as "set to nothing".
 */
export type DeploymentEntry = {
  /** User messages per dispatcher turn; already clamped to at least 1. */
  readonly throughput?: number;
  /** Queued user messages before the overflow policy acts; `0` = unbounded. */
  readonly mailboxCapacity?: number;
  readonly mailboxOverflow?: BoundedMailboxOverflow;
};

/** The block as written: each entry under its key, verbatim. */
export type DeploymentConfiguration = Readonly<Record<string, DeploymentEntry>>;

/**
 * The schema of one entry, by HOCON name.  Checked rather than ignored, for
 * the reason the coordinated-shutdown phases check theirs: `mailbox-size = 4`
 * under a path would leave the actor unbounded and say nothing, which is the
 * same class of defect as a documented key nothing reads.
 */
const ENTRY_LEAVES: ReadonlySet<string> = new Set(Object.values(ConfigKeys.deployment.entry));

/**
 * Read `actor-ts.deployment` into the record {@link compileDeployment} takes:
 * each entry under its key exactly as written, with only the leaves it sets.
 *
 * Read as an object and each entry through a `Config` of its own, not through
 * dotted paths: `Config.hasPath` splits on `.`, and an actor name may contain
 * one, so `/user/ingest.v2` would be read as a nesting that does not exist.
 *
 * Everything a block could get wrong is refused here, naming the key, so the
 * system does not start — for the reason `actor-ts.mailbox.default.overflow`
 * is refused where it is read: the mistake is in the config file, and an
 * entry that silently matched nothing, or a bound that failed at the first
 * spawn, would surface far from the line that caused it.  The one exception
 * is a throughput of 0 or below, which reads as 1, as `actor-ts.actor.throughput`
 * does: "as little batching as possible" has an honest nearest value.
 */
export function readDeploymentFromConfig(config: Config): DeploymentConfiguration {
  const root = ConfigKeys.deployment.root;
  if (!config.hasPath(root)) return {};
  const out: Record<string, DeploymentEntry> = {};
  for (const [key, raw] of Object.entries(config.getObject(root))) {
    refuseUnusableKey(key);
    out[key] = readEntry(key, raw);
  }
  return out;
}

/** `actor-ts.deployment."/user/x"` — how every refusal names the entry. */
function entryName(key: string): string {
  return `${ConfigKeys.deployment.root}.${JSON.stringify(key)}`;
}

/**
 * Refuse a key that cannot name an actor the layer applies to.  Each of these
 * would otherwise be an entry that matches nothing, which is the silence the
 * whole block is checked to prevent: actor names hold neither `/` nor `.` and
 * `..` (`ActorPath`'s own rule), so an empty or a traversal segment can never
 * match, and a single segment that is not `**` reaches only the root or a
 * guardian — the framework's own actors, which no entry reaches.
 */
function refuseUnusableKey(key: string): void {
  const name = entryName(key);
  if (!key.startsWith('/')) {
    throw new ConfigError(`${name}: a key is an absolute actor path pattern and must start with '/'`);
  }
  const segments = key.slice(1).split('/');
  if (segments.includes('')) {
    throw new ConfigError(`${name} has an empty segment ('//' or a trailing '/'), which no actor path has`);
  }
  if (segments.some((segment) => PATH_TRAVERSAL_SEGMENTS.has(segment))) {
    throw new ConfigError(`${name} has a '.' or '..' segment, which no actor is named`);
  }
  if (segments.length < 2 && !segments.includes('**')) {
    throw new ConfigError(
      `${name} can name only the root or a guardian, whose own actors no entry reaches — `
      + "name the actors below it instead ('/user/**' for every one of them)",
    );
  }
}

function readEntry(key: string, raw: unknown): DeploymentEntry {
  const name = entryName(key);
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${name} must be a block of throughput / mailbox-capacity / mailbox-overflow, not a bare value`);
  }
  for (const leaf of Object.keys(raw)) {
    if (!ENTRY_LEAVES.has(leaf)) throw new ConfigError(unknownLeafMessage(name, leaf));
  }
  const entry = Config.fromObject(raw);
  const leaves = ConfigKeys.deployment.entry;
  const out: { -readonly [K in keyof DeploymentEntry]?: DeploymentEntry[K] } = {};
  if (entry.hasPath(leaves.throughput)) {
    out.throughput = Math.max(1, integerLeaf(entry, name, leaves.throughput, raw));
  }
  if (entry.hasPath(leaves.mailboxCapacity)) {
    const capacity = integerLeaf(entry, name, leaves.mailboxCapacity, raw);
    if (capacity < 0) {
      throw new ConfigError(
        `${name}.${leaves.mailboxCapacity} must be 0 or above (got ${capacity}) — 0 leaves the actor unbounded`,
      );
    }
    out.mailboxCapacity = capacity;
  }
  if (entry.hasPath(leaves.mailboxOverflow)) {
    const overflow = raw[leaves.mailboxOverflow];
    if (typeof overflow !== 'string' || !isBoundedMailboxOverflow(overflow)) {
      throw new ConfigError(
        `${name}.${leaves.mailboxOverflow} must be one of drop-head | drop-new | reject (got ${JSON.stringify(overflow)})`,
      );
    }
    out.mailboxOverflow = overflow;
  }
  return out;
}

/**
 * The leaf as an integer, or a refusal under the entry's full name.  The
 * getter's own message names only the leaf inside the entry, which is not a
 * key anyone could find in their file.
 */
function integerLeaf(entry: Config, name: string, leaf: string, raw: Readonly<Record<string, ConfigValue>>): number {
  let value: number;
  try {
    value = entry.getNumber(leaf);
  } catch {
    throw new ConfigError(`${name}.${leaf} must be an integer (got ${JSON.stringify(raw[leaf])})`);
  }
  if (!Number.isInteger(value)) {
    throw new ConfigError(`${name}.${leaf} must be an integer (got ${value})`);
  }
  return value;
}

/** The refusal of a leaf outside the three, naming the kebab-case one a camelCase spelling meant. */
function unknownLeafMessage(name: string, leaf: string): string {
  const kebab = leaf.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const hint = kebab !== leaf && ENTRY_LEAVES.has(kebab) ? ` — HOCON keys are kebab-case: write ${kebab}` : '';
  return `${name}.${leaf} is not a deployment setting — expected one of `
    + `${[...ENTRY_LEAVES].join(', ')}${hint}`;
}

/** The three policies a `BoundedMailbox` takes — the list its validator checks. */
function isBoundedMailboxOverflow(value: string): value is BoundedMailboxOverflow {
  return value === 'drop-head' || value === 'drop-new' || value === 'reject';
}

/**
 * Compile a block into the index the cell asks, or `null` when it holds no
 * entry — which is every system that configures none, since the block ships
 * comment-only.  `null` and not an empty index, so that on such a system a
 * spawn pays one null check for the whole feature.
 */
export function compileDeployment(configuration: DeploymentConfiguration): DeploymentIndex | null {
  return Object.keys(configuration).length === 0 ? null : new DeploymentIndex(configuration);
}

/** A wildcard key, compiled once, with what ranks it against the others. */
type CompiledKey = {
  readonly key: string;
  readonly entry: DeploymentEntry;
  /** 1 for a key with a `*` but no `**` segment, 2 for one with a `**` segment. */
  readonly rank: number;
  /** The key up to its first `*`: every path the key matches starts with it. */
  readonly literalPrefix: string;
  readonly literalCharacters: number;
  readonly pattern: PathPattern;
};

/**
 * Most specific first: exact keys never get here (they are a map lookup and
 * win outright), then a `*` without a `**` segment before a `**` segment,
 * then the longer literal prefix, then more literal characters, then the
 * key's code-unit order — total, because keys are unique, so the answer never
 * depends on the order the configuration happened to list them in.
 */
function byPrecedence(a: CompiledKey, b: CompiledKey): number {
  return a.rank - b.rank
    || b.literalPrefix.length - a.literalPrefix.length
    || b.literalCharacters - a.literalCharacters
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function compileKey(key: string, entry: DeploymentEntry): CompiledKey {
  const segments = key.slice(1).split('/');
  const literalCharacters = key.length - key.split('*').length + 1;
  return {
    key,
    entry,
    rank: segments.includes('**') ? 2 : 1,
    literalPrefix: key.slice(0, key.indexOf('*')),
    literalCharacters,
    pattern: compilePathPattern(key),
  };
}

/**
 * The compiled block: one lookup per spawn of an actor the application wrote.
 *
 * Exact keys sit in a map; wildcard keys are compiled once and kept in
 * precedence order, so the first that matches is the answer.  Built for the
 * spawn path, where every allocation is paid per actor: the path is walked
 * into its names once and never rendered — `ActorPath.toString()` would
 * memoize a full `actor-ts://…` string on every path for good, and a plain
 * spawn renders none today — and a key is tested only after a prefix check on
 * the joined names rules it in.  Before any of that, the actor's own name is
 * checked against the keys' last segments, so a block that names a handful of
 * actors costs everyone else one set lookup.
 */
export class DeploymentIndex {
  private readonly exact = new Map<string, DeploymentEntry>();
  private readonly wildcards: ReadonlyArray<CompiledKey>;
  /** Some key's last segment is `*` or `**`, so any name may match one. */
  private readonly anyNameMayMatch: boolean;
  /** The last segment of every exact key. */
  private readonly exactNames = new Set<string>();
  /** The other wildcard keys' last segments, as one-segment patterns. */
  private readonly lastSegmentPatterns: ReadonlyArray<PathPattern>;

  /** Built by {@link compileDeployment}, which returns `null` for an empty block instead. */
  constructor(configuration: DeploymentConfiguration) {
    const wildcards: CompiledKey[] = [];
    const lastSegmentPatterns: PathPattern[] = [];
    let anyNameMayMatch = false;
    for (const [key, entry] of Object.entries(configuration)) {
      const lastSegment = key.slice(key.lastIndexOf('/') + 1);
      if (!key.includes('*')) {
        this.exact.set(key, entry);
        this.exactNames.add(lastSegment);
        continue;
      }
      wildcards.push(compileKey(key, entry));
      if (lastSegment === '*' || lastSegment === '**') anyNameMayMatch = true;
      else if (lastSegment.includes('*')) lastSegmentPatterns.push(compilePathPattern(`/${lastSegment}`));
      else this.exactNames.add(lastSegment);
    }
    this.wildcards = wildcards.sort(byPrecedence);
    this.anyNameMayMatch = anyNameMayMatch;
    this.lastSegmentPatterns = lastSegmentPatterns;
  }

  /**
   * The entry for the actor at `path`, whole, or `undefined` when no key
   * matches it.  Says nothing about whether the actor is one the layer
   * applies to: the cell asks only for the actors the application wrote.
   */
  lookup(path: ActorPath): DeploymentEntry | undefined {
    if (!this.mayMatchName(path.name)) return undefined;
    const names = namesBelowRoot(path);
    const address = `/${names.join('/')}`;
    const exact = this.exact.get(address);
    if (exact !== undefined) return exact;
    for (const candidate of this.wildcards) {
      if (address.startsWith(candidate.literalPrefix) && candidate.pattern.matchesSegments(names)) {
        return candidate.entry;
      }
    }
    return undefined;
  }

  private mayMatchName(name: string): boolean {
    if (this.anyNameMayMatch || this.exactNames.has(name)) return true;
    for (const pattern of this.lastSegmentPatterns) {
      if (pattern.matchesSegments([name])) return true;
    }
    return false;
  }
}

/**
 * `['user', 'ingest']` for `/user/ingest`: `path.elements()` without the
 * root's empty name, collected in one walk up the parent chain rather than by
 * `elements()`'s repeated `unshift` and a `slice` after it.
 */
function namesBelowRoot(path: ActorPath): string[] {
  const names: string[] = [];
  for (let current: ActorPath = path; current.parent !== null; current = current.parent) {
    names.push(current.name);
  }
  return names.reverse();
}
