import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';

/**
 * Where in start-up the chat sample decides it has no signing secret (#791).
 *
 * `ChatSessionSecret.test.ts` covers *that* it refuses — this covers *when*.
 * The two are separable, and the second was the one nothing held: the throw
 * lived in `new SessionStore(...)`, which `main.ts` reached at step 5, after
 * the data directory had been created, after the SQLite journal and snapshot
 * store had been registered and resolved, and after `Cluster.join` had bound
 * the transport and started contacting seeds.  `main().catch` then wrote the
 * stack and called `process.exit(1)` with no `cluster.leave()` and no store
 * close, because the `close-persistence` shutdown task is registered further
 * down the same function.  So a forgotten variable left a data directory
 * behind and a log tail whose last line says the node is listening.
 *
 * A unit assertion cannot see that: the ordering is a property of the entry
 * point, and `main.ts` joins a cluster and binds sockets on import, so there
 * is nothing to call.  Spawning it is the only observation available, and it
 * is worth the second it costs — the "fix" that satisfies every in-process
 * test here is one that moves nothing at all.
 *
 * What the child is told:
 *  - neither secret variable in its environment (stripped, not merely unset
 *    in this shell — the machine running this may export one);
 *  - `--seeds ""`, so it never reaches for a cluster a developer has up;
 *  - ports found free at run time, because the CLI rejects `--port 0`;
 *  - a `--data-dir` that does not exist yet, which is the assertion.
 */

const TOKEN_SECRET_VARIABLE = 'CHAT_TOKEN_SECRET';
const DEMO_SECRET_OPT_IN_VARIABLE = 'CHAT_ALLOW_DEMO_SECRET';

/** The log line `Cluster.join` emits once the transport is bound. */
const TRANSPORT_BOUND_LINE = 'cluster transport listening';

/**
 * Hard cap for the child, enforced in the fixture rather than by bun's
 * per-test timeout: a backend that reached `runUntilTerminated` never exits on
 * its own, and a test that only times out reports "slow", not "it started".
 */
const CHILD_BUDGET_MS = 30_000;

const repositoryRoot = join(import.meta.dir, '..', '..', '..');

/**
 * Absolute, although `cwd: repositoryRoot` would find a relative path too.
 * knip reads the string literals of a `spawn('bun', [...])` call as a script
 * and resolves the file it names against this test's own directory, never the
 * `cwd` option — so a repository-relative literal here is reported as an
 * unresolved import (#1641).
 */
const backendEntryPoint = join(repositoryRoot, 'examples', 'chat', 'backend', 'main.ts');

const scratchDirectories: string[] = [];

afterAll(() => {
  for (const directory of scratchDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch { /* the whole point is that it usually is not there */ }
  }
});

/** A port nothing holds right now — `--port 0` is refused by the CLI. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('no numeric port from the probe listener')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

type BackendRun = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly dataDir: string;
};

/**
 * Run `backend/main.ts` to completion with the two secret variables removed
 * from its environment, and report everything the assertions need.
 */
async function runBackendWithoutSecret(extraArguments: ReadonlyArray<string> = []): Promise<BackendRun> {
  const dataDir = join(tmpdir(), `actor-ts-chat-order-${crypto.randomUUID()}`);
  scratchDirectories.push(dataDir);

  const environment = { ...process.env };
  delete environment[TOKEN_SECRET_VARIABLE];
  delete environment[DEMO_SECRET_OPT_IN_VARIABLE];

  const child = spawn('bun', [
    backendEntryPoint,
    '--port', String(await freePort()),
    '--http-port', String(await freePort()),
    // Explicitly empty: the port scan would otherwise find whatever cluster
    // the machine running this already has up.
    '--seeds', '',
    '--data-dir', dataDir,
    ...extraArguments,
  ], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    // No `shell`, deliberately: `cmd.exe` drops the empty `--seeds ""`
    // argument, and `--data-dir` then lands in the seed list — the node
    // fails validating seeds instead of reaching the thing under test.
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });

  const { exitCode, timedOut } = await new Promise<{ exitCode: number | null; timedOut: boolean }>(
    (resolve) => {
      const watchdog = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve({ exitCode: null, timedOut: true });
      }, CHILD_BUDGET_MS);
      child.on('exit', (code) => {
        clearTimeout(watchdog);
        resolve({ exitCode: code, timedOut: false });
      });
    },
  );

  return { exitCode, stdout, stderr, timedOut, dataDir };
}

describe('chat sample start-up order for the session secret (#791)', () => {
  test('a node with no secret stops before it touches anything', async () => {
    const run = await runBackendWithoutSecret();

    expect(run.timedOut, `the backend never exited within ${CHILD_BUDGET_MS}ms`).toBe(false);
    expect(
      run.stderr,
      'the refusal must name the variable the operator has to set',
    ).toContain(`${TOKEN_SECRET_VARIABLE} is not set`);
    expect(run.exitCode).toBe(1);

    // The three observable side effects the old ordering left behind.  Each is
    // a separate way for the check to be "present but too late", so each is
    // asserted rather than folded into one.
    expect(
      run.stdout,
      'the node bound its cluster transport before deciding it had no secret',
    ).not.toContain(TRANSPORT_BOUND_LINE);
    expect(
      existsSync(run.dataDir),
      'the node created its data directory before deciding it had no secret',
    ).toBe(false);
    expect(
      run.stdout,
      'the node registered its SQLite plugins before deciding it had no secret',
    ).not.toContain('SQLite journal');
  }, CHILD_BUDGET_MS + 15_000);

  test('`--help` still answers without a secret, because it is the answer', async () => {
    // The plausible over-broad fix is a module-level check, which would make
    // the one command that explains the variables the one command that needs
    // them.  `parseArguments` prints usage and exits 0 before the resolve.
    const run = await runBackendWithoutSecret(['--help']);

    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('Usage: bun examples/chat/backend/main.ts');
    expect(run.stderr).not.toContain(`${TOKEN_SECRET_VARIABLE} is not set`);
  }, CHILD_BUDGET_MS + 15_000);
});
