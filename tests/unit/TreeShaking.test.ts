import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `"sideEffects": false` is a promise to a consumer's bundler: nothing in this
 * package does work at import time, so anything unreferenced may be dropped.
 * A flag alone is not evidence — these tests bundle a narrow import and check
 * what actually survives.
 *
 * The canary is the DevTools UI, which is embedded as a ~44 KB base64 string in
 * `src/devtools/generated/UiAssets.ts`.  It is the largest single artefact in
 * the tree and reachable from the barrel, so if tree-shaking were broken an
 * `Actor`-only import would carry the whole web UI into every consumer bundle.
 */

const repoRoot = join(import.meta.dir, '..', '..');

async function bundleSize(source: string): Promise<{ bytes: number; text: string }> {
  // A real file on disk: Bun.build resolves entrypoints against the filesystem
  // and rejects a data: URL.
  const dir = mkdtempSync(join(tmpdir(), 'actor-ts-shake-'));
  try {
    const entry = join(dir, 'entry.ts');
    writeFileSync(entry, source, 'utf8');
    const built = await Bun.build({ entrypoints: [entry], target: 'bun', minify: false });
    if (!built.success) {
      throw new Error(`bundle failed: ${built.logs.map(String).join('\n')}`);
    }
    const text = await built.outputs[0]!.text();
    return { bytes: text.length, text };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const barrel = join(repoRoot, 'src/index.ts').replace(/\\/g, '/');
const devtoolsEntry = join(repoRoot, 'src/devtools/index.ts').replace(/\\/g, '/');

/**
 * The bundles are built here, at module scope, and not inside the tests that
 * assert on them (#1394).
 *
 * A `bundleSize` call is bounded work that always completes, but inside a
 * `test()` body it races bun's per-test timeout — 5 000 ms, which nothing in
 * `bunfig.toml` raises and which `tests/unit/ci/AwaitConditionBudgets.test.ts`
 * pins and re-measures against a spawned child run.  The margin is thinner
 * than it looks.  The heaviest body here measured **109.7 ms** idle, against
 * the 29.1 ms that `tests/unit/CoreStaticImports.test.ts` was doing when a
 * full `bun test --coverage` run stretched it ~230x to 6 723.89 ms and bun
 * killed it (#1392).  This file carried 3.7x that exposure on the same cap,
 * so it is the same defect one step from being observed, and it takes the
 * same remedy: module scope has no per-test timeout at all.
 *
 * A larger third argument would be the wrong tool here for the reason that
 * gate exists — a third argument sizes a *failure budget*, a wait meant to
 * expire and print a label.  A bundle build has none, so there is nothing to
 * report and no honest number to pick.
 *
 * Building here also removes a duplicate.  The narrow bundle was built twice
 * from byte-identical source — once for the `UiAssets` assertion, again as the
 * baseline of the size comparison — so three builds now do what four did.
 */
const narrow = await bundleSize(
  `import { Actor } from '${barrel}';\nexport const used = Actor;\n`,
);
const devtools = await bundleSize(
  `import { DevTools } from '${devtoolsEntry}';\nexport const used = DevTools;\n`,
);
const everything = await bundleSize(
  `import * as everything from '${barrel}';\nexport const used = everything;\n`,
);

describe('tree-shaking (#415)', () => {
  test('package.json declares sideEffects: false', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(manifest.sideEffects).toBe(false);
  });

  test('importing Actor does not drag in the embedded DevTools UI', () => {
    // The generated module assigns its base64 payload to this identifier, so the
    // name surviving means the whole UI did.
    expect(narrow.text).not.toContain('UiAssets');
  });

  test('the canary is a real one — the DevTools entry does carry the UI', () => {
    // Without this, the assertion above could pass simply because nothing ever
    // references `UiAssets`, and it would keep passing if tree-shaking broke.
    expect(devtools.text).toContain('UiAssets');
  });

  test('a narrow import is a rounding error next to the whole barrel', () => {
    // Measured at ~1.5 KB against ~2.3 MB, i.e. ~0.1%.  The threshold is two
    // orders of magnitude looser than that so unrelated additions cannot break
    // it, while still failing loudly if the shake stops working.
    expect(narrow.bytes).toBeLessThan(everything.bytes * 0.05);
    expect(narrow.bytes).toBeLessThan(50_000);
  });
});
