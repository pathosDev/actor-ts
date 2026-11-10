import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The RSA public-exponent rule (#810) on every runtime this machine has, not
 * only the one `bun test` runs on.
 *
 * The exponent is where the three runtimes' WebCrypto disagree.  With a
 * public exponent of 1, Node 26 imports the key and verifies a token whose
 * signature is the encoding of its own hash; Bun's verify refuses that
 * signature; Deno imports the key and throws once it is asked to verify with
 * it.  A refusal seen only under Bun therefore proves nothing for the runtime
 * where it matters, so `JwtAuthRsaExponentRuntimes.fixture.ts` is bundled once
 * and run under each runtime, every route a key can take — a configured JWK, a
 * configured PEM key, a JWK-set entry — against the same forged token.
 *
 * A runtime that is not installed is skipped by name.  That is a capability
 * probe, not a setting: no workflow can make `node` exist by exporting a
 * variable.
 */

const fixture = join(import.meta.dir, 'JwtAuthRsaExponentRuntimes.fixture.ts');

let directory = '';
afterAll(() => {
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
});

// Bundled at module scope, not in a test: the build is bounded work, but
// inside a test body it would race bun's per-test timeout for nothing.
directory = mkdtempSync(join(tmpdir(), 'actor-ts-jwt-exponent-'));
const built = await Bun.build({ entrypoints: [fixture], outdir: directory, target: 'node', format: 'esm', naming: 'exponent-check.mjs' });
if (!built.success) throw new Error(`bundling the fixture failed: ${built.logs.map(String).join('\n')}`);
const bundle = join(directory, 'exponent-check.mjs');

type Runtime = { readonly name: string; readonly command: readonly string[] | undefined };

const node = Bun.which('node');
const deno = Bun.which('deno');
const runtimes: readonly Runtime[] = [
  { name: 'Bun', command: [process.execPath] },
  { name: 'Node', command: node === null ? undefined : [node] },
  { name: 'Deno', command: deno === null ? undefined : [deno, 'run', '--quiet', '--no-prompt'] },
];

/** What the fixture reported, run by `command`: one answer per route, plus the runtime's own WebCrypto verdict. */
const answersOf = (command: readonly string[]): Record<string, string> => {
  const child = spawnSync(command[0]!, [...command.slice(1), bundle], { encoding: 'utf8', timeout: 25_000 });
  if (child.status !== 0) throw new Error(`the fixture exited ${String(child.status)}: ${child.stderr}`);
  return JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '') as Record<string, string>;
};

describe('a token forged for RSA public exponent 1 is refused on every route, on every runtime', () => {
  for (const runtime of runtimes) {
    const command = runtime.command;
    const name = command === undefined ? `${runtime.name} (not installed here)` : runtime.name;
    (command === undefined ? test.skip : test)(name, () => {
      const answers = answersOf(command!);
      const importRefusal = '500 JwtAuth: publicKeys[0] could not be imported: ';
      // One comparison, so a failure shows every route's answer at once.
      expect({
        configuredJwk: answers['configuredJwk'],
        configuredPem: answers['configuredPem']?.startsWith(importRefusal) ? 'refused at import' : answers['configuredPem'],
        keySetEntry: answers['keySetEntry'],
      }).toEqual({
        // Refused when the middleware is built, by the field that is wrong.
        configuredJwk: 'OptionsError publicKeys[0].key.e',
        // Built — the validator cannot see a PEM key's exponent — but the
        // import refuses the key: every request a server error, never a pass.
        configuredPem: 'refused at import',
        // Skipped from the set, so the token names a key nobody holds.
        keySetEntry: '401 no key verifies this token',
      });
    }, 30_000);
  }
});
