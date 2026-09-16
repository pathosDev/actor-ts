/**
 * Worker-side bootstrap for mesh-message-cost.ts — one real OS thread hosting
 * its own `ActorSystem` and `Cluster`, joined to the main thread over the
 * `MessageChannelTransport` that `WorkerNode.join()` hands out.
 *
 * This is the hand-written shape `WorkerMesh` (#1562) replaces with a
 * framework-shipped bootstrap; until then every worker script in the tree
 * looks like this one.
 *
 * No seeds: the worker self-elects as the first member, and the main thread
 * joins *it* — which sidesteps the ordering question of a worker seeding on a
 * node that has not registered with the broker yet.  `main()` is a named
 * async function and not a top-level `await`, for the reason `WorkerNode`'s
 * JSDoc gives: under Bun a top-level await in a worker suspends the module
 * loader in a way that keeps the init frame from ever dispatching.
 *
 * Ignored by the benchmark discovery harness — filename starts with "_".
 */
import { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } from '../../src/index.js';
import { Cluster, ClusterOptions } from '../../src/cluster/index.js';
import { WorkerNode } from '../../src/worker/index.js';
import { Counter, COUNTER_NAME } from './_mesh-counter.js';

async function main(): Promise<void> {
  const context = await WorkerNode.join();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(context.systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(context.self.host)
    .withPort(context.self.port)
    .withTransport(context.transport)
    .withFailureDetector({ heartbeatIntervalMs: 100, unreachableAfterMs: 400, downAfterMs: 800 })
    .withGossipIntervalMs(80);
  await Cluster.join(system, clusterOptions);
  system.spawn(Counter, COUNTER_NAME);
  context.ready();
}

void main();
