import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { RestartPolicy } from './WorkerCluster.js';

/** Plain settings-object shape accepted by {@link WorkerCluster.spawn}. */
export interface WorkerClusterOptionsType {
  readonly bootstrap: URL | string;
  readonly workers?: number | 'auto';
  readonly systemName?: string;
  readonly hostname?: string;
  readonly basePort?: number;
  readonly initData?: unknown;
  readonly restartPolicy?: RestartPolicy;
  readonly readyTimeoutMs?: number;
}

/**
 * Fluent builder for {@link WorkerClusterOptionsType}:
 *
 *     WorkerCluster.spawn(
 *       WorkerClusterOptions.create()
 *         .withBootstrap(new URL('./worker.js', import.meta.url))
 *         .withWorkers(4),
 *     )
 *
 * `withBootstrap` is mandatory — there is no worker entrypoint to spawn
 * without it.  Every other field falls back to its built-in default
 * inside the constructor.
 */
export class WorkerClusterOptionsBuilder extends OptionsBuilder<WorkerClusterOptionsType> {
  /** Start a fresh builder.  Equivalent to `new WorkerClusterOptionsBuilder()`. */
  static create(): WorkerClusterOptionsBuilder {
    return new WorkerClusterOptionsBuilder();
  }

  /** Module URL (or string) of the worker entrypoint each worker runs. */
  withBootstrap(bootstrap: URL | string): this {
    return this.set('bootstrap', bootstrap);
  }

  /** Number of workers to spawn, or `'auto'` (hardware concurrency).  Default: `'auto'` heuristic. */
  withWorkers(workers: number | 'auto'): this {
    return this.set('workers', workers);
  }

  /** ActorSystem name each worker hosts.  Default: `'worker-cluster'`. */
  withSystemName(systemName: string): this {
    return this.set('systemName', systemName);
  }

  /** Hostname component of each worker's {@link NodeAddress}.  Default: `'worker'`. */
  withHostname(hostname: string): this {
    return this.set('hostname', hostname);
  }

  /** Port assigned to the first worker; subsequent workers increment.  Default: 1. */
  withBasePort(basePort: number): this {
    return this.set('basePort', basePort);
  }

  /** Arbitrary payload delivered to each worker in its init message.  Default: `null`. */
  withInitData(initData: unknown): this {
    return this.set('initData', initData);
  }

  /** Restart policy for crashed / exited workers.  Default: `'on-failure'`. */
  withRestartPolicy(restartPolicy: RestartPolicy): this {
    return this.set('restartPolicy', restartPolicy);
  }

  /** How long to wait for a worker's ready handshake before failing.  Default: 10000ms. */
  withReadyTimeoutMs(readyTimeoutMs: number): this {
    return this.set('readyTimeoutMs', readyTimeoutMs);
  }
}

/**
 * Accepted input for {@link WorkerCluster.spawn}: the fluent
 * {@link WorkerClusterOptionsBuilder} OR a plain
 * {@link WorkerClusterOptionsType} object.
 */
export type WorkerClusterOptions = WorkerClusterOptionsBuilder | Partial<WorkerClusterOptionsType>;
/** Value alias so `WorkerClusterOptions.create()` / `new WorkerClusterOptions()` resolve to the builder. */
export const WorkerClusterOptions = WorkerClusterOptionsBuilder;
