/**
 * Example gate (#545).  Runs the bundled `examples/` snippets as real
 * programs and fails when one of them crashes.
 *
 *   bun tests/examples/run-examples.mjs                  # every runnable case
 *   bun tests/examples/run-examples.mjs hello-world      # substring filter
 *   ACTOR_TS_EXAMPLES_VERBOSE=1 bun tests/examples/run-examples.mjs
 *
 * Why this is not `tests/smoke/run-cases.mjs` with a wider glob: that
 * harness is *in-process*.  It imports the framework once and then
 * `import()`s each case, which works because a smoke case is a
 * runtime-neutral module exporting `run(context)`.  An example is the
 * opposite of that by design — a standalone script with a top-level
 * `void main()`, its own argv parsing and, often, a bound port.  Importing
 * one would run it, in the harness's own process, with the harness's argv,
 * and there would be no way to time it out or to reclaim the port.  So the
 * shape here is spawn + wait + kill, and the two harnesses stay separate.
 *
 * Deliberately a plain script rather than a `bun test` suite: routing it
 * through `bun test` would pull `examples/` into bun's coverage denominator,
 * where a snippet that exercises no product code drags the 80 % line floor
 * (`scripts/coverage-gate.mjs`) down for reasons unrelated to test quality.
 *
 * Every standalone example is classified in `examples.manifest.json`, and an
 * example present in the tree but absent from the manifest is a failure —
 * adding a snippet has to be a deliberate "this runs in CI" / "this cannot,
 * because …" decision, never a silent omission.
 */
import { execFile, spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

const harnessDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(harnessDirectory, '..', '..');
const examplesRoot = join(repositoryRoot, 'examples');

/**
 * How deep the sweep looks for standalone scripts.  Depth 2 is
 * `examples/<area>/<name>.ts`, which is where every snippet lives; the
 * directories below that are the chat/voice applications, whose own
 * entry points are listed in the manifest by hand.
 */
const SCAN_DEPTH = 2;

/**
 * Directories under `examples/` that hold a separate npm package rather
 * than actor-ts snippets.  Their dependencies come from a per-directory
 * `npm ci` and are unresolvable from the root install, so nothing here can
 * spawn them; `.github/workflows/examples.yml` builds them instead.
 */
const FRONTEND_DIRECTORY_PREFIX = 'frontend-';

/** Fallback per-case budget for cases that do not set their own. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Grace period between the polite stop and the hard kill.  A cluster
 * example that gets SIGTERM runs CoordinatedShutdown, which unbinds the
 * HTTP server and leaves the cluster; cutting that short is what leaves a
 * port bound for the next case in the run.
 */
const KILL_GRACE_MS = 5_000;

const onWindows = process.platform === 'win32';

const verbose = process.env.ACTOR_TS_EXAMPLES_VERBOSE === '1';
const filters = process.argv.slice(2);

const manifest = JSON.parse(
  await readFile(join(harnessDirectory, 'examples.manifest.json'), 'utf8'),
);

const discovered = await discoverExamples(examplesRoot);
const classified = new Set(manifest.cases.map((entry) => entry.file));

// Guard the guard: a path or glob regression that discovered nothing would
// make the coverage assertion below vacuously pass.
if (discovered.length === 0) {
  console.error(`✗ no examples discovered under ${examplesRoot} — the sweep is broken`);
  process.exit(1);
}

const unclassified = discovered.filter((file) => !classified.has(file));
const stale = manifest.cases
  .map((entry) => entry.file)
  .filter((file) => !discovered.includes(file));

if (unclassified.length > 0 || stale.length > 0) {
  for (const file of unclassified) {
    console.error(`✗ ${file} is not in tests/examples/examples.manifest.json`);
  }
  for (const file of stale) {
    console.error(`✗ ${file} is in the manifest but no longer exists`);
  }
  console.error(
    '\n  Every example is either run by this gate or skipped with a reason.'
    + '\n  Add a { "file": …, "expect": … } entry, or a { "file": …, "skip": "why" } one.',
  );
  process.exit(1);
}

// Shape of the manifest itself.  Enforced rather than left to review,
// because both mistakes it catches produce a *green* run: a duplicated
// entry hides whichever copy loses, and a runnable case with no `expect`
// asserts nothing beyond an exit code that several examples produce while
// failing (see the file header of examples.manifest.json).
const manifestProblems = [];
const seen = new Set();
for (const entry of manifest.cases) {
  if (seen.has(entry.file)) manifestProblems.push(`${entry.file} appears more than once`);
  seen.add(entry.file);
  if (entry.skip === undefined && entry.expect === undefined) {
    manifestProblems.push(`${entry.file} is runnable but has no "expect" — it would assert nothing`);
  }
  if (entry.skip !== undefined && entry.expect !== undefined) {
    manifestProblems.push(`${entry.file} has both "skip" and "expect" — pick one`);
  }
}
if (manifestProblems.length > 0) {
  for (const problem of manifestProblems) console.error(`✗ ${problem}`);
  process.exit(1);
}

const selected = manifest.cases.filter(
  (entry) => filters.length === 0 || filters.some((needle) => entry.file.includes(needle)),
);
const runnable = selected.filter((entry) => entry.skip === undefined);
const skipped = selected.filter((entry) => entry.skip !== undefined);

console.log(
  `→ example gate: ${runnable.length} runnable, ${skipped.length} skipped, `
  + `${discovered.length} classified in total\n`,
);

let failed = 0;
for (const entry of runnable) {
  const startedAt = Date.now();
  const outcome = await runExample(entry);
  const elapsed = Date.now() - startedAt;
  if (outcome.ok) {
    console.log(`✓ ${entry.file} (${elapsed}ms)`);
    if (verbose) process.stdout.write(indent(outcome.output));
  } else {
    console.error(`✗ ${entry.file} (${elapsed}ms) — ${outcome.reason}`);
    process.stderr.write(indent(outcome.output));
    failed++;
  }
}

console.log('');
for (const entry of skipped) {
  console.log(`- ${entry.file} — skipped: ${entry.skip}`);
}

console.log('');
if (failed === 0) {
  console.log(`✓ all ${runnable.length} runnable example(s) passed`);
  process.exit(0);
}
console.error(`✗ ${failed} of ${runnable.length} runnable example(s) failed`);
process.exit(1);

/**
 * Run one example and decide whether it counts as a pass.
 *
 * Two shapes, because the examples come in two shapes.  A snippet that
 * calls `system.terminate()` is expected to exit 0 on its own (`mode:
 * "exit"`); a server example never exits by design, so the pass condition
 * is that it reached its readiness line, after which the harness stops it
 * (`mode: "serve"`).  Both assert on stdout, because "exited 0" alone is
 * satisfied by a script whose `main()` threw inside a swallowed catch.
 */
async function runExample(entry) {
  const mode = entry.mode ?? 'exit';
  const timeoutMs = entry.timeoutMs ?? manifest.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = spawn(
    process.execPath.includes('bun') ? process.execPath : 'bun',
    [toNativePath(entry.file), ...(entry.arguments ?? [])],
    {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(entry.environment ?? {}), FORCE_COLOR: '0' },
      // Own process group, so `stop()` can signal the example *and*
      // whatever it spawned in one call.  Windows has no process groups;
      // `taskkill /T` walks the tree there instead.
      detached: !onWindows,
    },
  );

  let output = '';
  let readySeen = entry.expect === undefined;
  let resolveReady;
  const ready = new Promise((resolveReadyPromise) => { resolveReady = resolveReadyPromise; });
  const absorb = (chunk) => {
    output += chunk.toString('utf8');
    if (!readySeen && output.includes(entry.expect)) {
      readySeen = true;
      resolveReady();
    }
  };
  child.stdout.on('data', absorb);
  child.stderr.on('data', absorb);

  const exited = new Promise((resolveExit) => {
    child.on('error', (error) => resolveExit({ kind: 'spawn-error', error }));
    child.on('exit', (code, signal) => resolveExit({ kind: 'exit', code, signal }));
  });
  const timedOut = delay(timeoutMs).then(() => ({ kind: 'timeout' }));

  const first = mode === 'serve'
    ? await Promise.race([exited, timedOut, ready.then(() => ({ kind: 'ready' }))])
    : await Promise.race([exited, timedOut]);

  if (first.kind === 'spawn-error') {
    await stop(child);
    return { ok: false, reason: `failed to spawn: ${first.error.message}`, output };
  }
  if (first.kind === 'timeout') {
    await stop(child);
    return {
      ok: false,
      reason: mode === 'serve'
        ? `never printed ${JSON.stringify(entry.expect)} within ${timeoutMs}ms`
        : `did not exit within ${timeoutMs}ms`,
      output,
    };
  }
  if (first.kind === 'ready') {
    // A server example passes the moment it is serving; keeping it alive
    // any longer only holds the port against the next case.
    await stop(child);
    return { ok: true, output };
  }

  await stop(child);
  if (first.code !== 0) {
    return {
      ok: false,
      reason: first.signal !== null && first.signal !== undefined
        ? `killed by ${first.signal}`
        : `exited ${first.code}`,
      output,
    };
  }
  if (!readySeen) {
    return {
      ok: false,
      reason: `exited 0 but never printed ${JSON.stringify(entry.expect)}`,
      output,
    };
  }
  return { ok: true, output };
}

/**
 * Stop an example and everything it spawned.
 *
 * The unit stopped here is the process *tree*, not the child, because
 * `child.kill()` alone demonstrably is not enough: `chat/failover-test.ts`
 * spawns three cluster nodes, and while classifying, two of them outlived
 * the run and kept holding 2552/2553 — which made every later example that
 * binds a cluster port fail with EADDRINUSE, and made the chat smoke test
 * pass against a backend that was supposed to be gone.  A gate whose cases
 * can poison each other that way reports the run order, not the code.
 *
 * SIGTERM first so an example's CoordinatedShutdown hook gets to unbind its
 * port; SIGKILL only once the grace period is up.
 */
async function stop(child) {
  if (child.pid === undefined) return;
  const stillRunning = child.exitCode === null && child.signalCode === null;

  if (onWindows) {
    // `taskkill /T` walks the tree from the root down, so it can only be
    // useful while the root is still there — and Windows has no real
    // SIGTERM to try first (node maps it to TerminateProcess anyway), so
    // there is no graceful step to lose by going straight to it.
    if (!stillRunning) return;
    await new Promise((resolveReap) => {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolveReap());
    });
    return;
  }

  if (stillRunning) {
    const exited = new Promise((resolveExit) => child.on('exit', () => resolveExit(true)));
    signalGroup(child, 'SIGTERM');
    const stoppedInTime = await Promise.race([exited, delay(KILL_GRACE_MS).then(() => false)]);
    if (!stoppedInTime) {
      signalGroup(child, 'SIGKILL');
      await Promise.race([exited, delay(KILL_GRACE_MS)]);
    }
  }
  // Unconditional on POSIX: a process group outlives its leader, so this
  // still reaches descendants left behind by a *clean* parent exit — which
  // is exactly how failover-test's two backends escaped.
  signalGroup(child, 'SIGKILL');
}

/**
 * Signal the child's whole process group.  POSIX only — see `stop()`.
 *
 * Falls back to signalling the child alone if the group is not there to be
 * signalled.  That is usually just an already-empty group (ESRCH, nothing
 * to do), but it would also be what a `detached: true` that did not take
 * effect looks like — and in that case the group signal is the *only* thing
 * stopping the example, so swallowing the failure would leave every server
 * case running until the job timeout.  Falling back costs nothing and turns
 * that into a leak of one process instead of all of them.
 */
function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/**
 * Every standalone `.ts` under `examples/` down to {@link SCAN_DEPTH},
 * as repository-relative POSIX paths so the manifest reads the same on
 * every platform.
 */
async function discoverExamples(root) {
  const found = [];
  const walk = async (directory, depth) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const dirent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (dirent.isDirectory()) {
        if (depth >= SCAN_DEPTH) continue;
        if (dirent.name === 'node_modules') continue;
        if (dirent.name.startsWith(FRONTEND_DIRECTORY_PREFIX)) continue;
        await walk(join(directory, dirent.name), depth + 1);
        continue;
      }
      if (!dirent.name.endsWith('.ts')) continue;
      if (dirent.name.endsWith('.d.ts')) continue;
      found.push(toPosixPath(relative(repositoryRoot, join(directory, dirent.name))));
    }
  };
  await walk(root, 1);
  return found.sort();
}

function toPosixPath(path) { return path.split(sep).join(posix.sep); }
function toNativePath(path) { return path.split(posix.sep).join(sep); }

function delay(ms) {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    if (typeof timer === 'object' && timer !== null) timer.unref?.();
  });
}

function indent(text) {
  const body = text.trimEnd();
  if (body === '') return '';
  return `${body.split('\n').map((line) => `    │ ${line}`).join('\n')}\n`;
}
