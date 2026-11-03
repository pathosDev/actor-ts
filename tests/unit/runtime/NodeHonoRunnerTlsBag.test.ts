/**
 * #1486 — on the TLS listener the Node runner builds, the typed `tls` is the
 * whole TLS configuration, whatever the caller's `serveOptions.serverOptions`
 * carries beside it.
 *
 * The runner merges the caller's `serverOptions` beneath the TLS material, so
 * a `node:tls` key the typed `tls` leaves unset used to reach the listener
 * from the bag: `pfx` and `SNICallback` presented a certificate the clients do
 * not trust in place of the configured one, `requestCert: true` turned a
 * one-way listener into one that demands a client certificate with no `ca`
 * configured to verify it against, and `rejectUnauthorized: false` admitted a
 * client without a certificate past a configured demand.  Measured on node
 * v26.10.0 and bun 1.4.2; `SNICallback` only on Node, whose `node:tls` calls it.
 *
 * Those are properties of a live listener, so `NodeHonoRunnerTlsBag.fixture.ts`
 * is bundled once — `@hono/node-server` inside it, handed to the runner through
 * its loader seam — and run under Node, the runtime the runner exists for, and
 * Bun, the one this suite runs on.  Not Deno: the Hono backend serves through
 * `Deno.serve` there and never builds this runner.  A runtime that is not
 * installed is skipped by name — a capability probe, not a setting.  The stub
 * cases in `NodeHonoRunnerServeOptions.test.ts` pin the bag the module receives,
 * name by name.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = join(import.meta.dir, 'NodeHonoRunnerTlsBag.fixture.ts');
const tlsFixtures = fileURLToPath(new URL('../../fixtures/tls/', import.meta.url));

let directory = '';
afterAll(() => {
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
});

// Bundled at module scope, not in a test: the build is bounded work, but
// inside a test body it would race bun's per-test timeout for nothing.
directory = mkdtempSync(join(tmpdir(), 'actor-ts-node-tls-bag-'));
const built = await Bun.build({ entrypoints: [fixture], outdir: directory, target: 'node', format: 'esm', naming: 'tls-bag.mjs' });
if (!built.success) throw new Error(`bundling the fixture failed: ${built.logs.map(String).join('\n')}`);
const bundle = join(directory, 'tls-bag.mjs');

type Runtime = { readonly name: string; readonly command: readonly string[] | undefined };

const node = Bun.which('node');
const runtimes: readonly Runtime[] = [
  { name: 'Node', command: node === null ? undefined : [node] },
  { name: 'Bun', command: [process.execPath] },
];

/** What the fixture reported, run by `command`: one answer per case. */
function answersOf(command: readonly string[]): Record<string, string> {
  const child = spawnSync(command[0]!, [...command.slice(1), bundle, tlsFixtures], { encoding: 'utf8', timeout: 40_000 });
  if (child.status !== 0) throw new Error(`the fixture exited ${String(child.status)}: ${child.stderr}`);
  return JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '') as Record<string, string>;
}

/** `200`, or `refused` for any failed handshake or reset — the error itself stays in the raw answers. */
const outcome = (answer: string | undefined): string => (answer?.startsWith('refused: ') ? 'refused' : String(answer));

describe('NodeHonoRunner — a serveOptions bag cannot change what a typed-TLS listener presents or admits (#1486)', () => {
  for (const runtime of runtimes) {
    const command = runtime.command;
    const name = command === undefined ? `${runtime.name} (not installed here)` : runtime.name;
    (command === undefined ? test.skip : test)(name, () => {
      const answers = answersOf(command!);
      const outcomes = Object.fromEntries(Object.entries(answers).map(([key, answer]) => [key, outcome(answer)]));

      // One comparison, so a failure shows every case at once; the raw answers,
      // errors included, are its message.
      expect(outcomes, JSON.stringify(answers)).toEqual({
        baseline: '200',
        // The configured certificate is presented, so a client that trusts
        // only the test CA is answered.
        pfx: '200',
        SNICallback: '200',
        // A one-way listener stays one-way: no client certificate is asked for.
        requestCert: '200',
        // A configured demand still refuses a client without a certificate...
        rejectUnauthorized: 'refused',
        // ...exactly as it does with no bag at all, and admits one the
        // configured authority issued.
        mutualWithCertificate: '200',
        mutualWithoutCertificate: 'refused',
      });
    }, 60_000);
  }
});
