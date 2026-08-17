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
 * Two things are asserted, and the second matters as much as the first:
 *
 *  1. the phases run, in order, when the process is signalled;
 *  2. the child exits **by itself**, with status 0.  A `Deno.addSignalListener`
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
 * child starts the pipeline itself and only the OS delivery step is skipped
 * — the ordering and the clean exit are still under test.  A documented
 * weakening on one platform, not a different case.
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

    if (mode === 'signal') child.kill('SIGTERM');

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
