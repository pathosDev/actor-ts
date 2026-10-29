/**
 * The DevTools protocol version, written down as a number (#1546).
 *
 * `DEVTOOLS_PROTOCOL_VERSION` is the only compatibility signal between the
 * embedded UI and the server tap: both send it in the `hello` / `welcome`
 * handshake, and a mismatch closes every session.  Every other test compares
 * against the constant itself, so a change to it passed all of them, and
 * `bun run check:ui` cannot see one either — its source-hash covers
 * `devtools-ui/`, not the shared `src/devtools/protocol` the bundle compiles
 * in.
 *
 * A change to this number is a deliberate protocol change.  It follows the
 * evolution contract in `Version.ts`, rebuilds the embedded UI with
 * `bun run build:ui` in the same commit, and edits the literal below.
 */
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'bun:test';
import { UI_ASSETS } from '../../../src/devtools/generated/UiAssets.js';
import { DEVTOOLS_PROTOCOL_VERSION } from '../../../src/devtools/protocol/Version.js';

/**
 * Every protocol version a script of the embedded bundle writes as a literal
 * — the UI's `hello` frame carries it as `protocolVersion: <n>`, with the key
 * quoted or not, however the bundler spells the rest.
 */
function bundledProtocolVersions(): number[] {
  const versions: number[] = [];
  for (const asset of UI_ASSETS) {
    if (!asset.path.endsWith('.js')) continue;
    const text = new TextDecoder().decode(gunzipSync(Buffer.from(asset.gzipBase64, 'base64')));
    for (const match of text.matchAll(/\bprotocolVersion["'`]?\s*:\s*(\d+)/g)) versions.push(Number(match[1]));
  }
  return versions;
}

describe('the DevTools protocol version', () => {
  test('is 2: version 2 widened ConfigSource from three names to five', () => {
    expect(DEVTOOLS_PROTOCOL_VERSION).toBe(2);
  });

  test('is the version the embedded UI bundle says hello with', () => {
    const versions = bundledProtocolVersions();

    // None found means the bundle changed shape, not that it agrees: this
    // test would then pin nothing, so it says so instead of passing.
    expect(versions.length, 'no literal protocolVersion in the embedded UI bundle').toBeGreaterThan(0);
    expect(
      [...new Set(versions)],
      'the embedded UI speaks another protocol version than the server: run `bun run build:ui`',
    ).toEqual([DEVTOOLS_PROTOCOL_VERSION]);
  });
});
