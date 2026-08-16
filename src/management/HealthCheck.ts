/** Return value of a health check.  `status=true` means healthy. */
export type HealthCheckResult = {
  readonly name: string;
  readonly status: boolean;
  readonly detail?: string;
};

export type HealthCheckFunction = () => Promise<HealthCheckResult> | HealthCheckResult;

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
 */
export class HealthCheckRegistry {
  private readonly liveness: HealthCheckFunction[] = [];
  private readonly readiness: HealthCheckFunction[] = [];

  addLiveness(check: HealthCheckFunction): () => void {
    this.liveness.push(check);
    return () => {
      const i = this.liveness.indexOf(check);
      if (i >= 0) this.liveness.splice(i, 1);
    };
  }

  addReadiness(check: HealthCheckFunction): () => void {
    this.readiness.push(check);
    return () => {
      const i = this.readiness.indexOf(check);
      if (i >= 0) this.readiness.splice(i, 1);
    };
  }

  async checkLiveness(): Promise<HealthCheckResult[]> {
    return Promise.all(this.liveness.map(async (check) => {
      try { return await check(); }
      catch (err) { return { name: 'unknown', status: false, detail: String(err) }; }
    }));
  }

  async checkReadiness(): Promise<HealthCheckResult[]> {
    return Promise.all(this.readiness.map(async (check) => {
      try { return await check(); }
      catch (err) { return { name: 'unknown', status: false, detail: String(err) }; }
    }));
  }
}
