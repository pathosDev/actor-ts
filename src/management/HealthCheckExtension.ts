import type { ActorSystem } from '../ActorSystem.js';
import { CoordinatedStartupId, type CoordinatedStartup } from '../CoordinatedStartup.js';
import { extensionId, type ExtensionId } from '../Extension.js';
import { HealthCheckRegistry, type HealthCheckResult } from './HealthCheck.js';
import { readHealthCheckRegistryOptionsFromConfig } from './HealthCheckRegistryOptions.js';

/**
 * The `name` the framework's liveness check reports under.
 *
 * Stays beside its only producer: the string *is* the check's identity in
 * the `/health` response body, which is a payload operators and dashboards
 * match on — vocabulary rather than a tuned value.
 */
export const ACTOR_SYSTEM_LIVENESS_CHECK_NAME = 'actor-system';

/**
 * The `name` the startup graph's readiness check reports under — beside the
 * liveness name for the same reason: it is the check's identity in the
 * `/ready` response body.
 */
export const STARTUP_READINESS_CHECK_NAME = 'startup';

/**
 * The framework's liveness check: has this actor system shut down?
 *
 * Deliberately the *only* thing liveness asserts.  A liveness failure gets
 * the process killed, so the check may look at nothing a restart cannot
 * fix — no journal, no peer, no lease.  A terminated system qualifies: it
 * will never serve another message, and only a new process will.
 *
 * It is not a check on whether the event loop is turning.  Answering the
 * probe at all already proves that much, and proving more would need a
 * timer of its own — one more handle to leak.  The registry now bounds a
 * hanging check itself (#467), so that is no longer the second objection it
 * once was; the first one still stands on its own.
 */
function actorSystemLiveness(system: ActorSystem): HealthCheckResult {
  return system.isTerminated
    ? { name: ACTOR_SYSTEM_LIVENESS_CHECK_NAME, status: false, detail: 'the actor system has terminated' }
    : { name: ACTOR_SYSTEM_LIVENESS_CHECK_NAME, status: true };
}

/**
 * The startup graph's readiness check (#1473): has the system finished
 * starting up?
 *
 * Readiness and not liveness, because the answer while startup runs is
 * "not yet", which a restart cannot improve on — and a startup that failed
 * takes the system down, which the liveness check above already reports.
 * Reading the graph's state rather than awaiting `whenReady()` keeps the check
 * instant: a probe asks what is true now, and the registry's deadline is no
 * place to wait out a phase.
 */
function startupReadiness(startup: CoordinatedStartup): HealthCheckResult {
  if (startup.isComplete) return { name: STARTUP_READINESS_CHECK_NAME, status: true };
  return { name: STARTUP_READINESS_CHECK_NAME, status: false, detail: startupNotReadyDetail(startup) };
}

/** Why the startup check is failing, in the words an operator reading `/ready` needs. */
function startupNotReadyDetail(startup: CoordinatedStartup): string {
  const failure = startup.failure;
  if (failure !== undefined) return failure.message;
  const phase = startup.runningPhase;
  if (phase !== undefined) return `startup is running phase "${phase}"`;
  return startup.isRunning
    ? 'startup has not begun its first phase yet'
    : 'startup did not complete: the system was terminated while it ran';
}

/**
 * The one {@link HealthCheckRegistry} per `ActorSystem`.
 *
 * An extension rather than something `managementRoutes` news up, because
 * the components that own a health signal start long before anyone builds
 * a route tree — `Cluster.join` binds a transport, a `ShardRegion`
 * registers with its coordinator — and a registry that does not exist yet
 * cannot be registered with.  That ordering is the whole reason `/health`
 * and `/ready` had nothing to aggregate (#655): there was no seam to
 * register into, only a return value handed back after start-up.
 *
 * Being per-system is also what *lets* the framework carry one notion of
 * "ready" — as far as the wiring goes, and no further.  The management
 * endpoints always read this registry; the gRPC `grpc.health.v1.Health`
 * service reads whichever registry the caller put in
 * `GrpcServerOptionsType.health`.  The two cannot answer a load balancer
 * differently when that field is `healthChecksOf(system)`, and can when it
 * is a fresh `HealthCheckRegistry`.  Nothing enforces the first — the field
 * taking a registry rather than a boolean is what makes the choice visible.
 *
 * The framework's liveness check is installed here, in the factory, rather
 * than from `ActorSystem`'s constructor: a system that never asks for the
 * registry pays nothing, and the check is present the instant the registry
 * exists — there is no window in which the registry is real but empty.
 *
 * The factory is also where `actor-ts.management.health-checks.check-timeout`
 * reaches the registry, for the same reason: the extension receives the
 * `ActorSystem`, so `system.config` is in scope here and nowhere on the
 * construction path a caller uses.  A registry built by hand — the
 * `GrpcServerOptionsType.health` field takes one — gets the built-in default
 * and not this system's HOCON, the same asymmetry that field's own JSDoc
 * documents: the two health consumers share a registry only if you pass the
 * shared one.
 *
 * The startup graph's readiness check is installed here too (#1473), and only
 * when the graph has tasks: a system with nothing to start up has nothing to
 * be unready about, and its readiness set stays the empty one a plain system
 * has always answered.  Decided from the tasks, never from whether startup is
 * still running — the registry is built on first use, usually long after
 * `create`, and a check present only in registries built early would make two
 * probes of one node disagree.  Never removed: once startup is over it
 * reports `true`, or `false` naming the task that failed.
 */
export const HealthCheckExtensionId: ExtensionId<HealthCheckRegistry> =
  extensionId<HealthCheckRegistry>(
    'actor-ts/health-checks',
    (system) => {
      const registry = new HealthCheckRegistry(readHealthCheckRegistryOptionsFromConfig(system.config));
      registry.addLiveness(() => actorSystemLiveness(system));
      const startup = system.extension(CoordinatedStartupId);
      if (startup.hasTasks) registry.addReadiness(() => startupReadiness(startup));
      return registry;
    },
  );

/**
 * The registry every health consumer on this system shares — the place to
 * register an application check.
 *
 * Mirrors `metricsOf` / `clusterOf`.
 */
export function healthChecksOf(system: ActorSystem): HealthCheckRegistry {
  return system.extension(HealthCheckExtensionId);
}
