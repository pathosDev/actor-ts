/**
 * Smoke case: the saturation metrics work on every supported runtime (#196).
 *
 * This case exists because of what it *replaces*.  #196 specified
 * `dispatcher_saturation_ratio`, a 0-1 busy fraction, and the only primitive
 * that could have produced one is `performance.eventLoopUtilization`.
 * Measured on this project's three supported runtimes:
 *
 *   bun  1.3.1   typeof performance.eventLoopUtilization === 'undefined'
 *   node 26.7.0  a real reading
 *   deno 2.6.8   a function that returns { idle: 0, active: 0, utilization: 0 }
 *
 * So a presence check passes on two runtimes and one of those two lies.  A
 * ratio built on it would have been silently, permanently 0 on a third of the
 * matrix — and an alert on a metric that never fires is worse than no metric,
 * because nobody finds out.  `actor_dispatcher_queue_delay_seconds` answers
 * the same operational question from two reads of a clock every runtime has,
 * and this case is the proof that "every runtime" is true rather than assumed:
 * a unit test on Bun would have said nothing about the two runtimes where the
 * rejected primitive appears to exist.
 *
 * It also covers `actor_mailbox_depth`, whose observation reads
 * `mailbox.size` per delivery — cheap and portable, but a *number* crossing
 * three JS engines, and the ladder it lands on is the thing an operator reads.
 *
 * The event-loop-utilization probe is printed rather than asserted.  Asserting
 * "Deno returns zeros" would turn a Deno improvement into a red gate, which is
 * the wrong incentive; the assertion that matters is the one this case does
 * make, that the framework's saturation signal is present and non-degenerate
 * whether or not the runtime has the primitive at all.  If the printed line
 * ever changes, the decision recorded in `src/metrics/Constants.ts` is worth
 * revisiting.
 *
 * Handle discipline: the system is terminated in a `finally`, and metrics are
 * disabled first so the mailbox-depth sampler's fixed-rate timer is cancelled
 * on the failure path too.  A timer left armed keeps Deno's event loop alive
 * and the run hangs after its last green line (#1196).
 */
export const name = 'saturation metrics';
export const description = 'actor_mailbox_depth distribution + actor_dispatcher_queue_delay_seconds under load';

/** Milliseconds of loop-blocking work per message in the saturation phase. */
const SPIN_MS = 4;
/** Cells offered a turn in one synchronous burst on the saturated dispatcher. */
const BURST = 10;
/** Messages queued behind a parked handler in the depth phase. */
const BACKLOG = 60;

/**
 * A bare sleep, not a poll: `.mjs` cases cannot import the TypeScript
 * `awaitCondition`, and this is only the poll step of the bounded loop below.
 */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Poll `predicate` until true or the budget runs out; returns whether it held. */
async function awaitUntil(predicate, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(5);
  }
  return predicate();
}

export async function run({ actorTs, runtime, loadEntry }) {
  const { Actor, ActorSystem, ActorSystemOptions, ActorOptions, ThroughputDispatcher, NoopLogger, LogLevel } = actorTs;
  const { MetricsExtensionId } = await loadEntry('metrics');

  /** Parks the first message so a known backlog can build behind it. */
  let releaseGate = () => {};
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  class Gated extends Actor {
    async onReceive(message) {
      if (message === 'hold') await gate;
    }
  }
  /** Occupies the loop synchronously, which is what delays the queue behind it. */
  class Occupying extends Actor {
    onReceive() {
      const until = performance.now() + SPIN_MS;
      while (performance.now() < until) { /* hold the loop */ }
    }
  }

  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('smoke-saturation', systemOptions);
  const extension = system.extension(MetricsExtensionId);
  const registry = extension.enable();

  const samplesOf = (metricName) => registry.collect().filter((s) => s.name === metricName);
  const summaryOf = (metricName, dispatcherId) => {
    const found = samplesOf(metricName).find((s) => s.count !== undefined
      && (dispatcherId === undefined || s.labels.dispatcher === dispatcherId));
    return { count: found?.count ?? 0, sum: found?.sum ?? 0 };
  };
  const cumulativeAt = (metricName, boundary, dispatcherId) =>
    samplesOf(metricName).find((s) => s.bucket === boundary
      && (dispatcherId === undefined || s.labels.dispatcher === dispatcherId))?.value ?? 0;

  try {
    /* ---- actor_mailbox_depth: a distribution, not an instant ------------ */

    const gatedRef = system.spawn(Gated, 'gated');
    gatedRef.tell('hold');
    if (!await awaitUntil(() => summaryOf('actor_mailbox_depth').count >= 1, 4_000)) {
      throw new Error('actor_mailbox_depth recorded nothing at all');
    }
    for (let i = 0; i < BACKLOG; i++) gatedRef.tell('drain');
    releaseGate();
    if (!await awaitUntil(() => summaryOf('actor_mailbox_depth').count >= BACKLOG + 1, 8_000)) {
      const { count } = summaryOf('actor_mailbox_depth');
      throw new Error(`actor_mailbox_depth saw ${count} of ${BACKLOG + 1} deliveries`);
    }

    const depthLadder = samplesOf('actor_mailbox_depth')
      .filter((s) => s.bucket !== undefined)
      .map((s) => s.bucket);
    if (depthLadder[0] !== 1) {
      throw new Error(`actor_mailbox_depth ladder should start at 1, got ${depthLadder[0]}`);
    }
    // The observation counts the message being delivered, so the shallowest
    // reading is 1 and never 0.
    if (summaryOf('actor_mailbox_depth').sum < BACKLOG + 1) {
      throw new Error('actor_mailbox_depth read below 1 per delivery — the queued message is not counted');
    }
    // The tail is the whole point: a 60-deep backlog must put observations
    // above the 20 boundary, which is where an instant-valued gauge sampled
    // every 2 s would have seen nothing.
    const depthTotal = summaryOf('actor_mailbox_depth').count;
    const deepObservations = depthTotal - cumulativeAt('actor_mailbox_depth', 20);
    if (deepObservations < 20) {
      throw new Error(`actor_mailbox_depth revealed no tail: only ${deepObservations} observations past 20`);
    }
    // No labels, so the family's width is its ladder and nothing else — the
    // property that lets it be observed per delivery at all.
    for (const sample of samplesOf('actor_mailbox_depth')) {
      if (Object.keys(sample.labels).length !== 0) {
        throw new Error(`actor_mailbox_depth grew a label: ${JSON.stringify(sample.labels)}`);
      }
    }

    /* ---- actor_dispatcher_queue_delay_seconds: growing under load -------- */

    const saturated = new ThroughputDispatcher(1, 'smoke-saturated');
    const saturatedOptions = ActorOptions.create().withDispatcher(saturated);
    for (let i = 0; i < BURST; i++) {
      system.spawn(Occupying, `occupying-${i}`, saturatedOptions).tell(i);
    }
    if (!await awaitUntil(() => summaryOf('actor_dispatcher_queue_delay_seconds', 'smoke-saturated').count >= BURST, 10_000)) {
      const { count } = summaryOf('actor_dispatcher_queue_delay_seconds', 'smoke-saturated');
      throw new Error(`actor_dispatcher_queue_delay_seconds saw ${count} of ${BURST} turns`);
    }

    const delaySummary = summaryOf('actor_dispatcher_queue_delay_seconds', 'smoke-saturated');
    const delayLadder = samplesOf('actor_dispatcher_queue_delay_seconds')
      .filter((s) => s.bucket !== undefined && s.labels.dispatcher === 'smoke-saturated')
      .map((s) => s.bucket);
    if (delayLadder[0] !== 0.00001) {
      throw new Error(`delay ladder should start at 10us, got ${delayLadder[0]}`);
    }
    // Turn k waits out roughly (k-1) spins, so the mean is about half the
    // burst.  Asserted at a quarter of that: the claim is that the metric sees
    // the backlog on this runtime, not that this runtime schedules tidily.
    const meanSeconds = delaySummary.sum / delaySummary.count;
    const floorSeconds = (BURST * SPIN_MS) / 1_000 / 2 / 4;
    if (!(meanSeconds > floorSeconds)) {
      throw new Error(
        `delay mean ${meanSeconds.toFixed(6)}s did not exceed ${floorSeconds.toFixed(6)}s — `
        + 'a backed-up dispatcher read as idle',
      );
    }
    // …and it is a distribution, so at least half of the turns land past 10 ms
    // rather than the sum being one outlier.
    const pastTenMs = delaySummary.count - cumulativeAt('actor_dispatcher_queue_delay_seconds', 0.01, 'smoke-saturated');
    if (pastTenMs < Math.floor(delaySummary.count / 2)) {
      throw new Error(`only ${pastTenMs} of ${delaySummary.count} delays passed 10ms`);
    }
    // The label is the dispatcher and nothing else.  A per-actor dispatcher is
    // invisible to the system — nothing enumerates dispatchers — so its
    // appearing here at all is what the cell-side measurement buys.
    for (const sample of samplesOf('actor_dispatcher_queue_delay_seconds')) {
      if (Object.keys(sample.labels).join(',') !== 'dispatcher') {
        throw new Error(`unexpected delay labels: ${JSON.stringify(sample.labels)}`);
      }
    }

    /* ---- the primitive this metric exists instead of --------------------- */

    let utilizationVerdict = 'absent';
    if (typeof performance.eventLoopUtilization === 'function') {
      const before = performance.eventLoopUtilization();
      const until = Date.now() + 60;
      while (Date.now() < until) { /* give the loop something to have been busy with */ }
      await sleep(20);
      const delta = performance.eventLoopUtilization(before);
      utilizationVerdict = (delta.idle === 0 && delta.active === 0)
        ? 'present but hard-zero (a stub)'
        : `present and live (utilization=${delta.utilization})`;
    }
    console.log(
      `  ${runtime}: performance.eventLoopUtilization is ${utilizationVerdict}; `
      + `queue delay mean=${(meanSeconds * 1_000).toFixed(2)}ms over ${delaySummary.count} turns`,
    );
  } finally {
    // Disable before terminate so the mailbox-depth sampler's fixed-rate timer
    // is cancelled even if an assertion above threw.
    releaseGate();
    extension.disable();
    await system.terminate();
  }
}
