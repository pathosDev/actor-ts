import type { ActorSystem } from '../ActorSystem.js';
import { extensionId, type ExtensionId } from '../Extension.js';
import { HealthCheckRegistry, type HealthCheckResult } from './HealthCheck.js';

/**
 * The `name` the framework's liveness check reports under.
 *
 * Stays beside its only producer: the string *is* the check's identity in
 * the `/health` response body, which is a payload operators and dashboards
 * match on — vocabulary rather than a tuned value.
 */
export const ACTOR_SYSTEM_LIVENESS_CHECK_NAME = 'actor-system';

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
 * timer of its own — one more handle to leak, and one more thing that can
 * hang while a per-check timeout does not exist yet (#467).
 */
function actorSystemLiveness(system: ActorSystem): HealthCheckResult {
  return system.isTerminated
    ? { name: ACTOR_SYSTEM_LIVENESS_CHECK_NAME, status: false, detail: 'the actor system has terminated' }
    : { name: ACTOR_SYSTEM_LIVENESS_CHECK_NAME, status: true };
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
 */
export const HealthCheckExtensionId: ExtensionId<HealthCheckRegistry> =
  extensionId<HealthCheckRegistry>(
    'actor-ts/health-checks',
    (system) => {
      const registry = new HealthCheckRegistry();
      registry.addLiveness(() => actorSystemLiveness(system));
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
