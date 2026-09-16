import { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import type { WorkerBackend } from '../runtime/worker/index.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import {
  BOOTSTRAP_ALLOWED_HOST,
  BOOTSTRAP_ALLOWED_PROTOCOL,
  parseBootstrapUrl,
} from '../worker/WorkerClusterOptions.js';
import { compilePathPattern, reachesSystemTree } from './PathPattern.js';

/**
 * Off.  `0` is the whole of the promise `workers = 0` makes: no cluster, no
 * thread, no module import, and `spawn` pays one field read before it takes
 * the path it always took.  Anything else starts a mesh in the background.
 */
export const DEFAULT_PARALLELISM_WORKERS: number | 'auto' = 0;
/**
 * Every top-level user actor, and only those.  That is the stated goal — the
 * application does not change, the config decides — and the refinement, a
 * narrower allow-list, exists because the thread boundary is not free: a local
 * `tell` is an array push, a cross-thread one a structured clone plus two
 * relay hops (`benchmarks/worker/mesh-message-cost.ts`), so a chatty actor
 * that does little work per message is slower on a worker than at home.
 */
export const DEFAULT_PARALLELISM_OFFLOAD: ReadonlyArray<string> = ['/user/*'];
/**
 * A hash of the actor's name picks its worker, so the same name lands on the
 * same worker across restarts of the application — which keeps anything the
 * worker caches for it warm, and keeps a placement explainable from a log.
 */
export const DEFAULT_PARALLELISM_PLACEMENT: PlacementStrategy = 'consistent-hash';
/**
 * The main thread leads: it hosts the shard coordinator, and a cluster
 * singleton with no role lands on it.  `'worker'` moves both onto a worker.
 */
export const DEFAULT_PARALLELISM_LEADER: MeshLeader = 'main';
/**
 * How long a spawn may wait for the worker's acknowledgment before the ref is
 * failed and whatever it buffered goes to dead letters.  Ten seconds is the
 * worker handshake's own budget; a worker that has come up answers a spawn in
 * well under a millisecond, so this only ever fires on a worker that died.
 */
export const DEFAULT_PARALLELISM_SPAWN_TIMEOUT_MS = 10_000;
/**
 * Messages held across every pending spawn — sent to an offloaded actor
 * before its worker acknowledged it — beyond which the rest go to dead
 * letters.  The same figure sharding's region buffer uses, for the same
 * situation: a home that is not known yet.
 */
export const DEFAULT_PARALLELISM_BUFFER_SIZE = 100_000;

/** How the extension picks a worker for an offloaded actor. */
export type PlacementStrategy = 'consistent-hash' | 'round-robin';
/** Which side of the mesh hosts the coordinator and the role-less singletons. */
export type MeshLeader = 'main' | 'worker';

/** Plain options-object shape layered over `actor-ts.parallelism.*`. */
export type ParallelismOptionsType = {
  /** `0` (off), a worker count, or `'auto'` — the available parallelism minus the main thread. */
  readonly workers?: number | 'auto';
  /**
   * The module — or modules — whose exported actor classes may be offloaded.
   * Every worker imports it and so does the main thread; a class is matched
   * across the boundary by its **export name**.  When unset, the extension
   * looks for `actors.js` (or `.ts`) next to the entry module.
   *
   * Not a HOCON leaf, for the reason `worker-cluster.bootstrap` has none: a
   * config file must not decide which code a worker runs.
   */
  readonly module?: URL | string | ReadonlyArray<URL | string>;
  /** Path patterns of the actors that move to a worker — see `PathPattern`. */
  readonly offload?: ReadonlyArray<string>;
  readonly placement?: PlacementStrategy;
  readonly leader?: MeshLeader;
  readonly spawnTimeoutMs?: number;
  readonly bufferSize?: number;
  /** The worker entry to spawn instead of the shipped one — the escape hatch for a bundler. */
  readonly bootstrap?: URL | string;
  /** Test seam: the thread implementation behind the mesh. */
  readonly backend?: WorkerBackend;
};

export class ParallelismOptionsBuilder extends OptionsBuilder<ParallelismOptionsType> {
  static create(): ParallelismOptionsBuilder {
    return new ParallelismOptionsBuilder();
  }

  withWorkers(workers: number | 'auto'): this { return this.set('workers', workers); }
  withModule(module: URL | string | ReadonlyArray<URL | string>): this { return this.set('module', module); }
  withOffload(offload: ReadonlyArray<string>): this { return this.set('offload', offload); }
  withPlacement(placement: PlacementStrategy): this { return this.set('placement', placement); }
  withLeader(leader: MeshLeader): this { return this.set('leader', leader); }
  withSpawnTimeoutMs(spawnTimeoutMs: number): this { return this.set('spawnTimeoutMs', spawnTimeoutMs); }
  withBufferSize(bufferSize: number): this { return this.set('bufferSize', bufferSize); }
  withBootstrap(bootstrap: URL | string): this { return this.set('bootstrap', bootstrap); }
  withBackend(backend: WorkerBackend): this { return this.set('backend', backend); }
}

export class ParallelismOptionsValidator extends OptionsValidator<ParallelismOptionsType> {
  constructor() {
    super('ParallelismOptions');
  }

  protected rules(s: Partial<ParallelismOptionsType>): void {
    // `workers` is `number | 'auto'`, so the field-name helpers cannot address it.
    if (s.workers !== undefined && s.workers !== 'auto' && (!Number.isInteger(s.workers) || s.workers < 0)) {
      this.fail('workers', "must be 0, a positive integer or 'auto'", s.workers);
    }
    if (s.module !== undefined) {
      const modules = Array.isArray(s.module) ? s.module : [s.module];
      for (const module of modules as ReadonlyArray<URL | string>) this.moduleUrl('module', module);
    }
    if (s.bootstrap !== undefined) this.moduleUrl('bootstrap', s.bootstrap);
    this.nonEmptyArray('offload');
    for (const source of s.offload ?? []) this.offloadPattern(source);
    this.oneOf('placement', ['consistent-hash', 'round-robin']);
    this.oneOf('leader', ['main', 'worker']);
    this.positiveNumber('spawnTimeoutMs');
    this.nonNegativeInt('bufferSize');
  }

  /**
   * A pattern is refused when it could reach the `/system` tree — `/system/*`
   * as much as `/*` or `**`.  The error names the route that works, because
   * the wish behind such a pattern is legitimate: a worker *is* a cluster
   * node, so the role-based placement the framework already has applies to
   * it unchanged.
   */
  private offloadPattern(source: unknown): void {
    if (typeof source !== 'string') {
      this.fail('offload', 'must contain path patterns', source);
    }
    let pattern;
    try {
      pattern = compilePathPattern(source);
    } catch (error) {
      this.fail('offload', (error as Error).message, source);
    }
    if (reachesSystemTree(pattern)) {
      this.fail(
        'offload',
        `${JSON.stringify(source)} would match the /system tree — system actors are not spawned through `
        + "spawn(), so the entry would do nothing, and no node may address /system by name across the wire. "
        + 'To run framework actors on a worker use the placement the cluster already has: '
        + '`actor-ts.worker-mesh.worker-roles` with a singleton or sharding role, or '
        + '`actor-ts.parallelism.leader = "worker"` for the shard coordinator',
        source,
      );
    }
  }

  private moduleUrl(field: 'module' | 'bootstrap', value: URL | string): void {
    const url = parseBootstrapUrl(value);
    if (url === undefined) {
      this.fail(
        field,
        'must be an absolute URL — resolve a relative specifier against the caller first, '
        + "as in new URL('./actors.js', import.meta.url)",
        value,
      );
    }
    if (url.protocol !== BOOTSTRAP_ALLOWED_PROTOCOL) {
      this.fail(
        field,
        `must use the ${BOOTSTRAP_ALLOWED_PROTOCOL} scheme — a data:, blob: or remote `
        + 'specifier hands the worker code from outside the deployment',
        url.href,
      );
    }
    if (url.host !== BOOTSTRAP_ALLOWED_HOST) {
      this.fail(
        field,
        'must be a host-less file: URL — a host makes it a UNC path, so the module is fetched off that server',
        url.href,
      );
    }
  }
}

/** The subset of the options a config file can carry — no module, no bootstrap, no backend. */
export type ParallelismConfigDefaults = Pick<
  ParallelismOptionsType,
  'workers' | 'offload' | 'placement' | 'leader' | 'spawnTimeoutMs' | 'bufferSize'
>;

export function readParallelismOptionsFromConfig(
  config: Config = Config.load(),
): ParallelismConfigDefaults {
  const keys = ConfigKeys.parallelism;
  const out: { -readonly [K in keyof ParallelismConfigDefaults]: ParallelismConfigDefaults[K] } = {};
  if (config.hasPath(keys.workers)) {
    const raw = config.getString(keys.workers);
    out.workers = raw === 'auto' ? 'auto' : config.getInt(keys.workers);
  }
  if (config.hasPath(keys.offload)) {
    out.offload = config.getStringList(keys.offload);
  }
  if (config.hasPath(keys.placement)) {
    out.placement = config.getString(keys.placement) as PlacementStrategy;
  }
  if (config.hasPath(keys.leader)) {
    out.leader = config.getString(keys.leader) as MeshLeader;
  }
  if (config.hasPath(keys.spawnTimeout)) {
    out.spawnTimeoutMs = config.getDuration(keys.spawnTimeout);
  }
  if (config.hasPath(keys.bufferSize)) {
    out.bufferSize = config.getInt(keys.bufferSize);
  }
  return out;
}

/**
 * Layer explicit options over the HOCON block: explicit > HOCON > built-in
 * defaults.  Takes the union, because a builder *is* its settings — a bag of
 * own properties — and the spread inside `mergeOptions` reads both forms.
 */
export function withParallelismConfigDefaults(
  options: ParallelismOptions | undefined,
  config: Config,
): ParallelismOptionsType {
  return mergeOptions<ParallelismOptionsType>(
    {},
    readParallelismOptionsFromConfig(config),
    (options as ParallelismOptionsType | undefined) ?? {},
  );
}

/**
 * Accepted input for `ActorSystemOptions.withParallelism`: the fluent
 * {@link ParallelismOptionsBuilder} OR a plain {@link ParallelismOptionsType}.
 */
export type ParallelismOptions = ParallelismOptionsBuilder | ParallelismOptionsType;
export const ParallelismOptions = ParallelismOptionsBuilder;
