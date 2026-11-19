import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

/**
 * The Kubernetes pages' code samples compile against the published API.
 *
 * `scripts/check-doc-samples.mjs` type-checks documentation fences, but it is
 * not a CI gate yet — the whole tree still carries findings — so a page can
 * rot without anything turning red.  The two Kubernetes pages had: the
 * deployment recipe used `HttpExtensionId` without importing it and bound a
 * `routes` it never defined, and the seed-provider page passed the
 * `NodeAddress[]` that `lookup()` returns straight to `withSeeds`, which takes
 * strings, inside a sample with no `system` in scope.  These are the pages
 * people copy into a cluster, so they are held to a clean compile on their
 * own, in both languages, until the harness gates everything.
 *
 * Driven the way `DocSampleHarnessEndToEnd.test.ts` drives the harness: the
 * pages are copied into a fixture under the gitignored `tmp/`, one directory
 * below the root, because the generated tsconfig resolves `actor-ts…` from
 * there.
 */

const ROOT = join(import.meta.dir, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-doc-samples.mjs');
const DOCUMENTATION_ROOT = join(ROOT, 'docs', 'src', 'content', 'docs');

const PAGES: ReadonlyArray<string> = [
  'operations/deployment/kubernetes.mdx',
  'de/operations/deployment/kubernetes.mdx',
  'discovery/seed-providers/kubernetes-api.mdx',
  'de/discovery/seed-providers/kubernetes-api.mdx',
];

/** As in `DocSampleHarnessEndToEnd.test.ts`: ~6x the slowest measured run. */
const RUN_BUDGET_MS = 30_000;
const HOOK_BUDGET_MS = 3 * RUN_BUDGET_MS;

let fixture = '';
let outName = '';
let result: { readonly status: number; readonly output: string };

beforeAll(() => {
  mkdirSync(join(ROOT, 'tmp'), { recursive: true });
  fixture = mkdtempSync(join(ROOT, 'tmp', 'kubernetes-samples-'));
  outName = `tmp/kubernetes-samples-out-${String(process.pid)}`;
  for (const page of PAGES) {
    const target = join(fixture, page);
    mkdirSync(join(target, '..'), { recursive: true });
    copyFileSync(join(DOCUMENTATION_ROOT, page), target);
  }
  const run = spawnSync(
    process.execPath,
    [SCRIPT, `--docs=${relative(ROOT, fixture).split('\\').join('/')}`, `--out=${outName}`],
    { cwd: ROOT, encoding: 'utf8', timeout: RUN_BUDGET_MS },
  );
  if (run.error !== undefined || run.signal !== null) {
    throw new Error(`check-doc-samples.mjs did not complete: ${run.error?.message ?? `killed by ${run.signal}`}`);
  }
  result = { status: run.status ?? -1, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}, HOOK_BUDGET_MS);

afterAll(() => {
  // Only once assigned: on Bun, rmSync('', { recursive: true }) empties the cwd.
  if (fixture !== '') rmSync(fixture, { recursive: true, force: true });
  if (outName !== '') rmSync(join(ROOT, outName), { recursive: true, force: true });
});

describe('Kubernetes page samples compile', () => {
  test('every compiled fence on the four pages is clean', () => {
    expect({ status: result.status, output: result.status === 0 ? '' : result.output })
      .toEqual({ status: 0, output: '' });
  });

  test('the samples were actually compiled, not classified away', () => {
    // One app sample per deployment page, one per seed-provider page.
    const compiled = /compiled\s+(\d+)/.exec(result.output);
    expect(Number(compiled?.[1] ?? 0)).toBeGreaterThanOrEqual(PAGES.length);
  });
});
