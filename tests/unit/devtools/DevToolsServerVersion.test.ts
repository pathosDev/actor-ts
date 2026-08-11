/**
 * The handshake's `serverVersion` must be the version we actually are
 * (#657).
 *
 * `DEVTOOLS_SERVER_VERSION` is hand-maintained — see the constant for
 * why the build cannot supply it — and it drifted from `package.json`
 * across two minor releases without anything noticing.  It is read at
 * exactly the moment accuracy matters most: the overview's `actor-ts`
 * tile (#911) and the connection badge both show it, and it is the
 * first thing quoted in a bug report.
 *
 * So this test is the gate the constant does not have on its own.  It
 * runs in CI on every push and again in `prepublishOnly`, which means a
 * release that bumps `package.json` and forgets the constant fails
 * before it can be published.
 */
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { DEVTOOLS_SERVER_VERSION } from '../../../src/devtools/DevToolsServer.js';

/**
 * Read rather than `import`: a JSON import would need
 * `resolveJsonModule`, which pulls the repository root into the build's
 * `rootDir` — the very thing that stopped the constant being derived in
 * the first place.
 */
async function packageVersion(): Promise<string> {
  const manifest = await readFile(new URL('../../../package.json', import.meta.url), 'utf8');
  return (JSON.parse(manifest) as { version: string }).version;
}

describe('DevTools server version', () => {
  test('matches the version in package.json', async () => {
    expect(DEVTOOLS_SERVER_VERSION).toBe(await packageVersion());
  });

  test('is a plain SemVer triple, as the UI renders it verbatim', () => {
    // The tile prints whatever arrives, so a stray 'v' prefix or a
    // build-metadata tail would show up on the overview as-is.
    expect(DEVTOOLS_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
