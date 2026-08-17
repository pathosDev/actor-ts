#!/usr/bin/env node
/**
 * Compiles the self-contained TypeScript samples in the documentation against
 * the real public API.
 *
 * Doc fences are the one body of code in this repository that nothing type
 * checks: `bun test` transpiles without checking, the build tsconfig excludes
 * `examples/` and `tests/`, and it never looked at `docs/` at all.  So a
 * renamed or re-homed export rots in a snippet until a reader copies it.  The
 * existing `docs/scripts/check-api-drift.mjs` greps for a blocklist of names,
 * which cannot see the two drifts that actually shipped (#470):
 *
 *   - `jsonCodec` imported from `actor-ts/persistence` when the WebSocket one
 *     lives in `actor-ts/http`.  Both names exist, so a name-level scan is
 *     blind to it by construction — it is the *subpath* that is wrong.
 *   - `SchemaRegistry`'s signatures gaining a type parameter, leaving the
 *     published listing describing an API that no longer exists.
 *
 * Only a real `tsc` closes those, and only if it resolves `actor-ts…` the way
 * a reader's editor does — through `package.json#exports`, not through a
 * relative path into `src/`.  The `paths` map below is derived from that
 * `exports` block rather than hand-written, so a new subpath is covered the
 * day it is published and a removed one starts failing immediately.
 *
 * ## NOT YET A CI GATE — read this before wiring it up
 *
 * This does not run clean yet.  It is landed as a working, measured harness
 * so the classification question can be settled with numbers instead of
 * guesses, because getting that question wrong misclassifies 242 pages at
 * once.  The counts below are a reading of the tree at a point in time and
 * move as pages are edited, so re-derive rather than quote them: `--measure`
 * prints the fence classification, and the split between "clean", "only
 * cannot find name" and "real error" is this script's own `tsc` output
 * grouped per emitted fence, with the syntax-error fences set aside first.
 * Measured over 3260 `ts` fences on 484 pages (242 English + their German
 * mirrors):
 *
 *   - 2316 fences are fragments by construction — no `import` at all, or a
 *     body of class members with the enclosing `class { … }` left off.  They
 *     reference identifiers that were never in scope, so "compile them" has
 *     no meaning short of inventing 2316 preludes, each itself unchecked
 *     prose.
 *   - 110 carry an explicit elision marker (`…` or `...`, including inside a
 *     type argument list: `class Worker extends Actor<...>`).  These do not
 *     parse, and **a parse error suppresses every semantic diagnostic in the
 *     whole program** — so they must be excluded before anything is checked
 *     at all, not merely tolerated.  That is why the classifiers above are
 *     load-bearing rather than cosmetic; without them this script reports
 *     only syntax errors and looks like the type checking passed.
 *   - 834 are emitted and compiled.  Four syntax errors survive, on two page
 *     pairs that encode an elision in a form no regex should chase: a comment
 *     as an arrow-function body (`async (req) => /* expensive lookup *\/`)
 *     and a `package.json` snippet inside a `ts` fence.  Those are what the
 *     `no-compile` marker is for — and until they carry it they suppress the
 *     semantic pass for the whole program, which is why the split below is
 *     measured with those four excluded from the program.
 *   - Of the remaining 830: **254 are already fully clean**, 367 fail only
 *     with "cannot find name" (TS2304 / TS2552) — an identifier introduced by
 *     an earlier fence on the same page — and **209 have a real error**: a
 *     wrong argument type, a property that does not exist, an unresolvable
 *     module.
 *
 * The 209 are the editorial sweep, and they are the reason this is not yet a
 * gate.  Note what the 367 imply: "carries an import" does NOT mean
 * "self-contained".  The fence that motivates this whole check imports twice
 * and still references five identifiers it never defines.  Compiling each
 * page's fences *together* instead was measured too, and trades those for
 * ~850 duplicate-declaration errors, because pages re-import and re-`const`
 * the same names fence after fence.  Neither strategy reaches zero
 * mechanically.
 *
 * Tolerating "cannot find name" would make 621 of 830 pass today and shrink
 * the sweep to 209 — a defensible trade, since a renamed export still fails
 * at the *import*, which is checked.  It is a policy choice, not a technical
 * one, which is why this script reports the categories rather than picking.
 * Wiring it into `.github/workflows/docs-checks.yml` before that choice is
 * made would only add a permanently-red job.
 *
 * ## The proposed convention
 *
 * A `ts` fence is compiled unless it is one of:
 *   1. **no `import`** — a fragment by construction;
 *   2. **elided** — carries `…` or `...` in a non-spread position;
 *   3. **`no-compile` in the fence meta** — the explicit escape hatch, for a
 *      sample that is deliberately not a program (a "this is the mistake"
 *      example, or a signature listing).  Every use is one grep away
 *      (`rg 'ts no-compile' docs/`), which the blocklist it replaces never was.
 *
 * Rules 1 and 2 need no sweep and no markup: they classify what authors
 * already wrote.  Rule 3 is what the sweep would apply, and it is the part
 * that wants sign-off before 242 pages are touched.
 *
 * Usage:
 *   node scripts/check-doc-samples.mjs            # compile, report, exit 1 on error
 *   node scripts/check-doc-samples.mjs --measure  # classify only, never fails
 *   node scripts/check-doc-samples.mjs --keep     # leave the generated tree in place
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs', 'src', 'content', 'docs');
/** Generated tree — gitignored, recreated from scratch on every run. */
const OUT = join(ROOT, '.doc-samples');

const measureOnly = process.argv.includes('--measure');
const keepOutput = process.argv.includes('--keep');

/* ------------------------------ discovery ------------------------------ */

/**
 * `api/` is the TypeDoc-generated reference tree.  It is gitignored
 * (`docs/.gitignore`), regenerated by the docs build, and its fences are
 * emitted from the very source this check compiles against — so including it
 * would be both circular and enormous.
 */
function markdownFiles(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'api') markdownFiles(path, out);
    } else if (/\.mdx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Fenced blocks, tracked as a small state machine rather than by regex over
 * the whole file: a fence closes only on a run of the *same* marker character
 * that is at least as long as the opener and carries no info string, which is
 * what lets a ```` ``` ```` fence appear inside a ```` ```` ```` one.
 */
function fencesOf(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const fences = [];
  let open = null;
  for (let index = 0; index < lines.length; index++) {
    const match = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(lines[index] ?? '');
    if (!match) continue;
    const [, , marker, info] = match;
    if (open === null) {
      open = { marker: marker[0], length: marker.length, info: info.trim(), start: index };
    } else if (marker[0] === open.marker && marker.length >= open.length && info.trim() === '') {
      fences.push({
        file: path,
        info: open.info,
        language: (open.info.split(/[\s{]/)[0] ?? '').toLowerCase(),
        /** 1-based line of the first body line, so diagnostics can be re-based. */
        bodyStart: open.start + 2,
        body: lines.slice(open.start + 1, index),
      });
      open = null;
    }
  }
  return fences;
}

/** A top-level `import …` — the marker that a sample declares its own world. */
const DECLARES_IMPORT = /^import[\s{*]/m;

/**
 * An elision marker, as distinct from a spread or a rest parameter.  Spread
 * and rest are always *followed* by something (`...rest`, `...{ a }`), so the
 * marker is `...` with a closing delimiter or end-of-line after it — which is
 * what `Actor<...>`, `{ kind: 'place', ... }` and `replyTo: ...` all look
 * like.  The type-argument case (`<...>`) is the one worth naming: it is the
 * most common form on these pages and the easiest to miss, because `>` reads
 * as an operator rather than as a closing bracket.
 */
const ELIDED = /(?:^|[^.])\.\.\.\s*(?=[>)\]},;]|$)/m;

/**
 * A fence whose body is *class members* with the enclosing `class { … }` left
 * off — an import at the top, then `private readonly buffered: … = []` and a
 * couple of methods, unindented.  It reads perfectly as documentation and is
 * a syntax error as a module.
 *
 * `private`, `protected`, `public` and `override` are never legal at module
 * top level, so finding one in column 0 identifies the shape without
 * guessing.  `readonly` is excluded from the list: it is legal at top level
 * in a type or interface body continuation, and matching it cost real fences.
 */
const CLASS_MEMBER_FRAGMENT = /^(?:private|protected|public|override)\s/m;

/* ----------------------------- classification --------------------------- */

const pages = markdownFiles(DOCS);
const typescriptFences = pages
  .flatMap(fencesOf)
  .filter((fence) => fence.language === 'ts' || fence.language === 'typescript');

const exempt = [];
const fragments = [];
const elided = [];
const compiled = [];
for (const fence of typescriptFences) {
  const source = fence.body.join('\n');
  if (!DECLARES_IMPORT.test(source) || CLASS_MEMBER_FRAGMENT.test(source)) fragments.push(fence);
  else if (source.includes('…') || ELIDED.test(source)) elided.push(fence);
  else if (/\bno-compile\b/.test(fence.info)) exempt.push(fence);
  else compiled.push({ ...fence, source });
}

const pageOf = (fence) => relative(ROOT, fence.file).split(sep).join('/');

console.log(`pages scanned          ${pages.length}`);
console.log(`ts fences              ${typescriptFences.length}`);
console.log(`  no import (fragment) ${fragments.length}`);
console.log(`  elided (fragment)    ${elided.length}`);
console.log(`  no-compile (exempt)  ${exempt.length}`);
console.log(`  compiled             ${compiled.length}`);

if (measureOnly) {
  const specifiers = new Map();
  for (const fence of compiled) {
    for (const [, specifier] of fence.source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      specifiers.set(specifier, (specifiers.get(specifier) ?? 0) + 1);
    }
  }
  const external = [...specifiers]
    .filter(([specifier]) => !specifier.startsWith('actor-ts') && !specifier.startsWith('node:'))
    .sort((a, b) => b[1] - a[1]);
  console.log('\nnon-actor-ts, non-node specifiers:');
  for (const [specifier, count] of external) console.log(`  ${String(count).padStart(4)}  ${specifier}`);
  process.exit(0);
}

/* ------------------------------- emission ------------------------------- */

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/**
 * One file per fence, written with **no prologue at all** so that line N of
 * the generated file is line `bodyStart + N - 1` of the page.  A header
 * comment would be free to write and would silently offset every diagnostic.
 */
const emitted = new Map();
for (const fence of compiled) {
  const slug = pageOf(fence)
    .replace(/^docs\/src\/content\/docs\//, '')
    .replace(/\.mdx?$/, '')
    .replace(/[^A-Za-z0-9]+/g, '-');
  const name = `${slug}--L${fence.bodyStart}.ts`;
  writeFileSync(join(OUT, name), `${fence.source}\n`, 'utf8');
  emitted.set(name, fence);
}

/**
 * `paths` derived from `package.json#exports`, mapping each published subpath
 * to the `src/` file its `types` condition points into.  Deriving it is the
 * whole point: a hand-written map would drift from the export surface exactly
 * the way the docs did, and this check would then certify the drift.
 */
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const paths = {};
for (const [subpath, conditions] of Object.entries(manifest.exports)) {
  if (subpath.endsWith('package.json')) continue;
  const declaration = typeof conditions === 'string' ? conditions : conditions.types;
  if (!declaration) continue;
  const specifier = subpath === '.' ? 'actor-ts' : `actor-ts/${subpath.slice(2)}`;
  // Relative to *this* tsconfig's directory, hence the `../`.  TypeScript 7
  // removed `baseUrl` outright (TS5102), and a `baseUrl` left in place is a
  // configuration error — which aborts the run before a single semantic
  // diagnostic is produced, so the check reports only parse errors and looks
  // like it passed.  That failure mode is silent enough to be worth the note.
  paths[specifier] = [declaration.replace(/^\.\/dist\//, '../src/').replace(/\.d\.ts$/, '.ts')];
}

writeFileSync(
  join(OUT, 'tsconfig.json'),
  `${JSON.stringify(
    {
      extends: '../tsconfig.json',
      compilerOptions: {
        // `types: ["node"]` where the build config has `[]`: a doc sample is
        // allowed to print to the console or read an env var, and the build's
        // empty list exists to keep those globals out of the published `.d.ts`,
        // which nothing here emits.
        types: ['node'],
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        noEmit: true,
        rootDir: '..',
        paths,
      },
      include: ['./*.ts'],
    },
    null,
    2,
  )}\n`,
  'utf8',
);

/* ------------------------------ compilation ----------------------------- */

let output = '';
try {
  execFileSync('bunx', ['tsc', '-p', join(OUT, 'tsconfig.json')], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
} catch (error) {
  output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
}

/** `path(line,col): error TSxxxx: message` — tsc's default pretty-less form. */
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+:.*)$/;

const failures = [];
for (const line of output.split(/\r?\n/)) {
  const match = DIAGNOSTIC.exec(line.trim());
  if (!match) continue;
  const [, file, row, column, , message] = match;
  const fence = emitted.get(file.split(/[\\/]/).pop());
  if (!fence) {
    failures.push({ where: file, detail: `${row}:${column} ${message}` });
    continue;
  }
  failures.push({
    where: `${pageOf(fence)}:${fence.bodyStart + Number(row) - 1}:${column}`,
    detail: message,
  });
}

if (!keepOutput) rmSync(OUT, { recursive: true, force: true });

if (failures.length === 0) {
  console.log(`\nOK — ${compiled.length} self-contained doc samples compile against the public API.`);
  process.exit(0);
}

console.error(`\n${failures.length} error(s) in documentation samples:\n`);
for (const failure of failures) console.error(`  ${failure.where}  ${failure.detail}`);
console.error(
  '\nEach location is a real page and line. Fix the sample, or — if it is '
  + 'deliberately not compilable — mark its fence ```ts no-compile.',
);
process.exit(1);
