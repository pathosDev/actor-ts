/**
 * Minimal scenario runner shared across all broker-integration suites
 * (B.2-B.9).  Same idea as the cluster-scenario runner under
 * `tests/integration/controller.ts`, but trimmed for the single-
 * service shape of broker tests:
 *
 *   - No cluster topology — each scenario gets a fresh connection to
 *     ONE broker container.
 *   - No partition / latency injection — broker tests aren't trying
 *     to verify network-fault behaviour, they're verifying the
 *     framework's adapter against a REAL broker (vs the mock fakes
 *     in unit tests).
 *
 * Every broker suite ships a `<broker>/runner.ts` that:
 *   1. imports its scenarios from `<broker>/scenarios/*.ts`
 *   2. calls `runScenarios(scenarios, ctx)` from this module
 *   3. exits 0 on all-pass, 1 on any-fail
 *
 * `docker compose -f <broker>/docker-compose.<broker>.yml up
 * --exit-code-from runner` propagates that exit code, so the
 * `bun run test:integration:<broker>` script is the same shape as
 * `test:integration` from #313.
 */

export interface BrokerScenarioContext {
  /**
   * Backend-specific connection info.  Each suite has its own shape
   * (S3 endpoint URL + credentials; MQTT broker URL + creds;
   * Kafka bootstrap; …).  We don't try to unify these — the suite
   * narrows it locally.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface BrokerScenario<Context extends BrokerScenarioContext = BrokerScenarioContext> {
  readonly name: string;
  run(ctx: Context): Promise<void>;
}

/**
 * Run scenarios sequentially.  Exits the process (0/1) when done.
 *
 * Sequential rather than parallel because (a) brokers tend to have
 * shared state — a parallel test polluting a topic / bucket / queue
 * makes the next scenario's setup non-deterministic, and (b) the
 * total scenario count per broker is small (~5), so the wall-clock
 * cost is bounded.
 */
export async function runScenarios<Context extends BrokerScenarioContext>(
  scenarios: ReadonlyArray<BrokerScenario<Context>>,
  ctx: Context,
): Promise<void> {
  console.log(`[runner] ${scenarios.length} scenario(s) against env ${JSON.stringify(redact(ctx.env))}\n`);

  let failed = 0;
  for (const s of scenarios) {
    const startedAt = Date.now();
    console.log(`[runner] === ${s.name} ===`);
    try {
      await s.run(ctx);
      console.log(`[runner] PASS ${s.name} (${Date.now() - startedAt}ms)\n`);
    } catch (e) {
      failed += 1;
      console.error(`[runner] FAIL ${s.name} (${Date.now() - startedAt}ms)`);
      console.error(e);
      console.error('');
    }
  }

  if (failed > 0) {
    console.error(`[runner] ${failed} of ${scenarios.length} scenarios failed`);
    process.exit(1);
  }
  console.log(`[runner] all ${scenarios.length} scenarios passed`);
  process.exit(0);
}

/**
 * Polling helper — identical contract to the cluster-controller's
 * `waitFor`, lifted to broker-test convenience.  Use this for "the
 * broker eventually surfaces our published message" assertions; the
 * deadline-and-poll shape makes failure modes loud.
 */
export async function waitFor(
  description: string,
  check: () => Promise<boolean> | boolean,
  deadlineMs: number = 10_000,
  pollMs: number = 100,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const detail = lastError ? ` (last error: ${(lastError as Error).message})` : '';
  throw new Error(`waitFor: "${description}" did not become true within ${deadlineMs}ms${detail}`);
}

/** Redact secret-looking env keys for the startup log line. */
function redact(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/secret|password|key|token/i.test(k)) out[k] = '<redacted>';
    else out[k] = v;
  }
  return out;
}
