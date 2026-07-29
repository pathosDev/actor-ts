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
 * `src/devtools/generated/uiAssets.ts`.  It is the largest single artefact in
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

describe('tree-shaking (#415)', () => {
  test('package.json declares sideEffects: false', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(manifest.sideEffects).toBe(false);
  });

  const barrel = join(repoRoot, 'src/index.ts').replace(/\\/g, '/');
  const devtoolsEntry = join(repoRoot, 'src/devtools/index.ts').replace(/\\/g, '/');

  test('importing Actor does not drag in the embedded DevTools UI', async () => {
    const { text } = await bundleSize(
      `import { Actor } from '${barrel}';\nexport const used = Actor;\n`,
    );
    // The generated module assigns its base64 payload to this identifier, so the
    // name surviving means the whole UI did.
    expect(text).not.toContain('uiAssets');
  });

  test('the canary is a real one — the DevTools entry does carry the UI', async () => {
    // Without this, the assertion above could pass simply because nothing ever
    // references `uiAssets`, and it would keep passing if tree-shaking broke.
    const { text } = await bundleSize(
      `import { DevTools } from '${devtoolsEntry}';\nexport const used = DevTools;\n`,
    );
    expect(text).toContain('uiAssets');
  });

  test('a narrow import is a rounding error next to the whole barrel', async () => {
    const narrow = await bundleSize(
      `import { Actor } from '${barrel}';\nexport const used = Actor;\n`,
    );
    const everything = await bundleSize(
      `import * as everything from '${barrel}';\nexport const used = everything;\n`,
    );
    // Measured at ~1.5 KB against ~2.3 MB, i.e. ~0.1%.  The threshold is two
    // orders of magnitude looser than that so unrelated additions cannot break
    // it, while still failing loudly if the shake stops working.
    expect(narrow.bytes).toBeLessThan(everything.bytes * 0.05);
    expect(narrow.bytes).toBeLessThan(50_000);
  });
});
