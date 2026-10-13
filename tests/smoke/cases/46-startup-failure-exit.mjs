/**
 * Smoke case: a startup task that fails ends a process that awaits
 * `runUntilTerminated()`, by itself and non-zero (#1473).
 *
 * Cross-runtime because every link in that chain is a runtime question.  The
 * failure must take the system down through the coordinated-shutdown
 * pipeline; `runUntilTerminated()` must then give back the keep-alive timer it
 * holds and the signal handlers it installed — a `Deno.addSignalListener`
 * listener left behind holds Deno's event loop open for good — and reject;
 * and the runtime must turn that rejection into a failing exit.  No
 * in-process test can watch a process decide to stop.
 *
 * The child runs twice, once per mode of its fixture:
 *
 *  - **uncaught** — `main` catches nothing.  The child must exit by itself,
 *    not killed by a signal, with a non-zero status, and its stderr must name
 *    the failed task: so the status is the startup failure reaching `main`,
 *    not an import error or a crash before the system existed.  A
 *    `runUntilTerminated()` that resolved would exit 0 and tell an
 *    orchestrator the service had stopped cleanly.
 *  - **caught** — `main` catches the error and sets the exit code itself.  An
 *    uncaught error ends a process whatever its event loop still holds, so
 *    the first run cannot see a handle left behind; this one can, because
 *    only an empty event loop lets it exit.
 *
 * No signal is sent, so the case runs the same on Windows as in CI.
 *
 * Handle hygiene (#1196): each child is reaped in a `finally` on every path
 * and every deadline timer is cleared, because a case that leaves either
 * behind makes the whole Deno run hang after its last green line.
 */
import { spawn } from 'node:child_process';

export const name = 'startup failure exit';
export const description = 'a failed startup task ends a process awaiting runUntilTerminated, non-zero';

/** How long each child gets to fail its startup, shut down and exit. */
const CHILD_EXIT_TIMEOUT_MS = 20_000;

/** The task the child's startup fails in — what its output has to name. */
const FAILED_TASK = 'smoke-open-journal';

/** The status the fixture's `caught` mode sets for itself. */
const CAUGHT_EXIT_CODE = 3;

export async function run({ runtime }) {
  const importFromBuild = readEnvironment('ACTOR_TS_SMOKE_USE_DIST') === '1';

  const uncaught = await runChild(runtime, importFromBuild, 'uncaught');
  if (uncaught.code === 0 || uncaught.code === null) {
    throw new Error(`uncaught: expected a non-zero status, ${uncaught.describe()}`);
  }
  if (!uncaught.stderr.includes(FAILED_TASK)) {
    throw new Error(
      `uncaught: the child exited with ${uncaught.code}, but its stderr does not name the failed `
      + `startup task "${FAILED_TASK}" — it stopped for another reason. ${uncaught.describe()}`,
    );
  }

  const caught = await runChild(runtime, importFromBuild, 'caught');
  if (caught.code !== CAUGHT_EXIT_CODE) {
    throw new Error(`caught: expected the status main set, ${CAUGHT_EXIT_CODE}; ${caught.describe()}`);
  }
  if (!caught.stdout.includes(`CAUGHT Startup task "${FAILED_TASK}"`)) {
    throw new Error(`caught: runUntilTerminated() did not reject with the startup error; ${caught.describe()}`);
  }
}

/**
 * Run the fixture in `mode` and answer with how it ended — once it has exited
 * by itself, inside the deadline, after printing `CREATED` and never
 * `RESOLVED`.  Anything else throws.
 */
async function runChild(runtime, importFromBuild, mode) {
  const child = spawn(...childCommand(runtime, importFromBuild, mode), { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const outcome = await withDeadline(
      exited,
      CHILD_EXIT_TIMEOUT_MS,
      () => `${mode}: the child did not exit on its own after its startup failed — the system `
        + 'stayed up, or runUntilTerminated() left a handle behind. '
        + `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    );
    const describe = () =>
      `code=${outcome.code} signal=${outcome.signal} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`;
    if (!stdout.includes('CREATED')) {
      throw new Error(`${mode}: the child never got as far as ActorSystem.create — ${describe()}`);
    }
    if (outcome.signal !== null) {
      throw new Error(`${mode}: the child was killed by a signal rather than exiting by itself — ${describe()}`);
    }
    if (stdout.includes('RESOLVED')) {
      throw new Error(`${mode}: runUntilTerminated() resolved after a failed startup — ${describe()}`);
    }
    return { code: outcome.code, stdout, stderr, describe };
  } finally {
    // Every path, not just the happy one: an abandoned child keeps a pipe
    // open and the harness then hangs after its last green line.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
}

/**
 * `[command, argumentList]` for running the child fixture under the runtime
 * we are on — Deno needs the `run` subcommand and its permissions spelled
 * out, because a child inherits none of the parent's grants.
 */
function childCommand(runtime, importFromBuild, mode) {
  const entryUrl = new URL(
    importFromBuild ? '../../../dist/index.js' : '../../../src/index.ts',
    import.meta.url,
  ).href;
  const childPath = urlToPath(new URL('../fixtures/startup-failure-child.mjs', import.meta.url));
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

/**
 * Race `promise` against a deadline, and **always** clear the timer — an
 * uncleared rejection timer firing after the race is decided is an unhandled
 * rejection, which on two of the three runtimes takes the harness down.
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
