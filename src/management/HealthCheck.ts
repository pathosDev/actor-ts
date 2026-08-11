/** Return value of a health check.  `status=true` means healthy. */
export type HealthCheckResult = {
  readonly name: string;
  readonly status: boolean;
  readonly detail?: string;
};

export type HealthCheckFunction = () => Promise<HealthCheckResult> | HealthCheckResult;

/**
 * Thin registry for liveness / readiness style checks.  Components
 * (persistence journal, sharding coordinator, …) register their own checks;
 * the management endpoints aggregate them and surface the overall status.
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
