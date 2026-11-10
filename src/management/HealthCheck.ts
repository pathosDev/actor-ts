import {
  DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  HealthCheckRegistryOptionsValidator,
  type HealthCheckRegistryOptions,
  type HealthCheckRegistryOptionsType,
} from './HealthCheckRegistryOptions.js';
import { stripUndefined } from '../util/OptionsMerge.js';

/** Return value of a health check.  `status=true` means healthy. */
export type HealthCheckResult = {
  readonly name: string;
  readonly status: boolean;
  readonly detail?: string;
};

export type HealthCheckFunction = () => Promise<HealthCheckResult> | HealthCheckResult;

/**
 * The aggregate rule every probe applies: a result set is healthy when
 * nothing in it is failing.  `/health`, `/ready` and the gRPC
 * `grpc.health.v1.Health` service all call this one function, so a node
 * cannot answer two consumers differently.
 *
 * **An empty set is healthy — deliberately, and written as its own branch**
 * rather than left to `every`'s vacuous truth on `[]`.  The two are the same
 * value and not the same statement, and only one of them is a decision.
 * Readiness is the conjunction of the dependencies a node *declares*: one
 * that declares none has none unmet, and a plain, cluster-free actor system
 * behind `managementRoutes` must not answer 503 for its whole life because
 * nobody registered anything.
 *
 * What the rule may never be asked to cover is a set that is empty because
 * checks were **taken back out**.  "Everything passes" and "nothing is
 * reporting any more" would then be the same answer, and the second one is a
 * node that has stopped being able to serve.  `Cluster.leave()` used to do
 * exactly that, and a node that had left the cluster went on answering
 * `/ready` 200 to its load balancer until the process stopped (#655).  So
 * nothing in the framework removes a readiness check on its way out of
 * service — a component going quiet reports `status: false` and stays
 * registered.  {@link HealthCheckRegistry.addReadiness}'s undo exists for
 * *replacement* (a re-`join` retiring the previous incarnation's checks) and
 * for an application check whose owner is torn down.
 */
export function isHealthy(results: ReadonlyArray<HealthCheckResult>): boolean {
  if (results.length === 0) return true;
  return results.every((result) => result.status);
}

/**
 * The checks behind `GET /health` (liveness), `GET /ready` (readiness) and
 * the gRPC `grpc.health.v1.Health` service.
 *
 * **The two lists answer different questions, and the difference decides
 * what may go in each.**
 *
 * *Liveness* answers "would restarting this process help?".  A failing
 * liveness check tells an orchestrator to kill the pod, so it must depend
 * on nothing outside this process: a check that goes red when a shared
 * database blinks turns one dependency's outage into a fleet-wide restart
 * storm, and the restarts cannot fix what broke.  Only local,
 * self-inflicted failure belongs here.
 *
 * *Readiness* answers "should a load balancer send this node traffic?".
 * It takes the node out of rotation and leaves it running, so it is the
 * right home for exactly what liveness must not touch — the dependencies
 * a request needs.  A readiness probe that answers 200 while the node
 * cannot reach the rest of its cluster is worse than no probe at all: it
 * keeps taking traffic it cannot serve.
 *
 * Framework checks are registered by whichever component owns the signal
 * — `registerClusterHealthChecks` contributes the cluster's two when
 * `Cluster.join` starts — into the per-system registry reached with
 * `healthChecksOf(system)`.  Application checks go into that same
 * registry, which is what keeps `/ready` and the gRPC health service from
 * ever disagreeing about what "ready" means.
 *
 * **Every check runs against a deadline** (#467).  A probe aggregates all of
 * them into one response, so without a per-check budget the slowest check is
 * the response time and a check that never settles is a probe that never
 * answers — which an orchestrator reads as a failed probe, with no clue as to
 * which dependency caused it.  `checkTimeoutMs` bounds one check; past it the
 * registry answers *for* the check and its siblings still report normally.
 * The deadline is a property of the registry rather than of a single check,
 * because that is what an operator can set from `application.conf`:
 * `actor-ts.management.health-checks.check-timeout`.
 */
export class HealthCheckRegistry {
  private readonly liveness: HealthCheckFunction[] = [];
  private readonly readiness: HealthCheckFunction[] = [];
  private readonly checkTimeoutMs: number;

  /**
   * `healthChecksOf(system)` builds the per-system registry with the settings
   * behind `actor-ts.management.health-checks`; a hand-built registry takes
   * whatever it is passed and the built-in defaults for the rest.
   *
   * Validated here, once, on the merged settings — the same rules a
   * config-sourced value faces, because they are the same values.
   */
  constructor(options: HealthCheckRegistryOptions = {}) {
    const settings = {
      checkTimeoutMs: DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
      ...stripUndefined(options as Partial<HealthCheckRegistryOptionsType>),
    };
    new HealthCheckRegistryOptionsValidator().validate(settings);
    this.checkTimeoutMs = settings.checkTimeoutMs;
  }

  /**
   * Register a liveness check; the return value removes it again.
   *
   * See {@link isHealthy} for what removal may and may not be used for — an
   * empty registry reads as healthy, so taking a check out is not a way to
   * signal that something is wrong.
   */
  addLiveness(check: HealthCheckFunction): () => void {
    this.liveness.push(check);
    return () => {
      const i = this.liveness.indexOf(check);
      if (i >= 0) this.liveness.splice(i, 1);
    };
  }

  /**
   * Register a readiness check; the return value removes it again.
   *
   * See {@link isHealthy}: removal is for replacement or for a torn-down
   * owner, never for "this node is going out of service" — that is
   * `status: false` from a check that stays.
   */
  addReadiness(check: HealthCheckFunction): () => void {
    this.readiness.push(check);
    return () => {
      const i = this.readiness.indexOf(check);
      if (i >= 0) this.readiness.splice(i, 1);
    };
  }

  async checkLiveness(): Promise<HealthCheckResult[]> {
    return Promise.all(this.liveness.map((check) => this.runWithDeadline(check)));
  }

  async checkReadiness(): Promise<HealthCheckResult[]> {
    return Promise.all(this.readiness.map((check) => this.runWithDeadline(check)));
  }

  /**
   * Run one check, answering for it if it outlasts `checkTimeoutMs`.
   *
   * **A timed-out check has no name.**  The name lives inside the
   * `HealthCheckResult` the check never returned, so the registry has nothing
   * to report but the same `'unknown'` the throw path has always used — the
   * deadline goes in the `detail`, which is the only field that can carry it.
   * That is a real limitation of registering checks as bare functions and not
   * an oversight to fix here: naming a slow check needs `addReadiness` to take
   * a name, which changes a public signature.
   *
   * The loser of the race is abandoned rather than cancelled — a
   * `HealthCheckFunction` returns a promise and promises do not cancel — so a
   * genuinely stuck check stays pending for the life of the process.  It holds
   * no handle of the framework's and is not re-entered; the next probe starts
   * a fresh call.  The timer is always cleared, so a check that wins the race
   * leaves nothing behind to keep the event loop alive.
   */
  private async runWithDeadline(check: HealthCheckFunction): Promise<HealthCheckResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<HealthCheckResult>((resolve) => {
      timer = setTimeout(() => resolve({
        name: 'unknown',
        status: false,
        detail: `health check did not answer within ${this.checkTimeoutMs}ms`,
      }), this.checkTimeoutMs);
    });
    try {
      return await Promise.race([runCheck(check), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Invoke a check and turn any failure into a result, including one thrown
 * synchronously before a promise ever exists.
 */
async function runCheck(check: HealthCheckFunction): Promise<HealthCheckResult> {
  try { return await check(); }
  catch (err) { return { name: 'unknown', status: false, detail: String(err) }; }
}
