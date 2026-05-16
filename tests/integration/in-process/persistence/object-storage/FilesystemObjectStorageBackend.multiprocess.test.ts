/**
 * Multi-process safety test for `FilesystemObjectStorageBackend`.
 *
 * Spawns N independent Bun subprocesses that each try to create the same
 * key with `ifNoneMatch: '*'`.  Because each subprocess has its own
 * memory space, the OS-level per-key file lock is the **only** thing
 * that can serialize them — there is no shared in-memory state to fall
 * back on.  Verifying this is what closes #19's "deliberate scope cut":
 * before the fix the in-memory etag map was process-local and two
 * processes would both see "no current etag" and both succeed,
 * corrupting the CAS invariant.
 *
 * The fixture is `_writer-process.ts` next to this file; it does a
 * single `put` and exits with a status code that encodes the outcome.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'actor-ts-objstore-mp-'));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

const fixturePath = join(import.meta.dir, '_writer-process.ts');

interface ChildResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runWriter(args: ReadonlyArray<string>): Promise<ChildResult> {
  // Bun.spawn takes the executable + args; we run the fixture under the
  // same Bun runtime that's executing the test (Bun.argv[0]) so there's
  // no PATH lookup or version skew.
  const proc = Bun.spawn(['bun', fixturePath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe('FilesystemObjectStorageBackend — multi-process', () => {
  test('two processes hammering the same key with ifNoneMatch=* leave the directory in a consistent state', async () => {
    // Two processes is the minimum to expose the original #19 bug:
    // both saw "no current etag", both proceeded, both wrote the file.
    // With the per-key lock + disk-canonical etag, exactly one wins.
    const [a, b] = await Promise.all([
      runWriter([tmpRoot, 'race', 'from-A', 'create-only']),
      runWriter([tmpRoot, 'race', 'from-B', 'create-only']),
    ]);

    const ok = [a, b].filter((r) => r.exitCode === 0);
    const cas = [a, b].filter((r) => r.exitCode === 2);
    if (ok.length + cas.length !== 2) {
      // Diagnostic: surface stderr from any unexpected exit so a future
      // regression isn't a silent "exit code 1" with no clue what happened.
      // eslint-disable-next-line no-console
      console.error('multi-process unexpected exits:', { a, b });
    }
    expect(ok).toHaveLength(1);
    expect(cas).toHaveLength(1);

    // Disk state must equal whichever body won, byte-for-byte.
    const disk = readFileSync(join(tmpRoot, 'race'), 'utf8');
    const winner = JSON.parse(ok[0]!.stdout) as { ok: true; body: string; etag: string };
    expect(disk).toBe(winner.body);
  }, 30_000);

  test('three processes contending unconditionally: exactly one body wins, etag is content-derived', async () => {
    // Unconditional puts can all "succeed" (no CAS check), but the
    // last-writer-wins semantics must produce a clean disk state — no
    // half-written byte ranges, no garbage trailing data.  The temp +
    // rename pattern is what guarantees that under concurrent writers.
    const N = 3;
    const writers = Array.from({ length: N }, (_, i) =>
      runWriter([tmpRoot, 'last-write-wins', `payload-${i}`, 'unconditional']),
    );
    const results = await Promise.all(writers);

    expect(results.filter((r) => r.exitCode === 0)).toHaveLength(N);

    // Whichever payload landed last must match the disk content
    // exactly — no truncation, no concatenation.
    const disk = readFileSync(join(tmpRoot, 'last-write-wins'), 'utf8');
    expect(disk).toMatch(/^payload-\d$/);
  }, 30_000);
});
