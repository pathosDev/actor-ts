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
 * This does not run clean yet.  It is landed as a working, measured harness so
 * the remaining editorial sweep can be planned with numbers instead of
 * guesses.  The counts in this header are a reading of the tree at a point in
 * time and move as pages are edited, so re-derive rather than quote them:
 * `--measure` prints the fence classification and `--report` prints the
 * diagnostic classification, per code and per page (both exit 0).
 *
 * Where it stands: 490 pages, 3312 `ts` fences, 840 emitted.  Of those, 316
 * are clean, 294 are prose fragments, and **226 are findings — 4 grammar, 32
 * missing imports, 194 real errors — spread over 170 pages.**  Wiring the job
 * before those are swept or exempted only adds a permanently-red check, which
 * is why `.github/workflows/docs-checks.yml` still does not reference this.
 * When it is wired, its `paths` filter has to include `src/**` and
 * `package.json` as well as `docs/**`: a rename in `src/` would otherwise land
 * green and the next docs-only pull request would inherit the failure.
 *
 * A `ts` fence is compiled unless it is one of:
 *   1. **no `import`** — a fragment by construction: it references identifiers
 *      that were never in scope, so "compile it" has no meaning short of
 *      inventing a prelude that is itself unchecked prose.
 *   2. **elided** — carries `…` or `...` in a non-spread position, including
 *      inside a type argument list (`class Worker extends Actor<...>`).  These
 *      do not parse.
 *   3. **`no-compile` in the fence meta** — the explicit escape hatch, for a
 *      sample that is deliberately not a program (a "this is the mistake"
 *      example, a signature listing, one fence holding two modules).  Anything
 *      after the marker is kept as its reason and printed by `--report`, so
 *      ```` ```ts no-compile — needs @opentelemetry/api ```` is a documented
 *      exemption rather than a silent one.  Every use is one grep away
 *      (`rg 'ts no-compile' docs/`), which the blocklist it replaces never was.
 *
 * Rules 1 and 2 need no sweep and no markup: they classify what authors
 * already wrote.  Rule 3 is what the sweep applies.
 *
 * ## Three things that used to make the numbers lie
 *
 * **A parse error suppressed every semantic diagnostic in the whole program.**
 * Four unmarked fences — a comment used as an arrow-function body
 * (`async (request) => /* expensive lookup *\/`) and a `package.json` snippet
 * inside a `ts` fence — were enough to turn this script into a four-line
 * syntax report that looked like the type checking passed.  It now compiles
 * **twice**: the fences whose diagnostics are syntactic are dropped from the
 * program and the rest are re-checked, so a newly broken fence costs its own
 * error and never the other 800.  That is a property of the harness rather
 * than of the fence markup, which is the point — relying on authors to mark
 * them is relying on the thing that failed.  Both causes are also fixed at
 * the source: the comment-as-body is an elision that
 * `COMMENT_AS_EXPRESSION_BODY` now recognises without markup, and the
 * `package.json` snippet is a `json` fence, which is what it always was.
 * Four `TS1108` fences were standing behind them, invisible until the
 * suppression lifted.
 *
 * **A fence that continued an earlier one on its page was counted as broken.**
 * Pages are written as a narrative: fence 1 does `const cache = new
 * InMemoryCache()`, fence 4 imports something *and* goes on using `cache`.
 * Compiled alone that is "cannot find name", which is not a broken sample, it
 * is a wrong assumption about what a fence is.  Each emitted file therefore
 * carries a **one-line continuity prologue** for the top-level names earlier
 * `ts` fences on the same page introduced and this one does not bind itself.
 * Measured: 63 fences went from failing to clean (377 → 314 clean), and the
 * implicit-`any` tail shrank with them (TS7006 on 43 fences → 36).
 *
 * Four things about that prologue are deliberate:
 *
 *   - It is **exactly one line, always present** (a comment when there is
 *     nothing to carry), so generated line N is page line `bodyStart + N - 2`
 *     for every file with no special cases.  Line arithmetic that varies per
 *     file is how a diagnostic ends up pointing at the wrong sample.
 *   - It is **module-local**, not a global `.d.ts`: an `import` or a `declare
 *     var` inside a module declares nothing for any other file, so page A's
 *     names cannot make page B's fence pass.
 *   - A carried name an earlier fence **imported** from `actor-ts…` or `node:`
 *     is **re-imported, not stubbed**, one specifier at a time.  That is the
 *     difference between checking the continuation and merely tolerating it:
 *     `rateLimit` imported in fence 1 and called in fence 4 keeps its real
 *     signature.  Only specifiers this program can certainly resolve are
 *     re-emitted — an `ioredis` import would put a TS2307 on a line no author
 *     wrote.
 *   - Everything else is `any`, and there `any` is the honest type: the harness
 *     does not know what `const cache = buildIt()` evaluated to, and inventing
 *     a type would be prose masquerading as a check.
 *
 * That last one is a trade, and it was measured rather than assumed.  Compared
 * with compiling every fence in isolation, the prologue **removes 38 findings
 * and adds 2** (262 on 186 pages → 226 on 170).  The removals inspected are all
 * artefacts of the isolation rather than defects: an identifier an earlier fence
 * imported (`idempotent`, `HttpExtensionId`), a shorthand property whose value
 * an earlier fence declared (`keyring`), and — the interesting one — a page-local
 * `class Worker` that, isolated, resolved to the DOM's `Worker` and produced a
 * confident TS2345 against `ActorClassOrFactory` (`routing/router.mdx`).  The
 * residual risk is the opposite direction: a *computed* carried value is `any`,
 * so a genuine mismatch downstream of one is not seen.  Closing that needs the
 * TypeScript API to read the earlier fence's inferred type, not a CLI.  Spot
 * check that it is not hiding the obvious case — the `NodeAddress[]` into
 * `withSeeds(string[])` drift on the four seed-provider pages is still reported,
 * because those fences declare `seeds` themselves.
 *
 * **The leftover "cannot find name" was one bucket holding two defects.** The
 * question this script was landed unwired to settle was whether to tolerate
 * TS2304 wholesale.  The answer is no, and there is a cheap discriminator that
 * beats both options — see `actorTsVocabulary`.  After the continuity
 * prologue, an unresolved name is either a **prose placeholder** the corpus
 * never imports anywhere (`system`, `cluster`, `host`, `seeds`, `appRoutes` —
 * 298 fences) or a **missing import** of a name other pages do import from
 * `actor-ts…` (`BoundedMailbox`, `ClusterOptions`, `ActorRef` — 32 fences).
 * The first is rule 1 arrived at semantically and is reported as a fragment;
 * the second is a defect a reader hits on copy-paste and stays an error.
 *
 * Two alternatives were measured and rejected:
 *
 *   - **A shared ambient preamble.** The hope was that a handful of names
 *     would clear most of the bucket.  Greedily choosing the most valuable
 *     name at each step, 30 declarations clear only 138 of 326 fences and the
 *     tail is per-page prose (`Crunchy`, `IngestWorker`, `someLeaseImplementation`).
 *     There is no small preamble; a big one is 190 `any` declarations that
 *     would also swallow the 30 missing imports.
 *   - **Compiling each page's fences together.** Trades the bucket for ~850
 *     duplicate-declaration errors, because pages re-import and re-`const` the
 *     same names fence after fence.
 *
 * Usage:
 *   node scripts/check-doc-samples.mjs            # compile, report, exit 1 on error
 *   node scripts/check-doc-samples.mjs --measure  # classify fences only, never fails
 *   node scripts/check-doc-samples.mjs --report   # classify diagnostics, never fails
 *   node scripts/check-doc-samples.mjs --keep     # leave the generated tree in place
 *   node scripts/check-doc-samples.mjs --docs=DIR --out=NAME   # drive a fixture tree
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DOCS = join('docs', 'src', 'content', 'docs');
/** Generated tree — gitignored, recreated from scratch on every run. */
const DEFAULT_OUT = '.doc-samples';

/* ------------------------------ discovery ------------------------------ */

/**
 * `api/` is the TypeDoc-generated reference tree.  It is gitignored
 * (`docs/.gitignore`), regenerated by the docs build, and its fences are
 * emitted from the very source this check compiles against — so including it
 * would be both circular and enormous.
 */
export function markdownFiles(directory, out = []) {
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
export function fencesOfSource(text, file) {
  const lines = text.split(/\r?\n/);
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
        file,
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

export function fencesOf(path) {
  return fencesOfSource(readFileSync(path, 'utf8'), path);
}

/** A top-level `import …` — the marker that a sample declares its own world. */
export const DECLARES_IMPORT = /^import[\s{*]/m;

/**
 * An elision marker, as distinct from a spread or a rest parameter.  Spread
 * and rest are always *followed* by something (`...rest`, `...{ a }`), so the
 * marker is `...` with a closing delimiter or end-of-line after it — which is
 * what `Actor<...>`, `{ kind: 'place', ... }` and `replyTo: ...` all look
 * like.  The type-argument case (`<...>`) is the one worth naming: it is the
 * most common form on these pages and the easiest to miss, because `>` reads
 * as an operator rather than as a closing bracket.
 */
export const ELIDED = /(?:^|[^.])\.\.\.\s*(?=[>)\]},;]|$)/m;

/**
 * An elision written as prose rather than as dots: a comment standing in for an
 * arrow function's expression body, `async (request) => /* expensive lookup *\/`.
 *
 * Safe to treat as an elision without judgement, because it is never anything
 * else — a comment is not an expression, so an arrow whose body is only a
 * comment followed by a closing delimiter cannot parse under any reading.  It
 * is worth detecting rather than asking authors to mark: unmarked, it is a
 * grammar error, and a grammar error used to take the whole semantic pass down
 * with it.
 */
export const COMMENT_AS_EXPRESSION_BODY = /=>\s*\/\*[\s\S]*?\*\/\s*(?=[)\]},;]|$)/m;

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
export const CLASS_MEMBER_FRAGMENT = /^(?:private|protected|public|override)\s/m;

/** The `no-compile` marker, and whatever reason follows it on the fence line. */
const NO_COMPILE = /\bno-compile\b[\s—:-]*(.*)$/;

/** Splits `ts` fences into the four buckets the convention above describes. */
export function classify(typescriptFences) {
  const exempt = [];
  const fragments = [];
  const elided = [];
  const compiled = [];
  for (const fence of typescriptFences) {
    const source = fence.body.join('\n');
    const marker = NO_COMPILE.exec(fence.info);
    if (!DECLARES_IMPORT.test(source) || CLASS_MEMBER_FRAGMENT.test(source)) fragments.push(fence);
    else if (source.includes('…') || ELIDED.test(source) || COMMENT_AS_EXPRESSION_BODY.test(source)) {
      elided.push(fence);
    }
    else if (marker) exempt.push({ ...fence, reason: marker[1].trim() });
    else compiled.push({ ...fence, source });
  }
  return { fragments, elided, exempt, compiled };
}

/* --------------------------- page continuity ---------------------------- */

/**
 * Names bound by an `import` clause — default, namespace and named forms,
 * `as` aliases and inline `type` specifiers included.  The alias is what
 * matters: `import { jsonCodec as codec }` puts `codec` in scope, not
 * `jsonCodec`, and a prologue that re-declared the alias would collide.
 */
export function namesFromImportClause(clause) {
  const out = [];
  let rest = clause.trim().replace(/^type\s+/, '');
  const braces = /\{([\s\S]*?)\}/.exec(rest);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const piece = part.trim().replace(/^type\s+/, '');
      if (piece === '') continue;
      const alias = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(piece);
      const name = alias ? alias[1] : /^([A-Za-z_$][\w$]*)/.exec(piece)?.[1];
      if (name) out.push(name);
    }
    rest = rest.slice(0, braces.index);
  }
  const namespace = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(rest);
  if (namespace) out.push(namespace[1]);
  else {
    const defaultImport = /^([A-Za-z_$][\w$]*)/.exec(rest.trim());
    if (defaultImport) out.push(defaultImport[1]);
  }
  return out;
}

/** Names bound by a destructuring pattern, honouring `key: local` and defaults. */
export function namesFromPattern(pattern) {
  const out = [];
  for (const part of pattern.replace(/^[{[]/, '').replace(/[}\]]$/, '').split(',')) {
    const piece = part.split('=')[0] ?? '';
    const renamed = piece.split(':');
    const target = (renamed[renamed.length - 1] ?? '').trim();
    const name = /^\.{0,3}\s*([A-Za-z_$][\w$]*)/.exec(target);
    if (name) out.push(name[1]);
  }
  return out;
}

const IMPORT_STATEMENT = /^import\s+([\s\S]*?)\s+from\s*['"][^'"]*['"]/gm;
const IMPORT_WITH_SPECIFIER = /^import\s+([\s\S]*?)\s+from\s*['"]([^'"]*)['"]/gm;

/**
 * Specifiers this program can always resolve — the published surface through
 * the `paths` map, and Node's own builtins.  A carried name whose import came
 * from anywhere else (`ioredis`, `@opentelemetry/api`, `./generated/order.js`)
 * must stay opaque: re-emitting that import would put a TS2307 in the
 * continuity prologue, i.e. an error on a line no author wrote.
 */
const RESOLVABLE_SPECIFIER = /^(?:actor-ts(?:\/|$)|node:)/;

/**
 * Import bindings of a fence, keyed by the local name, with enough shape to
 * rebuild a *single-specifier* import for exactly that name.
 *
 * Rebuilding one specifier at a time rather than re-emitting the statement is
 * the point: a fence that carries `A` from `import { A, B }` while binding its
 * own `B` would otherwise collide on `B`.
 */
export function importsOf(source) {
  const out = new Map();
  for (const [, clause, specifier] of source.matchAll(IMPORT_WITH_SPECIFIER)) {
    if (!RESOLVABLE_SPECIFIER.test(specifier)) continue;
    let rest = clause.trim();
    const clauseTypeOnly = /^type\s+/.test(rest);
    rest = rest.replace(/^type\s+/, '');
    const braces = /\{([\s\S]*?)\}/.exec(rest);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const piece = part.trim();
        if (piece === '') continue;
        const typeOnly = clauseTypeOnly || /^type\s+/.test(piece);
        const bare = piece.replace(/^type\s+/, '');
        const aliased = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(bare);
        const imported = aliased ? aliased[1] : /^([A-Za-z_$][\w$]*)$/.exec(bare)?.[1];
        const local = aliased ? aliased[2] : imported;
        if (local && imported) out.set(local, { kind: 'named', local, imported, specifier, typeOnly });
      }
      rest = rest.slice(0, braces.index);
    }
    const namespace = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(rest);
    if (namespace) {
      out.set(namespace[1], { kind: 'namespace', local: namespace[1], specifier, typeOnly: clauseTypeOnly });
    } else {
      const defaultImport = /^([A-Za-z_$][\w$]*)/.exec(rest.trim());
      if (defaultImport) {
        const local = defaultImport[1];
        out.set(local, { kind: 'default', local, specifier, typeOnly: clauseTypeOnly });
      }
    }
  }
  return out;
}

/** One import statement that binds exactly `descriptor.local`. */
export function importStatementFor(descriptor) {
  const keyword = descriptor.typeOnly ? 'import type' : 'import';
  const clause = descriptor.kind === 'namespace'
    ? `* as ${descriptor.local}`
    : descriptor.kind === 'default'
      ? descriptor.local
      : descriptor.imported === descriptor.local
        ? `{ ${descriptor.local} }`
        : `{ ${descriptor.imported} as ${descriptor.local} }`;
  return `${keyword} ${clause} from '${descriptor.specifier}';`;
}
/** `const enum` first: a bare `const` alternative would capture `enum` as the name. */
const DECLARATION = /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const\s+enum|function\s*\*?|class|interface|enum|namespace|type|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const DESTRUCTURING = /^(?:export\s+)?(?:const|let|var)\s*([{[][\s\S]*?[}\]])\s*(?::[\s\S]*?)?=/gm;

/**
 * The top-level names a fence introduces — what a *later* fence on the same
 * page is entitled to go on using.
 *
 * Deliberately a scan over column-0 declarations rather than a parse: the
 * fences that need this are exactly the ones a parser rejects, and the set
 * only has to be good enough to name identifiers.  Over-collecting costs an
 * unused ambient declaration; under-collecting costs a "cannot find name" that
 * was already there.
 */
export function bindingsOf(source) {
  const out = new Set();
  for (const [, clause] of source.matchAll(IMPORT_STATEMENT)) {
    for (const name of namesFromImportClause(clause)) out.add(name);
  }
  for (const [, name] of source.matchAll(DECLARATION)) out.add(name);
  for (const [, pattern] of source.matchAll(DESTRUCTURING)) {
    for (const name of namesFromPattern(pattern)) out.add(name);
  }
  return out;
}

/**
 * For each `ts` fence of one page, in document order, the names earlier fences
 * on that page introduced and this one does not bind itself.  Keyed by the
 * fence object, so a caller can look up the ones it went on to emit.
 */
export function carriedNames(pageFences) {
  const carried = new Map();
  const seen = new Set();
  for (const fence of pageFences) {
    const own = bindingsOf(fence.body.join('\n'));
    carried.set(fence, [...seen].filter((name) => !own.has(name)).sort());
    for (const name of own) seen.add(name);
  }
  return carried;
}

/**
 * The same walk, keeping how each carried name was bound: as a resolvable
 * import (re-importable, and therefore checkable) or as anything else.
 *
 * Which half a name falls into is the difference between the harness checking
 * the continuation and merely tolerating it.  `rateLimit` imported in fence 1
 * and called in fence 4 with a required property missing is a real defect a
 * reader hits, and it is invisible if the prologue calls it `any`.
 */
export function carriedDeclarations(pageFences) {
  const carried = new Map();
  const seenImports = new Map();
  const seenOther = new Set();
  for (const fence of pageFences) {
    const source = fence.body.join('\n');
    const own = bindingsOf(source);
    const imports = [...seenImports.entries()]
      .filter(([name]) => !own.has(name))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, descriptor]) => descriptor);
    const opaque = [...seenOther].filter((name) => !own.has(name) && !seenImports.has(name)).sort();
    carried.set(fence, { imports, opaque });
    for (const [name, descriptor] of importsOf(source)) {
      seenImports.set(name, descriptor);
      // A name first seen as a computed `const` and later imported is now
      // re-importable; leaving it in both would declare it twice.
      seenOther.delete(name);
    }
    for (const name of own) if (!seenImports.has(name)) seenOther.add(name);
  }
  return carried;
}

/**
 * The single prologue line.  Two kinds of entry, and the split is deliberate:
 *
 *   - A name an earlier fence **imported** from `actor-ts…` or `node:` is
 *     re-imported here, so it keeps its real type and everything the fence does
 *     with it is genuinely checked.
 *   - Anything else — a `const` an earlier fence computed, a local `class` — is
 *     `var` plus a same-named type alias, which covers a value position
 *     (`cache.set(…)`), a type position (`const greeting: Greeting`) and a
 *     constructor position (`new Worker()`) alike.  `any` is the honest type
 *     there: the harness does not know what the expression evaluated to, and
 *     inventing one would be prose masquerading as a check.
 */
export function continuityPrologue(carried) {
  const { imports, opaque } = Array.isArray(carried)
    ? { imports: [], opaque: carried }
    : { imports: carried.imports ?? [], opaque: carried.opaque ?? [] };
  if (imports.length === 0 && opaque.length === 0) {
    return '// (nothing carried from an earlier fence on this page)';
  }
  const parts = [
    ...imports.map(importStatementFor),
    ...opaque.map((name) => `declare var ${name}: any; type ${name} = any;`),
  ];
  return `${parts.join(' ')} // carried from earlier fences on this page`;
}

/** Generated line N of an emitted fence is this line of the page. */
export const PROLOGUE_LINES = 1;
export function pageLineOf(fence, generatedLine) {
  return fence.bodyStart + generatedLine - 1 - PROLOGUE_LINES;
}

/* ------------------------------- reporting ------------------------------ */

/** `path(line,col): error TSxxxx: message` — tsc's default pretty-less form. */
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/;

/**
 * A grammar error — the `TS1xxx` band, and nothing else is.
 *
 * The band is slightly wider than "suppresses the semantic pass", and that is
 * deliberate.  A *parse* failure (TS1005, TS1109) makes TypeScript report no
 * semantic diagnostic for the whole program, which is what the second pass
 * exists for.  A *grammar* error on an otherwise-parseable file (TS1108, a
 * `return` outside a function) is reported alongside the semantic pass and
 * suppresses nothing.  Excluding both is the conservative choice: it costs a
 * TS1108 fence its own semantic diagnostics, on a fence that already has a
 * finding and does not compile either way.
 *
 * One re-run is enough, because syntactic diagnostics are per-file parse
 * results and TypeScript reports them for *every* file in one go — a parse
 * error cannot hide behind another parse error the way a semantic one can.
 */
export function isSyntaxError(code) {
  return /^TS1\d{3}$/.test(code);
}

/** "Cannot find name" / "did you mean" — the shape a page continuation makes. */
export function isUnresolvedName(code) {
  return code === 'TS2304' || code === 'TS2552';
}

/** The identifier a "cannot find name" diagnostic is about, or `null`. */
export function unresolvedNameOf(message) {
  return /Cannot find name '([^']+)'/.exec(message)?.[1] ?? null;
}

/**
 * Every name the documentation itself imports from an `actor-ts…` subpath,
 * anywhere in the tree.
 *
 * This is the discriminator that makes a leftover "cannot find name"
 * actionable.  After the continuity prologue, an unresolved identifier is one
 * of two very different things, and the corpus knows which:
 *
 *   - a **prose placeholder** — `system`, `cluster`, `host`, `seeds`,
 *     `appRoutes`.  No page anywhere imports it, because it does not exist:
 *     it stands for "the one you already have".  A fence built on those is a
 *     fragment that happens to show its imports, which is rule 1 arrived at
 *     semantically instead of syntactically.
 *   - a **missing import** — `BoundedMailbox`, `ClusterOptions`, `ActorRef`.
 *     Other pages import exactly that name from `actor-ts…`, so this page
 *     forgot to, and a reader who copies the fence gets the same error.  That
 *     is a defect in the sample and stays a failure.
 *
 * Derived from the fences rather than from the barrels on purpose: it needs no
 * export-graph walk, and the question it answers is about what the docs claim,
 * which is the same body of text being checked.  The cost is one blind spot,
 * stated plainly — a name that *no* page imports correctly reads as a
 * placeholder.
 */
export function actorTsVocabulary(typescriptFences) {
  const out = new Set();
  for (const fence of typescriptFences) {
    const source = fence.body.join('\n');
    for (const [, clause, specifier] of source.matchAll(/^import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/gm)) {
      if (!specifier.startsWith('actor-ts')) continue;
      for (const name of namesFromImportClause(clause)) out.add(name);
    }
  }
  return out;
}

/**
 * One fence's verdict from its semantic diagnostics.
 *
 * `'prose'` is the only one that is not a failure, and it is not a tolerated
 * error — it is a reclassification: the fence was never a program.  Nothing is
 * lost by it, because a renamed or re-homed export fails at the `import`
 * itself (TS2307 / TS2305 / TS2724), which every verdict below checks.
 */
export function verdictOf(diagnostics, vocabulary) {
  if (diagnostics.length === 0) return 'clean';
  if (!diagnostics.every((diagnostic) => isUnresolvedName(diagnostic.code))) return 'real-error';
  const names = diagnostics.map((diagnostic) => unresolvedNameOf(diagnostic.message)).filter(Boolean);
  return names.some((name) => vocabulary.has(name)) ? 'missing-import' : 'prose';
}

/** tsc's stdout, parsed into one entry per diagnostic and re-based onto pages. */
export function parseDiagnostics(output, emitted, pageOf) {
  const out = [];
  for (const line of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC.exec(line.trim());
    if (!match) continue;
    const [, file, row, column, , code, message] = match;
    const name = file.split(/[\\/]/).pop();
    const fence = emitted.get(name);
    if (!fence) {
      out.push({ file: name, where: file, code, message, generatedLine: Number(row) });
      continue;
    }
    const generatedLine = Number(row);
    out.push({
      file: name,
      fence,
      code,
      message,
      generatedLine,
      page: pageOf(fence),
      // A diagnostic inside the prologue is a harness bug, not a page defect,
      // and must not be re-based onto a line the author never wrote.
      line: generatedLine <= PROLOGUE_LINES ? null : pageLineOf(fence, generatedLine),
      column: Number(column),
      where: generatedLine <= PROLOGUE_LINES
        ? `${pageOf(fence)} (continuity prologue)`
        : `${pageOf(fence)}:${pageLineOf(fence, generatedLine)}:${column}`,
    });
  }
  return out;
}

/**
 * Per-fence verdicts plus the tallies a sweep is planned from: how many fences
 * carry each diagnostic code, and how many real-error fences sit on each page.
 * `reported` is what the default run fails on — everything but `clean` and
 * `prose`.
 */
export function classifyDiagnostics(emitted, syntax, semantic, vocabulary) {
  const byFile = new Map();
  for (const diagnostic of semantic) {
    const list = byFile.get(diagnostic.file) ?? [];
    list.push(diagnostic);
    byFile.set(diagnostic.file, list);
  }
  const syntaxFiles = new Set(syntax.map((diagnostic) => diagnostic.file));

  const clean = [];
  const prose = [];
  const missingImport = [];
  const realError = [];
  const reported = [];
  const codes = new Map();
  const pages = new Map();
  const placeholders = new Map();
  for (const [name, fence] of emitted) {
    if (syntaxFiles.has(name)) continue;
    const diagnostics = byFile.get(name) ?? [];
    const verdict = verdictOf(diagnostics, vocabulary);
    if (verdict === 'clean') {
      clean.push(fence);
      continue;
    }
    if (verdict === 'prose') {
      prose.push(fence);
      for (const diagnostic of diagnostics) {
        const unresolved = unresolvedNameOf(diagnostic.message);
        if (unresolved) placeholders.set(unresolved, (placeholders.get(unresolved) ?? 0) + 1);
      }
      continue;
    }
    (verdict === 'missing-import' ? missingImport : realError).push(fence);
    reported.push(...diagnostics);
    for (const code of new Set(diagnostics.map((diagnostic) => diagnostic.code))) {
      codes.set(code, (codes.get(code) ?? 0) + 1);
    }
    const page = fence.page ?? '';
    pages.set(page, (pages.get(page) ?? 0) + 1);
  }
  return { clean, prose, missingImport, realError, reported, codes, pages, placeholders, syntaxFiles };
}

/* -------------------------------- driver -------------------------------- */

export function parseArguments(argv) {
  const flag = (name) => {
    const match = argv.find((argument) => argument.startsWith(`--${name}=`));
    return match ? match.slice(name.length + 3) : undefined;
  };
  return {
    measureOnly: argv.includes('--measure'),
    reportOnly: argv.includes('--report'),
    keepOutput: argv.includes('--keep'),
    docs: flag('docs') ?? DEFAULT_DOCS,
    out: flag('out') ?? DEFAULT_OUT,
  };
}

/**
 * `paths` derived from `package.json#exports`, mapping each published subpath
 * to the `src/` file its `types` condition points into.  Deriving it is the
 * whole point: a hand-written map would drift from the export surface exactly
 * the way the docs did, and this check would then certify the drift.
 */
export function exportsPaths(manifest, toRoot = '..') {
  const paths = {};
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    if (subpath.endsWith('package.json')) continue;
    const declaration = typeof conditions === 'string' ? conditions : conditions.types;
    if (!declaration) continue;
    const specifier = subpath === '.' ? 'actor-ts' : `actor-ts/${subpath.slice(2)}`;
    // Relative to *this* tsconfig's directory, hence `toRoot` — which is the
    // real distance up to the repository root rather than a hardcoded `..`, so
    // `--out` can point anywhere.  TypeScript 7 removed `baseUrl` outright
    // (TS5102), and a `baseUrl` left in place is a configuration error — which
    // aborts the run before a single semantic diagnostic is produced, so the
    // check reports only parse errors and looks like it passed.  That failure
    // mode is silent enough to be worth the note, and getting `toRoot` wrong
    // has the same shape: every specifier becomes TS2307 at once.
    paths[specifier] = [declaration.replace(/^\.\/dist\//, `${toRoot}/src/`).replace(/\.d\.ts$/, '.ts')];
  }
  return paths;
}

function runTypescript(configPath) {
  try {
    execFileSync('bunx', ['tsc', '-p', configPath], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    return '';
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const docs = resolve(ROOT, options.docs);
  const out = resolve(ROOT, options.out);

  const pages = markdownFiles(docs);
  const typescriptFences = pages
    .flatMap(fencesOf)
    .filter((fence) => fence.language === 'ts' || fence.language === 'typescript');
  const { fragments, elided, exempt, compiled } = classify(typescriptFences);

  const pageOf = (fence) => relative(ROOT, fence.file).split(sep).join('/');

  console.log(`pages scanned          ${pages.length}`);
  console.log(`ts fences              ${typescriptFences.length}`);
  console.log(`  no import (fragment) ${fragments.length}`);
  console.log(`  elided (fragment)    ${elided.length}`);
  console.log(`  no-compile (exempt)  ${exempt.length}`);
  console.log(`  compiled             ${compiled.length}`);

  if (options.measureOnly) {
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
    if (exempt.length > 0) {
      console.log('\nno-compile exemptions:');
      for (const fence of exempt) {
        console.log(`  ${pageOf(fence)}:${fence.bodyStart}  ${fence.reason || '(no reason given)'}`);
      }
    }
    process.exit(0);
  }

  /* ------------------------------ emission ------------------------------ */

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // Keyed by file + bodyStart, which is unique per fence: `classify` hands back
  // spread copies, so object identity is not available to look these up by.
  const identityOf = (fence) => `${fence.file}#${fence.bodyStart}`;
  const carried = new Map();
  const fencesByPage = new Map();
  for (const fence of typescriptFences) {
    const onPage = fencesByPage.get(fence.file) ?? [];
    onPage.push(fence);
    fencesByPage.set(fence.file, onPage);
  }
  for (const onPage of fencesByPage.values()) {
    for (const [fence, declarations] of carriedDeclarations(onPage)) {
      carried.set(identityOf(fence), declarations);
    }
  }

  const emitted = new Map();
  for (const fence of compiled) {
    const slug = pageOf(fence)
      .replace(/^docs\/src\/content\/docs\//, '')
      .replace(/\.mdx?$/, '')
      .replace(/[^A-Za-z0-9]+/g, '-');
    const name = `${slug}--L${fence.bodyStart}.ts`;
    const names = carried.get(identityOf(fence)) ?? [];
    writeFileSync(join(out, name), `${continuityPrologue(names)}\n${fence.source}\n`, 'utf8');
    emitted.set(name, { ...fence, page: pageOf(fence) });
  }

  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  /** Posix-style hop from the generated tree back up to the repository root. */
  const toRoot = relative(out, ROOT).split(sep).join('/') || '.';
  const tsconfig = (include) => `${JSON.stringify(
    {
      extends: `${toRoot}/tsconfig.json`,
      compilerOptions: {
        // `types: ["node"]` where the build config has `[]`: a doc sample is
        // allowed to print to the console or read an env var, and the build's
        // empty list exists to keep those globals out of the published `.d.ts`,
        // which nothing here emits.
        types: ['node'],
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        noEmit: true,
        rootDir: toRoot,
        paths: exportsPaths(manifest, toRoot),
      },
      include,
    },
    null,
    2,
  )}\n`;

  const configPath = join(out, 'tsconfig.json');
  writeFileSync(configPath, tsconfig(['./*.ts']), 'utf8');

  /* ----------------------------- compilation ---------------------------- */

  const firstPass = parseDiagnostics(runTypescript(configPath), emitted, pageOf);
  const syntax = firstPass.filter((diagnostic) => isSyntaxError(diagnostic.code));

  // Pass two: a grammar error suppresses the semantic pass for the WHOLE
  // program, so the offending fences are excluded and everything else is
  // re-checked.  Without this, one mislabelled fence hides every real drift.
  let semantic = firstPass.filter((diagnostic) => !isSyntaxError(diagnostic.code));
  if (syntax.length > 0) {
    const broken = new Set(syntax.map((diagnostic) => diagnostic.file));
    const remaining = [...emitted.keys()].filter((name) => !broken.has(name));
    writeFileSync(configPath, tsconfig(remaining.map((name) => `./${name}`)), 'utf8');
    semantic = parseDiagnostics(runTypescript(configPath), emitted, pageOf)
      .filter((diagnostic) => !isSyntaxError(diagnostic.code));
  }

  const vocabulary = actorTsVocabulary(typescriptFences);
  const report = classifyDiagnostics(emitted, syntax, semantic, vocabulary);

  if (options.reportOnly) {
    console.log(`\nactor-ts import vocabulary  ${vocabulary.size} names`);
    console.log(`\nsyntax errors (excluded from the semantic pass)  ${report.syntaxFiles.size} fences`);
    for (const diagnostic of syntax) console.log(`  ${diagnostic.where}  ${diagnostic.code}: ${diagnostic.message}`);
    console.log('\nsemantic pass over the rest, per fence:');
    console.log(`  clean                        ${report.clean.length}`);
    console.log(`  prose (reclassified fragment) ${report.prose.length}`);
    console.log(`  missing import               ${report.missingImport.length}`);
    console.log(`  real error                   ${report.realError.length}`);
    console.log('\nreported fences by diagnostic code:');
    for (const [code, count] of [...report.codes].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${code}`);
    }
    console.log('\nreported fences by page:');
    for (const [page, count] of [...report.pages].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      console.log(`  ${String(count).padStart(4)}  ${page}`);
    }
    console.log('\nprose placeholders, by how many diagnostics they cause:');
    for (const [name, count] of [...report.placeholders].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
      console.log(`  ${String(count).padStart(4)}  ${name}`);
    }
    if (!options.keepOutput) rmSync(out, { recursive: true, force: true });
    process.exit(0);
  }

  if (!options.keepOutput) rmSync(out, { recursive: true, force: true });

  const failures = [...syntax, ...report.reported];
  console.log(`  prose (fragment)     ${report.prose.length}`);
  if (failures.length === 0) {
    console.log(`\nOK — ${report.clean.length} self-contained doc samples compile against the public API.`);
    process.exit(0);
  }

  console.error(`\n${failures.length} error(s) in documentation samples:\n`);
  for (const failure of failures) console.error(`  ${failure.where}  ${failure.code}: ${failure.message}`);
  console.error(
    '\nEach location is a real page and line. Fix the sample, or — if it is '
    + 'deliberately not compilable — mark its fence ```ts no-compile with a reason. '
    + 'Run with --report for the per-code and per-page tallies a sweep is planned from.',
  );
  process.exit(1);
}

if (import.meta.main) await main();
