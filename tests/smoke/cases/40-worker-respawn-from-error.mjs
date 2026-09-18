/**
 * Smoke case: a worker that has joined `WorkerCluster` and then dies from an
 * uncaught throw is respawned — on every runtime, and on Deno from the `error`
 * event alone (#1186).
 *
 * The other worker cases prove containment: `29-` that a bootstrap failure
 * rejects `spawn()` without killing the host, `31-` that a joined
 * `ParallelMultiNodeSpec` worker may die without taking the process with it.
 * Neither proves the sentence the worker-mesh docs commit to for the runtime
 * matrix — that a crashed worker comes *back* — and nothing under `bun test`
 * can, because it spawns no OS thread anywhere: the unit suite drives
 * `attachFailureHandlers` from a fake that emits whatever the test says.  This
 * case posts `die` to a real thread and asserts that a fresh handle re-fills
 * slot 0 — same `id`, same address, a new ready token.
 *
 * Why Deno is the load-bearing arm (#1217).  For one uncaught throw the
 * parent-side events differ per runtime — measured on Bun 1.4.2, Node 26.7.0
 * and Deno 2.6.8: Bun emits `error` then `close` (code 1) 13 ms later, Node
 * `error` then `exit` (code 1) 1–2 ms later, Deno `error` and nothing else, not
 * even after `terminate()`.  `WorkerCluster` puts both subscriptions behind
 * one latch and whichever event arrives first consumes it, so on Bun and Node
 * an `error` handler that freed nothing would still be covered by the `close`
 * path.  On Deno there is only the one event: if the `error` path stops
 * freeing the slot, the slot stays dead and this case is the only thing in the
 * tree that says so.  Verified by mutation — with `onError` subscribed but
 * inert, Bun and Node stay green and Deno fails here with `no replacement
 * within 10000ms (size=1)`, the dead-slot shape of #1284.  The Bun and Node
 * arms are not decorative either: an `onError` that consumes the latch and
 * skips the restart drops the later `close`, and all three go red.  What this
 * case does *not* bind is the latch itself — with it removed, `onWorkerDown`'s
 * `findIndex` already drops the second event and all three stay green; the
 * zero-backoff unit case in `tests/unit/worker/WorkerCluster.test.ts` is the
 * one that goes red for that.
 *
 * Why the wait is a referenced poll and not an event (#1283).  `requestRestart`
 * unrefs the respawn timer, so between the crash and the respawn nothing in the
 * framework holds the event loop, and a wait that holds nothing either leaves
 * the verdict to the runtime.  Measured with an event-only wait in its place:
 * Node 26 exits with code 13 — "Detected unsettled top-level await" — 4 ms
 * after the error, during the 200 ms backoff and before any respawn; its check
 * ignores an unref'd timer.  Deno's equivalent check waits for the unref'd
 * timer to fire, so it rides out the backoff, the replacement is spawned and
 * then holds the loop, and the run hangs; Bun has no such check and hangs on
 * any unsettled top-level await.  One runtime exits without a verdict, two
 * never report one.  The 5 ms poll is not there to be fast — it is the
 * referenced handle that lets the run report a result.  Default restart
 * options on purpose: this case is about the trigger, and the curve, window
 * and budget are #1254's.
 *
 * On handles: `terminate()` sits in a `finally`, so the live replacement is
 * killed on every path.  The crashed worker is the framework's — `onWorkerDown`
 * unregisters and splices it and never terminates it — and a thread that has
 * died holds nothing, on all three runtimes: a second `worker-init` posted to
 * it goes unanswered, and a module that ends with the dead handle still
 * around exits within 2 ms.  On Deno, the runtime where an abandoned *live*
 * worker would keep the loop alive, `terminate()` of the replacement takes its
 * 250 ms bound and the process exits 1 ms later.  Should that change, the
 * runner's 15 s watchdog turns the leak into a line of stderr rather than a
 * hang (#1196).  Deno also prints the worker's own `Uncaught (in worker
 * "worker-0")` report to stderr before the parent sees the event; that line
 * above a green tick is the runtime's, not a failure.
 */
export const name = 'worker respawn from a real error';
export const description = 'a joined worker that throws is replaced — on Deno from error alone';

/**
 * Generous for hosted runners: a fresh spawn was measured at 25–170 ms
 * locally, and the whole crash-to-replacement path at 200–300 ms.
 */
const REPLACEMENT_BUDGET_MS = 10_000;
/**
 * Longer than the default 200 ms backoff with its ±20 % jitter, twice over —
 * long enough that a second, spurious restart would have replaced the
 * replacement by the time the settle assertion looks.
 */
const SETTLE_MS = 500;

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

export async function run({ actorTs, loadEntry }) {
  const { NoopLogger } = actorTs;
  const { WorkerCluster, WorkerClusterOptions } = await loadEntry('worker');

  const workerOptions = WorkerClusterOptions.create()
    .withBootstrap(new URL('../fixtures/worker-dies-on-command.mjs', import.meta.url))
    .withWorkers(1)
    .withReadyTimeoutMs(REPLACEMENT_BUDGET_MS)
    // The crash is reported through the logger; a noop keeps the framework's
    // report out of a green smoke log.  Assertions are on handles, never on
    // log text.
    .withLogger(new NoopLogger());

  const cluster = await WorkerCluster.spawn(workerOptions);
  try {
    const first = cluster.workers[0];
    if (cluster.size !== 1 || first === undefined) {
      throw new Error(`expected one live worker after spawn, got ${cluster.size}`);
    }
    if (typeof first.readyData?.life !== 'string') {
      throw new Error(`first worker reported no life token: ${JSON.stringify(first.readyData)}`);
    }

    first.worker.postMessage({ kind: 'die' });

    // The slot must be *freed* before it is re-filled — that is the `error`
    // handler running `onWorkerDown`, as opposed to a replacement appearing
    // beside a handle nobody dropped.
    let sawEmptySlot = false;
    const replaced = await awaitUntil(() => {
      if (cluster.size === 0) sawEmptySlot = true;
      const current = cluster.workers[0];
      return current !== undefined && current.worker !== first.worker;
    }, REPLACEMENT_BUDGET_MS);
    if (!replaced) {
      throw new Error(`no replacement within ${REPLACEMENT_BUDGET_MS}ms (size=${cluster.size})`);
    }
    const replacement = cluster.workers[0];
    if (!sawEmptySlot) {
      throw new Error('a replacement appeared without the crashed slot ever being freed');
    }
    if (replacement.id !== first.id || !replacement.address.equals(first.address)) {
      throw new Error(
        `replacement took slot ${replacement.id} at ${replacement.address}, `
        + `expected slot ${first.id} at ${first.address}`,
      );
    }
    if (typeof replacement.readyData?.life !== 'string') {
      throw new Error(`replacement reported no life token: ${JSON.stringify(replacement.readyData)}`);
    }
    if (replacement.readyData.life === first.readyData.life) {
      throw new Error('replacement carries the crashed worker\'s life token — no new handshake ran');
    }

    // One crash, one replacement: the later `close` / `exit` that Bun and Node
    // raise for the same death must not buy a second restart.
    await sleep(SETTLE_MS);
    if (cluster.size !== 1 || cluster.workers[0].worker !== replacement.worker) {
      throw new Error(
        `expected the one replacement to still hold slot 0 after ${SETTLE_MS}ms, `
        + `got size=${cluster.size}`,
      );
    }
  } finally {
    await cluster.terminate();
  }
}
