/**
 * Cross-runtime smoke harness (#229).  Discovers every case under
 * tests/smoke/cases/*.mjs, imports the framework once, runs each
 * case against it.  Identical script runs on Bun, Node, Deno —
 * the cases themselves are runtime-neutral by design (no
 * runtime-specific globals, only stdlib + actor-ts).
 *
 * The single-source-of-truth shape: adding a new smoke case is
 * dropping a new `<name>.mjs` file in `cases/`.  No edits to this
 * runner, no edits to the npm scripts, no edits to the CI matrix —
 * the next CI run on all three runtimes exercises it automatically.
 *
 * Usage (mirrors the legacy smoke.mjs):
 *
 *   bun  tests/smoke/run-cases.mjs
 *   ACTOR_TS_SMOKE_USE_DIST=1 node tests/smoke/run-cases.mjs
 *   ACTOR_TS_SMOKE_USE_DIST=1 deno run --allow-read --allow-env tests/smoke/run-cases.mjs
 *
 * The Node + Deno variants need `bun run build` first because
 * those runtimes can't load .ts directly; that's wired into the
 * smoke:node / smoke:deno npm scripts.
 */
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const runtime = detectRuntime();
console.log(`→ smoke harness on ${runtime}`);

const importFromBuild = process.env.ACTOR_TS_SMOKE_USE_DIST === '1';
const basePath = importFromBuild ? '../../dist/index.js' : '../../src/index.ts';
const modUrl = new URL(basePath, import.meta.url).href;

let actorTs;
try {
  actorTs = await import(modUrl);
} catch (e) {
  console.error(`✗ failed to import actor-ts from ${modUrl}:\n${e.stack ?? e.message ?? e}`);
  process.exit(1);
}

// Discover case files.
const casesDir = join(__dirname, 'cases');
let caseFiles;
try {
  const entries = await readdir(casesDir);
  caseFiles = entries
    .filter((caseFile) => caseFile.endsWith('.mjs'))
    .sort();
} catch (e) {
  console.error(`✗ failed to read cases directory: ${e.message}`);
  process.exit(1);
}

if (caseFiles.length === 0) {
  console.error(`✗ no smoke cases found in ${casesDir}`);
  process.exit(1);
}
console.log(`→ discovered ${caseFiles.length} case(s): ${caseFiles.join(', ')}\n`);

let failed = 0;
for (const caseFile of caseFiles) {
  const fileUrl = pathToFileURL(join(casesDir, caseFile)).href;
  let mod;
  try {
    mod = await import(fileUrl);
  } catch (e) {
    console.error(`✗ ${caseFile}: failed to import — ${e.message}`);
    failed++;
    continue;
  }
  if (typeof mod.run !== 'function') {
    console.error(`✗ ${caseFile}: missing exported run(ctx) function`);
    failed++;
    continue;
  }
  const name = mod.name ?? caseFile;
  const description = mod.description ?? '(no description)';
  const startedAt = Date.now();
  try {
    await mod.run({ actorTs, runtime });
    console.log(`✓ ${name} — ${description} (${Date.now() - startedAt}ms)`);
  } catch (e) {
    console.error(`✗ ${name} — ${description}: ${e.message}`);
    if (e.stack && process.env.SMOKE_VERBOSE === '1') {
      console.error(e.stack);
    }
    failed++;
  }
}

// Best-effort: close Node's global fetch (undici) keep-alive pool before
// process.exit, so a still-closing socket handle doesn't race the exit
// (a libuv assertion on Windows).  No-op on Bun/Deno.
try {
  const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
  if (dispatcher && typeof dispatcher.close === 'function') await dispatcher.close();
} catch { /* no undici global dispatcher on this runtime */ }

console.log('');
if (failed === 0) {
  console.log(`✓ all ${caseFiles.length} smoke case(s) passed on ${runtime}`);
  // Exit naturally (don't force process.exit) so Node closes its remaining
  // handles cleanly instead of racing a mid-close socket at teardown — a
  // libuv assertion on Windows.  All cases release their handles, so the
  // event loop drains promptly.
  process.exitCode = 0;
} else {
  console.error(`✗ ${failed} of ${caseFiles.length} smoke case(s) failed on ${runtime}`);
  process.exit(1);
}

function detectRuntime() {
  if (typeof globalThis.Bun !== 'undefined') return 'bun';
  if (typeof globalThis.Deno !== 'undefined') return 'deno';
  return 'node';
}
