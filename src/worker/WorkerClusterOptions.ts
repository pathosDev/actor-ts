import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { RestartPolicy, WorkerClusterSettings } from './WorkerCluster.js';

/**
 * Fluent builder for {@link WorkerClusterSettings}:
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
export class WorkerClusterOptions extends OptionsBuilder<WorkerClusterSettings> {
  /** Start a fresh builder.  Equivalent to `new WorkerClusterOptions()`. */
  static create(): WorkerClusterOptions {
    return new WorkerClusterOptions();
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
