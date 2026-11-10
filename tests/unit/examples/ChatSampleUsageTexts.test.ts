import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * Every in-repo instruction for starting a chat backend has to name the
 * session-token secret, because since #791 none of those commands work
 * without it.
 *
 * This is prose, and prose is normally left to review — but these particular
 * lines are the ones an operator reaches for *immediately after* the refusal,
 * and the example gate cannot see any of them.  `tests/examples/examples.
 * manifest.json` injects `CHAT_ALLOW_DEMO_SECRET=1` for the chat case and
 * skips `failover-test.ts` entirely, so no automated run ever executes a
 * documented bare command.  The gate is green precisely because it does not
 * follow the instructions.
 *
 * Two kinds of assertion, and the difference is worth keeping:
 *
 *  - `--help` is a **program output**, so it is spawned and read.  That is a
 *    real binding: it fails if the text moves out of `printUsage`, if the
 *    array stops being joined, or if the flag stops reaching it.
 *  - the file headers are **comments**, which nothing executes, so reading the
 *    source is the only observation there is.  What keeps that from being a
 *    transcription is the shape asserted rather than the words: a line that
 *    starts a backend must have a secret named just above it.
 */

const TOKEN_SECRET_VARIABLE = 'CHAT_TOKEN_SECRET';
const DEMO_SECRET_OPT_IN_VARIABLE = 'CHAT_ALLOW_DEMO_SECRET';

/** How close above a command the secret has to be named to count as "with" it. */
const PROXIMITY_LINES = 6;

const repositoryRoot = join(import.meta.dir, '..', '..', '..');

/**
 * Absolute, although `cwd: repositoryRoot` would find a relative path too.
 * knip reads the string literals of a `spawn('bun', [...])` call as a script
 * and resolves the file it names against this test's own directory, never the
 * `cwd` option — so a repository-relative literal here is reported as an
 * unresolved import (#1641).
 */
const backendEntryPoint = join(repositoryRoot, 'examples', 'chat', 'backend', 'main.ts');

/**
 * True when the line actually *sets* one of the variables.
 *
 * The `=` is the whole point, and it is not pedantry: a first version of this
 * asked only that the name appear somewhere near the command, and
 * "(CHAT_TOKEN_SECRET was removed in a later release.)" satisfied it.  A
 * header that mentions the variable has not told anyone what to do; one that
 * shows `CHAT_ALLOW_DEMO_SECRET=1` has.
 */
function setsASecret(line: string): boolean {
  return new RegExp(`(${TOKEN_SECRET_VARIABLE}|${DEMO_SECRET_OPT_IN_VARIABLE})\\s*=`).test(line);
}

/**
 * The command on a header line, or `null` when the line is prose.
 *
 * Needed because prose in these headers discusses the same flags it documents
 * — the first version of this test read "`--spawn-backend` starts one, and the
 * child inherits this environment" as an invocation and demanded an export
 * above it.  A command is a line whose content, past the `*` of the block
 * comment, begins with `bun `.
 */
function commandOf(line: string): string | null {
  const content = line.replace(/^\s*\*?\s*/, '');
  return content.startsWith('bun ') ? content : null;
}

/** The leading `/** … *\/` block of a file — the header these items are about. */
function leadingComment(relativePath: string): ReadonlyArray<string> {
  const source = readFileSync(join(repositoryRoot, relativePath), 'utf8');
  const end = source.indexOf('*/');
  expect(source.startsWith('/**'), `${relativePath} does not open with a header comment`).toBe(true);
  expect(end, `${relativePath} has no terminated header comment`).toBeGreaterThan(0);
  return source.slice(0, end).split(/\r?\n/);
}

describe('chat sample usage texts name the session secret (#791)', () => {
  test('`--help` names both variables, ahead of the commands it prints', async () => {
    // Spawned with the variables stripped, which is the state an operator is in
    // when they reach for `--help`: they just hit the refusal.
    const environment = { ...process.env };
    delete environment[TOKEN_SECRET_VARIABLE];
    delete environment[DEMO_SECRET_OPT_IN_VARIABLE];

    const child = spawn('bun', [backendEntryPoint, '--help'], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    const exitCode = await new Promise<number | null>((resolve) => {
      // Capped in the fixture: `--help` exits on its own, and a run that does
      // not is the interesting failure rather than a slow test.
      const watchdog = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve(null);
      }, 30_000);
      child.on('exit', (code) => { clearTimeout(watchdog); resolve(code); });
    });

    expect(exitCode, 'the usage text is what an operator reads after the refusal').toBe(0);
    expect(stdout).toContain(TOKEN_SECRET_VARIABLE);
    expect(stdout).toContain(DEMO_SECRET_OPT_IN_VARIABLE);

    // Ordering, not just presence: the three bare invocations below are the
    // ones that abort, so a secret paragraph printed after them is a footnote.
    const lines = stdout.split(/\r?\n/);
    const firstSecret = lines.findIndex(setsASecret);
    const firstBareInvocation = lines
      .findIndex((line) => line.trim() === 'bun examples/chat/backend/main.ts');
    expect(firstBareInvocation, 'no bare invocation found in the usage text').toBeGreaterThan(-1);
    expect(firstSecret, 'the usage text names no secret at all').toBeGreaterThan(-1);
    expect(
      firstSecret,
      'the secret paragraph must come before the commands that need it',
    ).toBeLessThan(firstBareInvocation);
  }, 45_000);

  // Each entry is a header and the commands in it that start a backend — the
  // two `smoke-test.ts` invocations that only talk to a running one are
  // deliberately absent, because they work without a secret and an instruction
  // to export one there would be noise.
  const headers: ReadonlyArray<{ path: string; startsABackend: (line: string) => boolean }> = [
    {
      path: 'examples/chat/backend/main.ts',
      startsABackend: (line) => line.includes('bun examples/chat/backend/main.ts'),
    },
    {
      // Not one of the surfaces #791 listed, but the same three bare
      // invocations, in the file whose `printUsage` the test above covers.
      path: 'examples/chat/backend/config.ts',
      startsABackend: (line) => line.includes('bun examples/chat/backend/main.ts'),
    },
    {
      path: 'examples/chat/smoke-test.ts',
      startsABackend: (line) => line.includes('bun examples/chat/backend/main.ts')
        || line.includes('--spawn-backend'),
    },
    {
      path: 'examples/chat/failover-test.ts',
      // The script spawns the three nodes itself; they inherit its environment.
      startsABackend: (line) => line.includes('bun examples/chat/failover-test.ts'),
    },
  ];

  for (const { path, startsABackend } of headers) {
    test(`${path}'s header exports a secret with every backend it starts`, () => {
      const lines = leadingComment(path);
      const commands = lines
        .map((line, index) => ({ line: commandOf(line), index }))
        .filter((entry): entry is { line: string; index: number } =>
          entry.line !== null && startsABackend(entry.line));
      expect(commands.length, `no backend-starting command found in ${path}'s header`)
        .toBeGreaterThan(0);

      for (const { line, index } of commands) {
        const above = lines.slice(Math.max(0, index - PROXIMITY_LINES), index);
        expect(
          above.some(setsASecret),
          `${path}: "${line.trim()}" has no secret named in the ${PROXIMITY_LINES} lines above it`,
        ).toBe(true);
      }
    });
  }
});
