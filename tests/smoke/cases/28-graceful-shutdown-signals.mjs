/**
 * Smoke case: a signal reaches CoordinatedShutdown, and the handlers come
 * back off afterwards (#549).
 *
 * Cross-runtime because signal delivery is the one lifecycle primitive with
 * no shared implementation.  Bun and Node deliver through `process.on`;
 * Deno's `process` shim carries no signal events at all, so the old
 * `process.on(signal, …)` inside `installProcessHooks` registered nothing
 * there and reported success — a Deno service simply never ran its shutdown
 * pipeline, and no in-process test could see it.  That is what
 * `src/runtime/signals/` exists for and what this case guards.
 *
 * Three things are asserted, and the first is the one no in-process test can
 * reach:
 *
 *  1. the child **survives** the wait.  A signal handler is not a reason for
 *     a runtime to keep running — Node unrefs its signal handles — so a
 *     `runUntilTerminated()` that holds nothing of its own drains an
 *     otherwise-idle event loop and the process exits before the signal it
 *     armed itself for ever arrives (Node says `Detected unsettled top-level
 *     await` and exits 13);
 *  2. the phases run, in order, when the process is signalled;
 *  3. the child exits **by itself**, with status 0.  A `Deno.addSignalListener`
 *     listener holds the event loop open and has no `unref`, so a
 *     `runUntilTerminated()` that forgot to detach its handlers would print
 *     a green ORDER line and then hang forever.  Nothing but a separate
 *     process can catch that.
 *
 * **Windows degradation.**  `.github/workflows/multi-runtime.yml` runs the
 * smoke matrix on ubuntu, so CI exercises real POSIX signals on all three
 * runtimes.  A maintainer's local `bun run smoke` is the Windows case:
 * `child.kill('SIGTERM')` there is `TerminateProcess`, which no runtime can
 * catch, and Deno accepts only SIGINT/SIGBREAK anyway.  So on Windows the
 * child idles for a beat and then starts the pipeline itself: only the OS
 * delivery step is skipped, and assertions 1 and 3 — the two that are about
 * the event loop rather than about the kernel — are exactly as sharp as they
 * are in CI.  A documented weakening on one platform, not a different case.
 *
 * That idle beat is why the child does not simply start the pipeline at once
 * (#549 shipped with it doing so).  Without a window in which the process has
 * nothing referenced on its event loop, assertion 1 is unreachable on every
 * platform, and the Windows run degrades from "weaker" to "vacuous" — which
 * is how a Node-only regression reached `develop` past a green local run.
 *
 * Handle hygiene (#1196): the child is reaped in a `finally` on every path
 * and every timer is cleared, because a case that leaves either behind makes
 * the whole Deno run hang after its last green line — which costs the gate
 * its exit code.
 */
import { spawn } from 'node:child_process';

export const name = 'graceful shutdown signals';
export const description = 'a signal runs the shutdown phases and leaves no handler behind';

/** How long the child gets to print READY, and then to exit after the signal. */
const CHILD_READY_TIMEOUT_MS = 20_000;
const CHILD_EXIT_TIMEOUT_MS = 20_000;

const EXPECTED_ORDER = 'service-unbind,service-stop,cluster-leave,before-actor-system-terminate';

export async function run({ runtime }) {
  const onWindows = globalThis.Deno !== undefined
    ? globalThis.Deno.build.os === 'windows'
    : globalThis.process.platform === 'win32';
  const mode = onWindows ? 'self' : 'signal';

  const child = spawn(
    ...childCommand(runtime, readEnvironment('ACTOR_TS_SMOKE_USE_DIST') === '1', mode),
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  try {
    await waitUntil(
      () => stdout.includes('READY'),
      CHILD_READY_TIMEOUT_MS,
      () => 'child never became ready — '
        + `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    );

    if (mode === 'signal') signalChild(child);

    const outcome = await withDeadline(
      exited,
      CHILD_EXIT_TIMEOUT_MS,
      () => 'child did not exit on its own — a signal handler is still armed and holding the '
        + `event loop open. stdout=${JSON.stringify(stdout)}`,
    );

    if (outcome.code !== 0) {
      throw new Error(
        `child exited with code=${outcome.code} signal=${outcome.signal}; `
        + `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
      );
    }
    if (!stdout.includes(`ORDER ${EXPECTED_ORDER}`)) {
      throw new Error(
        `shutdown phases did not run in order — expected "ORDER ${EXPECTED_ORDER}", `
        + `got ${JSON.stringify(stdout)}`,
      );
    }
  } finally {
    // Every path, not just the happy one: an abandoned child keeps a pipe
    // open and the harness then hangs after its last green line.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
}

/**
 * Deliver the SIGTERM this case is about.
 *
 * `child.kill('SIGTERM')` is the obvious call, and it is the wrong one when
 * the *parent* is Deno.  Deno's `node:child_process` sets `signalCode` at
 * `kill()` time rather than reading it from the wait status, and then reports
 * a null exit code whenever `signalCode` is set:
 *
 * ```js
 * this.signalCode = this.signalCode || status.signal || null;
 * if (this.signalCode) { this.exitCode = null; } else { this.exitCode = status.code; }
 * ```
 *
 * So a child that handled the signal, ran the whole pipeline and exited 0 by
 * itself still arrives at the `exit` event as `code=null signal=SIGTERM` —
 * indistinguishable from one the signal killed outright, and impossible to
 * pass the "exits by itself, with status 0" half of this case with.  That is
 * a divergence from Node, where `signalCode` comes only from the wait status,
 * and it made the Deno arm red for a child that was behaving perfectly.
 *
 * `Deno.kill` goes straight to the pid and leaves the polyfill's bookkeeping
 * untouched, so the exit status stays observable and the assertion keeps its
 * teeth on all three runtimes.  It needs `--allow-run`, which `smoke:deno`
 * already grants for the spawn itself.
 */
function signalChild(child) {
  if (globalThis.Deno !== undefined) {
    globalThis.Deno.kill(child.pid, 'SIGTERM');
    return;
  }
  child.kill('SIGTERM');
}

/**
 * `[command, argumentList]` for running the child fixture under the runtime
 * we are on.
 *
 * Deno is the odd one out: it needs the `run` subcommand and its permissions
 * spelled out, because a child inherits none of the parent's grants.
 */
function childCommand(runtime, importFromBuild, mode) {
  const entryUrl = new URL(
    importFromBuild ? '../../../dist/index.js' : '../../../src/index.ts',
    import.meta.url,
  ).href;
  const childPath = urlToPath(new URL('../fixtures/graceful-shutdown-child.mjs', import.meta.url));
  const childArguments = [childPath, entryUrl, mode];

  if (runtime === 'deno') {
    return [
      globalThis.Deno.execPath(),
      ['run', '--allow-read', '--allow-env', '--allow-write', '--allow-net', ...childArguments],
    ];
  }
  return [globalThis.process.execPath, childArguments];
}

/** Read an environment variable without assuming which runtime exposes it how. */
function readEnvironment(name) {
  if (globalThis.Deno !== undefined) return globalThis.Deno.env.get(name);
  return globalThis.process.env[name];
}

/** `fileURLToPath` for the one shape we produce, without a `node:url` import. */
function urlToPath(url) {
  const path = decodeURIComponent(url.pathname);
  // Windows file URLs arrive as `/C:/…`; the leading slash is not part of it.
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}

async function waitUntil(predicate, timeoutMs, describeFailure) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(describeFailure());
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Race `promise` against a deadline, and **always** clear the timer.
 *
 * Not merely tidy: an uncleared rejection timer that fires after the race is
 * decided is an unhandled rejection, which on two of the three runtimes
 * takes the whole harness down long after this case reported green.
 */
async function withDeadline(promise, timeoutMs, describeFailure) {
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(describeFailure())), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
