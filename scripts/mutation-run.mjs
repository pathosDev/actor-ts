#!/usr/bin/env bun
/**
 * Mutation runner (#1368).
 *
 * Line coverage says a line ran.  It cannot say whether any assertion would
 * notice the line being wrong, and the tracker has held a dozen issues that are
 * exactly that gap, each found by somebody breaking one line by hand and seeing
 * the suite stay green.  This script does that experiment systematically: it
 * applies one small perturbation at a time to a source file, runs the tests
 * that exercise the file, and records whether anything went red.
 *
 *   bun run test:mutation -- src/Supervision.ts
 *   bun run test:mutation -- --files='src/mailbox/*.ts'
 *   bun run test:mutation -- --since=origin/develop     # what this branch changed
 *   bun run test:mutation -- --since=v0.18.0 --changed-lines  # only the changed lines
 *   bun run test:mutation -- --set=nightly               # scripts/mutation-config.json
 *   bun run test:mutation -- --dry-run src/Supervision.ts  # list mutants, run nothing
 *
 * **Why in-house and not StrykerJS.**  Stryker was tried first (9.6.1, command
 * runner, 2026-11-14) and works — under Node.  Under Bun 1.4.2 its instrumenter
 * dies (`TypeError: generator is not a function` inside the Babel transform),
 * and its command runner has no per-test coverage, so every mutant runs one
 * fixed command: either the whole suite per mutant, or a wrapper that launches
 * Stryker once per source file with that file's tests — which is most of this
 * script anyway.  It would also bring 161 packages into the root devDependency
 * closure that `bun audit` gates.  What this file needs that Stryker gives is
 * small: six operators, a test mapping, a watchdog and a restore.
 *
 * **How a mutant is born.**  A small lexer marks which characters are code;
 * comments, string literals, template literals (interpolations included) and
 * regular-expression literals are not, so no mutant ever lands in a log line,
 * an error message or a metric label.  The operators then look only at code:
 *
 *   relational-boundary  `<` ↔ `<=`, `>` ↔ `>=` (only with whitespace on both
 *                        sides — that is what tells a comparison from a generic)
 *   equality             `===` ↔ `!==`, `==` ↔ `!=`
 *   logical              `&&` ↔ `||`
 *   boolean-literal      `true` ↔ `false`
 *   removed-call         a one-line call statement becomes `;`
 *   removed-return       a one-line `return …;` becomes `;`
 *
 * Every candidate is put through Bun's TypeScript transpiler twice — original
 * and mutant.  A mutant that does not parse is dropped as *invalid*; a mutant
 * whose JavaScript is byte-identical to the original's sat in a type position
 * (`{ ok: true }` inside a `type`) and is dropped as *equivalent*.  Neither
 * counts toward the score.  `scripts/mutation-config.json` carries the
 * remaining noise filters (log and console call removal), each with a reason.
 *
 * **Which tests run.**  The tests that import the file directly (a relative
 * specifier resolving to it) plus a test whose basename equals the file's
 * (`Supervision.ts` → `Supervision.test.ts`).  Not the transitive import graph:
 * nearly every test reaches `ActorSystem`, and a mapping that selects the whole
 * suite for every core file is a mapping that never finishes.  A file with
 * neither — reached only through a barrel or an aggregate, as
 * `ShardCoordinator.ts` is through `ClusterSharding.ts` — takes the tests of
 * the modules that import or re-export it, one hop and no further.  A
 * `testMap` entry in `scripts/mutation-config.json` names a file's list
 * outright and always wins; `--tests` wins over both.  The derived list is
 * capped (`--max-tests-per-file`, default `maxTestsPerFile` in the config),
 * most specific first: the same-name test, then tests in the directory that
 * mirrors the file's (`tests/unit/cluster/sharding/` for
 * `src/cluster/sharding/`), then by import distance.  What the cap drops is
 * printed and kept in the report.  A file that still maps to nothing is
 * reported as *no-coverage* — a finding about the mapping.
 * `tests/multi-node/`, the broker suites, the smoke cases and the examples are
 * never selected: they spawn workers or need Docker.
 *
 * **Which mutants run.**  Every one in the file, unless `--changed-lines` is
 * given with `--since=<ref>`: then only those on a line `git diff -U0` reports
 * as added or changed since the merge base, so a release's diff is measured
 * without paying for the unchanged rest of each file it touched.
 *
 * **What one file costs.**  A baseline run of the mapped tests with
 * `--coverage` (red baseline → the file is skipped, since every mutant would
 * read as killed), then one `bun test --bail` per mutant on a covered line.  A
 * mutant on a line the baseline never executed is *no-coverage* and not run.
 *
 * **Statuses.**  `killed` (the tests went red), `survived` (green — the
 * finding), `timed-out` (killed by the watchdog: the mutant made the suite
 * hang, which counts as detected but is flagged, because a hang is detection by
 * accident), `no-coverage`, and `not-run` (the `--budget-minutes` ran out).
 * Score = (killed + timed-out) / (killed + timed-out + survived).
 *
 * **The tree is never left mutated.**  Before a file is touched its original
 * bytes go into a journal under the report directory; the mutant is written
 * beside the file and renamed over it; the original comes back in a `finally`,
 * on SIGINT/SIGTERM/SIGHUP, and on `exit`.  A run that is killed outright
 * (SIGKILL, a closed terminal on Windows, a power cut) leaves the journal
 * behind, and the next run restores from it before doing anything else — run
 * `--recover` to do only that.
 *
 * **Stopping is not losing.**  A signal restores the tree first, then writes
 * the report for the mutants finished so far, marked `interrupted`, and exits
 * 128 + n.  Windows runs no JS handler for a signal sent from another process,
 * so `--stop-file=<path>` is the portable stop: polled between mutants and
 * before each baseline, consumed when seen, same partial report, exit 143.
 *
 * **Sequential, deliberately.**  Mutation happens in place, in the one working
 * tree; two mutants at once would each be read by the other's tests.  Bounding
 * parallelism to one is also what a shared machine with a few GB of free commit
 * memory can afford.
 *
 * The pure half is exported and the driver runs under `import.meta.main`, so
 * `tests/unit/ci/MutationRunner.test.ts` exercises operators, restore and
 * timeout classification without mutating anything real — the same seam
 * `scripts/stress-test.mjs` uses.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const DEFAULT_REPORT_DIRECTORY = '.mutation';
const DEFAULT_CONFIG_PATH = 'scripts/mutation-config.json';
/**
 * Survivors per file from an earlier, recorded run.  Not a gate: the report
 * prints each file's recorded count beside today's, so a reader sees which way
 * it moved.  `--write-baseline` regenerates it from the run just made.
 */
const DEFAULT_BASELINE_PATH = 'scripts/mutation-baseline.json';
/**
 * Per-mutant watchdog: baseline × factor + slack, floored.  Stryker's default
 * is ×1.5 + 5 s; this is looser because the baseline here carries coverage
 * instrumentation it does not, and a slow runner must not turn a survivor into
 * a false timed-out.
 */
const DEFAULT_TIMEOUT_FACTOR = 3;
const DEFAULT_TIMEOUT_SLACK_MS = 10_000;
const MINIMUM_TIMEOUT_MS = 15_000;
/** Baseline cap: an unmutated run that takes this long is a hang in its own right. */
const BASELINE_TIMEOUT_MS = 10 * 60 * 1_000;
const KILL_GRACE_MS = 3_000;
/** Exit status of a run stopped by `--stop-file`: 128 + 15, what SIGTERM gives, since it is the same stop. */
const STOP_EXIT_CODE = 143;

export const OPERATORS = Object.freeze([
  'relational-boundary', 'equality', 'logical', 'boolean-literal', 'removed-call', 'removed-return',
]);

/** Test trees never selected: they spawn worker threads, need Docker, or are not `bun test` suites. */
const EXCLUDED_TEST_PREFIXES = Object.freeze([
  'tests/multi-node/', 'tests/integration/brokers/', 'tests/smoke/', 'tests/examples/', 'tests/nightly/',
]);

/* ------------------------------------------------------------------ */
/* Lexing: which characters are code                                   */
/* ------------------------------------------------------------------ */

const REGEX_PRECEDING_CHARACTERS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_PRECEDING_WORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'instanceof', 'yield', 'await',
]);

function isIdentifierCharacter(character) {
  return character !== undefined && /[\w$]/.test(character);
}

/**
 * A `Uint8Array` the length of `source`, 1 where the character is code.  The
 * lexer is not a parser and does not need to be: a misjudged region only means
 * a missed or a dropped mutant, because every mutant is re-parsed before it
 * runs.  What it must never do is call the inside of a string code.
 */
export function codeMask(source) {
  const mask = new Uint8Array(source.length);
  let index = 0;
  let previousSignificant = '';
  let previousWord = '';

  const skipString = (start) => {
    const quote = source[start];
    let i = start + 1;
    while (i < source.length && source[i] !== quote && source[i] !== '\n') {
      i += source[i] === '\\' ? 2 : 1;
    }
    return i + 1;
  };
  const skipRegex = (start) => {
    let i = start + 1;
    let inClass = false;
    while (i < source.length && source[i] !== '\n') {
      const character = source[i];
      if (character === '\\') { i += 2; continue; }
      if (character === '[') inClass = true;
      else if (character === ']') inClass = false;
      else if (character === '/' && !inClass) break;
      i += 1;
    }
    i += 1;
    while (isIdentifierCharacter(source[i])) i += 1;
    return i;
  };
  // Returns the index after the closing backtick.  Interpolations are skipped
  // as a whole — strings and templates nested inside them included — because
  // the code inside a message template is message, not behaviour.
  const skipTemplate = (start) => {
    let i = start + 1;
    while (i < source.length) {
      const character = source[i];
      if (character === '\\') { i += 2; continue; }
      if (character === '`') return i + 1;
      if (character === '$' && source[i + 1] === '{') {
        i = skipInterpolation(i + 2);
        continue;
      }
      i += 1;
    }
    return i;
  };
  const skipInterpolation = (start) => {
    let depth = 0;
    let i = start;
    while (i < source.length) {
      const character = source[i];
      if (character === '\'' || character === '"') { i = skipString(i); continue; }
      if (character === '`') { i = skipTemplate(i); continue; }
      if (character === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); if (i < 0) return source.length; continue; }
      if (character === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
      if (character === '{') depth += 1;
      else if (character === '}') {
        if (depth === 0) return i + 1;
        depth -= 1;
      }
      i += 1;
    }
    return i;
  };

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (character === '\'' || character === '"') {
      index = skipString(index);
      previousSignificant = 'literal'; previousWord = '';
      continue;
    }
    if (character === '`') {
      index = skipTemplate(index);
      previousSignificant = 'literal'; previousWord = '';
      continue;
    }
    if (character === '/'
      && (previousSignificant === '' || REGEX_PRECEDING_CHARACTERS.has(previousSignificant)
        || REGEX_PRECEDING_WORDS.has(previousWord))) {
      index = skipRegex(index);
      previousSignificant = 'literal'; previousWord = '';
      continue;
    }
    mask[index] = 1;
    if (isIdentifierCharacter(character)) {
      let end = index;
      while (isIdentifierCharacter(source[end])) { mask[end] = 1; end += 1; }
      previousWord = source.slice(index, end);
      previousSignificant = 'word';
      index = end;
      continue;
    }
    if (!/\s/.test(character)) { previousSignificant = character; previousWord = ''; }
    index += 1;
  }
  return mask;
}

/* ------------------------------------------------------------------ */
/* Operators                                                           */
/* ------------------------------------------------------------------ */

/** Longest first: a token is consumed whole, so `>>=` is never read as `>` `>=`. */
const PUNCTUATORS = [
  '>>>=', '!==', '===', '>>>', '<<=', '>>=', '&&=', '||=', '??=', '**=',
  '==', '!=', '<=', '>=', '&&', '||', '??', '=>', '<<', '>>', '**', '<', '>',
];
const TOKEN_REPLACEMENTS = {
  '===': ['equality', '!=='], '!==': ['equality', '==='],
  '==': ['equality', '!='], '!=': ['equality', '=='],
  '<': ['relational-boundary', '<='], '<=': ['relational-boundary', '<'],
  '>': ['relational-boundary', '>='], '>=': ['relational-boundary', '>'],
  '&&': ['logical', '||'], '||': ['logical', '&&'],
};

function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

function positionOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle; else high = middle - 1;
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
}

/** Bracket balance over the code characters of `[start, end)`; 0 means self-contained. */
function balanceOf(source, mask, start, end) {
  let depth = 0;
  for (let i = start; i < end; i += 1) {
    if (!mask[i]) continue;
    const character = source[i];
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      if (depth < 0) return -1;
    }
  }
  return depth;
}

const CALL_STATEMENT = /^(?:await\s+)?(?:this\.|[A-Za-z_$][\w$]*)[\w$.?#[\]'"]*\(.*\)(?:\.[\w$]+\(.*\))*;$/;

/**
 * Statement-level candidates, one line at a time.  Only a statement that both
 * starts and ends on its line is touched, and only when the line before it
 * ends a statement or opens a block — so an argument on its own line inside a
 * longer call is never mistaken for a call statement.
 */
function statementMutants(source, mask, starts, operators) {
  const found = [];
  const lines = source.split('\n');
  let previousCodeLineEnd = '{';
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const text = lines[lineIndex].replace(/\r$/, '');
    const lineStart = starts[lineIndex];
    const leading = text.length - text.trimStart().length;
    const trimmed = text.trim();
    const statementStart = lineStart + leading;
    const statementEnd = statementStart + trimmed.length;
    if (trimmed === '' || !mask[statementStart]) continue;
    // The line's code, with a trailing comment cut off.  A comment starts a
    // run of non-code characters with `//` or `/*`; a string's run starts
    // with its quote, so `'http://…'` is not mistaken for one.
    let codeEnd = statementEnd;
    for (let j = statementStart + 1; j < statementEnd; j += 1) {
      if (!mask[j] && mask[j - 1] && (source.startsWith('//', j) || source.startsWith('/*', j))) { codeEnd = j; break; }
    }
    while (codeEnd > statementStart && /\s/.test(source[codeEnd - 1])) codeEnd -= 1;
    const code = source.slice(statementStart, codeEnd);
    const startsStatement = /[;{}]$/.test(previousCodeLineEnd) || previousCodeLineEnd === ':';
    previousCodeLineEnd = code.at(-1) ?? previousCodeLineEnd;
    // Ending in `;` is what proves the statement ends on this line: a return
    // whose expression continues below (`return a ===` / `  b && c;`) balances
    // its brackets on the first line just as well.
    if (!startsStatement || !code.endsWith(';') || balanceOf(source, mask, statementStart, codeEnd) !== 0) continue;

    if (operators.has('removed-return') && /^return\b/.test(code)) {
      found.push({ operator: 'removed-return', start: statementStart, end: codeEnd, original: code, replacement: ';' });
      continue;
    }
    if (operators.has('removed-call') && CALL_STATEMENT.test(code) && !/^(?:super|return|if|for|while|switch|catch|function)\b/.test(code)) {
      found.push({ operator: 'removed-call', start: statementStart, end: codeEnd, original: code, replacement: ';' });
    }
  }
  return found;
}

/**
 * Every candidate mutant of `source`, before validation.  `ignore` is the
 * config's list of `{ operators, pattern }`; a candidate whose line matches an
 * entry naming its operator is not produced.
 */
export function findMutants(source, { operators = OPERATORS, ignore = [] } = {}) {
  const enabled = new Set(operators);
  const mask = codeMask(source);
  const starts = lineStarts(source);
  const candidates = [];

  for (let i = 0; i < source.length; i += 1) {
    if (!mask[i]) continue;
    const character = source[i];
    if (isIdentifierCharacter(character)) {
      let end = i;
      while (isIdentifierCharacter(source[end])) end += 1;
      const word = source.slice(i, end);
      const precededByDot = source[i - 1] === '.';
      if (enabled.has('boolean-literal') && (word === 'true' || word === 'false') && !precededByDot) {
        candidates.push({
          operator: 'boolean-literal', start: i, end, original: word, replacement: word === 'true' ? 'false' : 'true',
        });
      }
      i = end - 1;
      continue;
    }
    const token = PUNCTUATORS.find((candidate) => source.startsWith(candidate, i)
      && [...candidate].every((_, offset) => mask[i + offset]));
    if (token === undefined) continue;
    const replacement = TOKEN_REPLACEMENTS[token];
    if (replacement !== undefined && enabled.has(replacement[0])) {
      const isRelational = replacement[0] === 'relational-boundary';
      const spaced = /\s/.test(source[i - 1] ?? '') && /\s/.test(source[i + token.length] ?? '');
      if (!isRelational || spaced) {
        candidates.push({
          operator: replacement[0], start: i, end: i + token.length, original: token, replacement: replacement[1],
        });
      }
    }
    i += token.length - 1;
  }
  candidates.push(...statementMutants(source, mask, starts, enabled));
  candidates.sort((a, b) => a.start - b.start || a.operator.localeCompare(b.operator));

  const lines = source.split('\n');
  const compiledIgnore = ignore.map((entry) => ({ operators: new Set(entry.operators), pattern: new RegExp(entry.pattern) }));
  return candidates
    .map((candidate) => {
      const { line, column } = positionOf(starts, candidate.start);
      return { ...candidate, line, column, lineText: lines[line - 1].replace(/\r$/, '').trim() };
    })
    .filter((candidate) => !compiledIgnore.some((entry) => entry.operators.has(candidate.operator)
      && entry.pattern.test(candidate.lineText)))
    .map((candidate, index) => ({ id: index + 1, ...candidate }));
}

export function applyMutant(source, mutant) {
  return source.slice(0, mutant.start) + mutant.replacement + source.slice(mutant.end);
}

/**
 * Drops what cannot be a finding.  `transpile` turns TypeScript into
 * JavaScript and throws on a syntax error; injected so the tests need no Bun
 * global.  Returns `{ valid, invalid, equivalent }`.
 */
export function partitionMutants(source, mutants, transpile) {
  const baseline = transpile(source);
  const valid = [];
  const invalid = [];
  const equivalent = [];
  for (const mutant of mutants) {
    let output;
    try {
      output = transpile(applyMutant(source, mutant));
    } catch {
      invalid.push(mutant);
      continue;
    }
    (output === baseline ? equivalent : valid).push(mutant);
  }
  return { valid, invalid, equivalent };
}

/* ------------------------------------------------------------------ */
/* Test mapping and coverage                                           */
/* ------------------------------------------------------------------ */

export function toPosix(path) {
  return path.split(sep).join('/').replaceAll('\\', '/');
}

const RELATIVE_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

/** The repository-relative `.ts` paths a test's relative imports resolve to. */
export function importedSources(testPath, text) {
  const resolved = new Set();
  for (const [, specifier] of text.matchAll(RELATIVE_SPECIFIER)) {
    const joined = toPosix(join(dirname(testPath), specifier)).replace(/^\.\//, '');
    const base = joined.replace(/\.(?:js|ts|mjs)$/, '');
    resolved.add(`${base}.ts`);
    resolved.add(`${base}/index.ts`);
  }
  return resolved;
}

/**
 * The tests that exercise `sourcePath`: direct importers plus the exact-name
 * test.  `readText` is injected so the mapping is testable over a fixture.
 */
export function testsFor(sourcePath, testPaths, readText) {
  const importsOf = (path) => importedSources(path, readText(path));
  return directTests(toPosix(sourcePath), selectableTests(testPaths), importsOf)
    .map((entry) => entry.test)
    .sort();
}

function selectableTests(testPaths) {
  return testPaths.map(toPosix).filter((test) => !EXCLUDED_TEST_PREFIXES.some((prefix) => test.startsWith(prefix)));
}

function isSameNameTest(target, test) {
  return test.split('/').at(-1) === `${target.split('/').at(-1).replace(/\.ts$/, '')}.test.ts`;
}

/** Same-name test (distance 0) and direct importers (distance 1). */
function directTests(target, tests, importsOf) {
  const entries = [];
  for (const test of tests) {
    if (isSameNameTest(target, test)) entries.push({ test, distance: 0 });
    else if (importsOf(test).has(target)) entries.push({ test, distance: 1 });
  }
  return entries;
}

/**
 * How many leading directories a test shares with the source it is mapped to,
 * once `src/` and the test tree's own prefix are stripped:
 * `tests/unit/cluster/sharding/X.test.ts` shares two with
 * `src/cluster/sharding/ShardCoordinator.ts`.
 */
export function sharedDirectoryDepth(sourcePath, testPath) {
  const sourceDirectories = toPosix(sourcePath).replace(/^src\//, '').split('/').slice(0, -1);
  const testDirectories = toPosix(testPath).replace(/^tests\/(?:unit\/|integration\/in-process\/|integration\/)?/, '')
    .split('/').slice(0, -1);
  let depth = 0;
  while (depth < sourceDirectories.length && sourceDirectories[depth] === testDirectories[depth]) depth += 1;
  return depth;
}

/**
 * Orders candidate tests most specific first: the same-name test, then by how
 * deep the test's directory mirrors the source's, then by import distance,
 * then by path — so a cap keeps the tests most likely to bind the file.
 */
export function rankTests(sourcePath, entries) {
  const keyed = entries.map((entry) => ({
    ...entry, sameName: isSameNameTest(toPosix(sourcePath), entry.test), depth: sharedDirectoryDepth(sourcePath, entry.test),
  }));
  keyed.sort((a, b) => Number(b.sameName) - Number(a.sameName)
    || b.depth - a.depth
    || a.distance - b.distance
    || (a.test < b.test ? -1 : a.test > b.test ? 1 : 0));
  return keyed.map((entry) => entry.test);
}

/**
 * The test list for one source file, and how it was reached.
 *
 * - `override` — `testMap` in `scripts/mutation-config.json` names the list;
 *   it always wins and is never capped, because somebody chose it.
 * - `direct` — the same-name test and the tests that import the file.
 * - `one-hop` — no test imports the file directly and none carries its name
 *   (it is reached through a barrel or an aggregate such as
 *   `ClusterSharding`), so the tests of every
 *   source module that imports or re-exports it are taken, one hop and no
 *   further: two hops reach `ActorSystem` and with it the whole suite.
 * - `none` — not even that.
 *
 * `maximum` caps the list after `rankTests`; what the cap drops is returned so
 * the report can say what was not run.  `importsOf(path)` returns the
 * repository paths a file's relative imports resolve to (`importedSources`).
 */
export function mapTests(sourcePath, { testPaths, sourcePaths = [], importsOf, overrides = {}, maximum }) {
  const target = toPosix(sourcePath);
  if (Object.hasOwn(overrides, target)) {
    return { tests: [...overrides[target]], via: 'override', candidates: overrides[target].length, dropped: [] };
  }
  const tests = selectableTests(testPaths);
  const entries = directTests(target, tests, importsOf);
  // A same-name test counts as direct: it was written for the file, and
  // widening past it would trade a one-file baseline for a subsystem's.
  let via = entries.length > 0 ? 'direct' : 'none';
  if (via === 'none') {
    const hops = new Set(sourcePaths.map(toPosix).filter((path) => path !== target && importsOf(path).has(target)));
    for (const test of tests) {
      const imports = importsOf(test);
      if ([...hops].some((hop) => imports.has(hop))) entries.push({ test, distance: 2 });
    }
    if (entries.length > 0) via = 'one-hop';
  }
  const ranked = rankTests(target, entries);
  const kept = maximum === undefined ? ranked : ranked.slice(0, maximum);
  return { tests: kept, via, candidates: ranked.length, dropped: ranked.slice(kept.length) };
}

/* ------------------------------------------------------------------ */
/* Changed lines                                                       */
/* ------------------------------------------------------------------ */

function diffPath(header) {
  let path = header;
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  return path === '/dev/null' ? undefined : toPosix(path.replace(/^b\//, ''));
}

/**
 * Path → the set of line numbers (in the new file, which is the working tree)
 * that `git diff -U0 --dst-prefix=b/` reports as added or changed.  A hunk of
 * new-count 0 is a pure deletion and adds no line; a renamed file is keyed by
 * its new path.  Hunk bodies are skipped by count, so an added line that
 * happens to read `+++ x` is never taken for a file header.
 */
export function changedLinesFromDiff(diff) {
  const changed = new Map();
  let current;
  let remaining = 0;
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (remaining > 0) {
      if (line.startsWith('+') || line.startsWith('-')) { remaining -= 1; continue; }
      if (line.startsWith('\\')) continue;
      remaining = 0;
    }
    if (line.startsWith('diff --git ')) { current = undefined; continue; }
    if (line.startsWith('+++ ')) {
      current = diffPath(line.slice(4));
      if (current !== undefined && !changed.has(current)) changed.set(current, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null) continue;
    const oldCount = hunk[1] === undefined ? 1 : Number(hunk[1]);
    const start = Number(hunk[2]);
    const newCount = hunk[3] === undefined ? 1 : Number(hunk[3]);
    remaining = oldCount + newCount;
    if (current === undefined) continue;
    const lines = changed.get(current);
    for (let number = start; number < start + newCount; number += 1) lines.add(number);
  }
  return changed;
}

/** Splits mutants into those on a changed line and those off it.  No line set: nothing changed. */
export function filterToChangedLines(mutants, lines) {
  const kept = [];
  const filtered = [];
  for (const mutant of mutants) (lines?.has(mutant.line) ? kept : filtered).push(mutant);
  return { kept, filtered };
}

/**
 * Line → hit count for one file out of an lcov report.  A line absent from the
 * map was not instrumented (a declaration, a brace) and is treated as covered
 * by the caller: an unknown is run, never skipped.
 */
export function lineHits(lcov, sourcePath) {
  const target = toPosix(sourcePath);
  const hits = new Map();
  let inFile = false;
  for (const raw of lcov.split(/\r?\n/)) {
    if (raw.startsWith('SF:')) inFile = toPosix(raw.slice(3)) === target;
    else if (raw === 'end_of_record') inFile = false;
    else if (inFile && raw.startsWith('DA:')) {
      const [line, count] = raw.slice(3).split(',').map(Number);
      hits.set(line, count);
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* Classification and the report                                       */
/* ------------------------------------------------------------------ */

/** One mutant run's outcome.  A hang is detection — the suite noticed nothing was right — but flagged. */
export function classifyRun({ exitCode, timedOut }) {
  if (timedOut) return 'timed-out';
  return exitCode === 0 ? 'survived' : 'killed';
}

/** True once the `--budget-minutes` deadline is reached; `>=`, so a budget of 0 runs nothing. */
export function budgetSpent(deadline, now) {
  return deadline !== undefined && now >= deadline;
}

export function timeoutFor(baselineMs, { factor = DEFAULT_TIMEOUT_FACTOR, slackMs = DEFAULT_TIMEOUT_SLACK_MS, fixedMs } = {}) {
  if (fixedMs !== undefined) return fixedMs;
  return Math.max(MINIMUM_TIMEOUT_MS, Math.round(baselineMs * factor + slackMs));
}

const STATUSES = ['killed', 'timed-out', 'survived', 'no-coverage', 'not-run'];

export function countStatuses(mutants) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const mutant of mutants) counts[mutant.status] += 1;
  const detected = counts.killed + counts['timed-out'];
  const scored = detected + counts.survived;
  return { ...counts, total: mutants.length, score: scored === 0 ? null : detected / scored };
}

function percent(score) {
  return score === null ? 'n/a' : `${(score * 100).toFixed(1)} %`;
}

/**
 * The baseline document for a finished run: per-file counts, stamped with where
 * they came from.  A file the run skipped or did not finish is left out, so a
 * partial night never records a partial count as the reference.
 */
export function baselineDocument(report) {
  return {
    $comment: 'Written by `bun run test:mutation -- --write-baseline` (#1368). Survivors per file, for comparison — not a gate.',
    recordedAt: report.startedAt,
    commit: report.commit,
    bunVersion: report.bunVersion,
    files: Object.fromEntries(report.files
      .filter((file) => file.skipped === undefined && file.counts['not-run'] === 0)
      .map((file) => [file.path, {
        killed: file.counts.killed,
        timedOut: file.counts['timed-out'],
        survived: file.counts.survived,
        noCoverage: file.counts['no-coverage'],
      }])),
  };
}

export function renderMarkdown(report) {
  const out = ['# Mutation report', ''];
  if (report.interrupted !== undefined) {
    out.push(`> **Partial report** — interrupted by ${report.interrupted.signal} at ${report.interrupted.at}. `
      + 'Mutants after that point are not-run, and files after it are absent.', '');
  }
  out.push(`- bun ${report.bunVersion ?? 'unknown'}, commit ${report.commit ?? 'unknown'}, ${report.startedAt}`);
  out.push(`- score **${percent(report.totals.score)}** — killed ${report.totals.killed}, `
    + `timed-out ${report.totals['timed-out']}, survived ${report.totals.survived}, `
    + `no-coverage ${report.totals['no-coverage']}, not-run ${report.totals['not-run']}`);
  out.push('', '| file | tests | score | killed | timed-out | survived | baseline survived | no-coverage | not-run | invalid | equivalent |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const file of report.files) {
    const c = file.counts;
    const note = file.skipped ? ` (${file.skipped})` : '';
    const recorded = report.baseline?.[file.path]?.survived;
    out.push(`| \`${file.path}\`${note} | ${file.tests.length} | ${percent(c.score)} | ${c.killed} | ${c['timed-out']} | `
      + `${c.survived} | ${recorded ?? '—'} | ${c['no-coverage']} | ${c['not-run']} | ${file.invalid} | ${file.equivalent} |`);
  }
  // How each file's tests were chosen and how much of it was mutated: what a
  // reader needs to judge a survivor (was the binding suite even run?).
  const mapped = report.files.filter((file) => file.testMapping !== undefined || file.changedLines !== undefined);
  if (mapped.length > 0) {
    out.push('', '## Test mapping', '');
    out.push('| file | via | tests run | dropped by the cap | mutants on changed lines | off the changed lines |');
    out.push('|---|---|---:|---:|---:|---:|');
    for (const file of mapped) {
      const mapping = file.testMapping;
      out.push(`| \`${file.path}\` | ${mapping?.via ?? '—'} | ${file.tests.length} | ${mapping?.dropped.length ?? '—'} | `
        + `${file.changedLines?.kept ?? '—'} | ${file.changedLines?.filtered ?? '—'} |`);
    }
  }
  const survivors = report.files.flatMap((file) => file.mutants
    .filter((mutant) => mutant.status === 'survived' || mutant.status === 'timed-out')
    .map((mutant) => ({ file: file.path, ...mutant })));
  if (survivors.length > 0) {
    out.push('', '## Survivors and timeouts', '');
    out.push('A survivor is a change no test noticed. A timeout is a change that made the tests hang — detected, but by accident.', '');
    for (const mutant of survivors) {
      out.push(`- **${mutant.status}** \`${mutant.file}:${mutant.line}:${mutant.column}\` ${mutant.operator}: `
        + `\`${mutant.original}\` → \`${mutant.replacement}\` — \`${mutant.lineText}\``);
    }
  }
  return `${out.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* The file guard: write a mutant, always put the original back        */
/* ------------------------------------------------------------------ */

function writeAtomically(path, content) {
  const temporary = `${path}.mutation-tmp`;
  writeFileSync(temporary, content);
  try {
    renameSync(temporary, path);
  } catch {
    // Windows refuses a rename over a file another process holds open (an
    // indexer, a scanner).  Fall back to an in-place write, and never leave
    // the temporary behind.
    writeFileSync(path, content);
    try { unlinkSync(temporary); } catch { /* already gone */ }
  }
}

/**
 * Owns every mutated file.  `mutate` journals the original to disk before the
 * first byte of the mutant is written; `restore` writes it back and only then
 * drops the journal entry.  So at every instant either the file is original,
 * or the journal holds the original — which is what `recover` relies on after
 * a run that died without its handlers.
 */
export function createFileGuard({ journalDirectory, root = process.cwd() }) {
  const originals = new Map();
  const entryPath = (path) => join(journalDirectory, `${createHash('sha256').update(path).digest('hex').slice(0, 16)}.json`);

  const restore = (path) => {
    const original = originals.get(path);
    if (original === undefined) return;
    writeAtomically(resolve(root, path), original);
    originals.delete(path);
    rmSync(entryPath(path), { force: true });
  };

  return {
    mutate(path, original, mutated) {
      if (!originals.has(path)) {
        mkdirSync(journalDirectory, { recursive: true });
        writeFileSync(entryPath(path), JSON.stringify({ path, original: original.toString('base64') }));
        originals.set(path, original);
      }
      writeAtomically(resolve(root, path), mutated);
    },
    restore,
    restoreAll() {
      for (const path of [...originals.keys()]) restore(path);
    },
    pending() {
      return [...originals.keys()];
    },
    /** Restores whatever an earlier, killed run left journaled.  Returns the paths it restored. */
    recover() {
      if (!existsSync(journalDirectory)) return [];
      const restored = [];
      for (const name of readdirSync(journalDirectory)) {
        if (!name.endsWith('.json')) continue;
        const { path, original } = JSON.parse(readFileSync(join(journalDirectory, name), 'utf8'));
        const bytes = Buffer.from(original, 'base64');
        const target = resolve(root, path);
        if (!existsSync(target) || !readFileSync(target).equals(bytes)) {
          writeAtomically(target, bytes);
          restored.push(path);
        }
        rmSync(join(journalDirectory, name), { force: true });
      }
      return restored;
    },
  };
}

/**
 * Restore on the way out, however the way out happens.  `target` is the
 * process (injected for the tests); a signal restores, then exits with the
 * shell's 128 + n convention so a CI step reads it as interrupted.
 */
export function installRestoreHandlers(guard, { target = process, onSignal, onInterrupted, log = console.error } = {}) {
  const signalNumbers = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
  const handlers = [];
  for (const [signal, number] of Object.entries(signalNumbers)) {
    const handler = () => {
      onSignal?.(signal);
      guard.restoreAll();
      // Only once the tree is whole: the partial report is worth hours of
      // results, but never a mutated file, and a failure writing it must not
      // keep the process from exiting.
      try {
        onInterrupted?.(signal);
      } catch (error) {
        log(`mutation-run: interrupted by ${signal}; the partial report could not be written: ${error?.message ?? error}`);
      }
      target.exit(128 + number);
    };
    target.on(signal, handler);
    handlers.push([signal, handler]);
  }
  const onExit = () => guard.restoreAll();
  target.on('exit', onExit);
  handlers.push(['exit', onExit]);
  return () => { for (const [event, handler] of handlers) target.off(event, handler); };
}

/* ------------------------------------------------------------------ */
/* Running a command under a watchdog                                  */
/* ------------------------------------------------------------------ */

function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

/**
 * Runs `command` with `args`, resolving `{ exitCode, timedOut, durationMs,
 * output }`.  On timeout the whole process tree is killed — `bun test` may have
 * children, and a child left running would hold the mutated file's tests open
 * into the next mutant.
 */
export function runWithTimeout(command, args, { timeoutMs, cwd = process.cwd(), environment = process.env, onChild } = {}) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    onChild?.(child);
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    let settled = false;
    let timedOut = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearTimeout(lastResort);
      resolveRun({ exitCode, timedOut, durationMs: Date.now() - startedAt, output: Buffer.concat(chunks).toString('utf8') });
    };
    let lastResort;
    const watchdog = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // A child stuck past SIGKILL must not stall the run.
      lastResort = setTimeout(() => finish(null), KILL_GRACE_MS);
    }, timeoutMs);
    child.on('error', () => finish(null));
    child.on('close', (exitCode) => finish(exitCode));
  });
}

/* ------------------------------------------------------------------ */
/* Arguments and file selection                                        */
/* ------------------------------------------------------------------ */

export function parseArguments(argv) {
  const options = {
    files: [], globs: [], since: undefined, set: undefined, tests: [], operators: [...OPERATORS],
    reportDirectory: DEFAULT_REPORT_DIRECTORY, configPath: DEFAULT_CONFIG_PATH, baselinePath: DEFAULT_BASELINE_PATH,
    writeBaseline: false, timeoutFactor: DEFAULT_TIMEOUT_FACTOR,
    timeoutMs: undefined, budgetMinutes: undefined, maximumMutantsPerFile: undefined, maximumTestsPerFile: undefined, stopFile: undefined,
    mutantIds: undefined, dryRun: false, recoverOnly: false, changedLines: false,
  };
  const number = (name, value) => {
    const parsed = Number(value);
    if (value.trim() === '' || !Number.isFinite(parsed)) throw new UsageError(`--${name} needs a number, got "${value}"`);
    return parsed;
  };
  const numbers = (name, value) => value.split(',').map((part) => number(name, part));
  // Each value-taking flag, applied to its value.  Both spellings reach it:
  // `--files=src/a.ts` and `--files src/a.ts`.
  const valued = {
    files: (value) => options.globs.push(value),
    since: (value) => { options.since = value; },
    set: (value) => { options.set = value; },
    tests: (value) => options.tests.push(...value.split(',')),
    operators: (value) => { options.operators = value.split(','); },
    'report-dir': (value) => { options.reportDirectory = value; },
    config: (value) => { options.configPath = value; },
    baseline: (value) => { options.baselinePath = value; },
    'timeout-factor': (value) => { options.timeoutFactor = number('timeout-factor', value); },
    timeout: (value) => { options.timeoutMs = number('timeout', value); },
    'budget-minutes': (value) => { options.budgetMinutes = number('budget-minutes', value); },
    'max-mutants': (value) => { options.maximumMutantsPerFile = number('max-mutants', value); },
    'max-tests-per-file': (value) => { options.maximumTestsPerFile = number('max-tests-per-file', value); },
    'stop-file': (value) => { options.stopFile = value; },
    // Re-check named mutants only — the survivors of an earlier run, say, against a wider --tests.
    mutants: (value) => { options.mutantIds = numbers('mutants', value); },
  };
  const switches = {
    'write-baseline': () => { options.writeBaseline = true; },
    'dry-run': () => { options.dryRun = true; },
    recover: () => { options.recoverOnly = true; },
    'changed-lines': () => { options.changedLines = true; },
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const match = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(argument);
    if (!match) { options.files.push(argument); continue; }
    const [, name, inlineValue] = match;
    if (Object.hasOwn(switches, name)) {
      if (inlineValue !== undefined) throw new UsageError(`--${name} takes no value`);
      switches[name]();
      continue;
    }
    if (!Object.hasOwn(valued, name)) throw new UsageError(`unknown option "${argument}"`);
    let value = inlineValue;
    if (value === undefined) {
      const next = argv[index + 1];
      // A following flag is not a value: `--files --dry-run` is a forgotten glob.
      if (next === undefined || next.startsWith('--')) throw new UsageError(`--${name} needs a value`);
      value = next;
      index += 1;
    }
    if (value === '') throw new UsageError(`--${name} needs a non-empty value`);
    valued[name](value);
  }
  for (const operator of options.operators) {
    if (!OPERATORS.includes(operator)) throw new UsageError(`unknown operator "${operator}" (known: ${OPERATORS.join(', ')})`);
  }
  // Changed against what?  Only --since names a base the diff can be taken from.
  if (options.changedLines && options.since === undefined) throw new UsageError('--changed-lines needs --since=<ref>');
  if (options.maximumTestsPerFile !== undefined
    && (!Number.isInteger(options.maximumTestsPerFile) || options.maximumTestsPerFile < 1)) {
    throw new UsageError(`--max-tests-per-file needs a whole number of at least 1, got ${options.maximumTestsPerFile}`);
  }
  return options;
}

/** A mistake on the command line: reported in one line with exit status 2, never as a stack trace. */
export class UsageError extends Error {
  constructor(message) {
    super(`mutation-run: ${message}`);
    this.name = 'UsageError';
  }
}

/** Source files a mutation run may touch: TypeScript under `src/`, no declarations, nothing generated. */
export function isMutableSource(path) {
  const posix = toPosix(path);
  return posix.startsWith('src/') && posix.endsWith('.ts') && !posix.endsWith('.d.ts')
    && !posix.startsWith('src/devtools/generated/');
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function selectFiles(options, config) {
  const selected = new Set(options.files.map(toPosix));
  const globs = [...options.globs];
  if (options.set !== undefined) {
    const set = config.sets?.[options.set];
    if (set === undefined) throw new Error(`mutation-run: no set "${options.set}" in ${options.configPath}`);
    globs.push(...set.files);
  }
  for (const pattern of globs) {
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: process.cwd() })) selectedAdd(selected, path);
  }
  let changedLines;
  if (options.since !== undefined) {
    // Merge base to working tree: what this branch changed, committed or not,
    // and nothing a moving base gained since the branch was cut.
    const base = git(['merge-base', options.since, 'HEAD']);
    for (const path of git(['diff', '--name-only', '--diff-filter=ACMR', base, '--', 'src']).split('\n')) {
      if (path !== '') selectedAdd(selected, path);
    }
    if (options.changedLines) {
      // The same base, so a line counts as changed exactly when its file was
      // selected for changing.  Prefixes pinned: a user's diff.noprefix or
      // diff.mnemonicPrefix must not move the path the parser keys on.
      changedLines = changedLinesFromDiff(git([
        'diff', '-U0', '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/',
        '--diff-filter=ACMR', base, '--', 'src',
      ]));
    }
  }
  return { files: [...selected].filter(isMutableSource).sort(), changedLines };
}

function allSourceFiles() {
  return [...new Bun.Glob('src/**/*.ts').scanSync({ cwd: process.cwd() })].map(toPosix).filter((path) => !path.endsWith('.d.ts'));
}

function selectedAdd(selected, path) {
  selected.add(toPosix(path));
}

function allTestFiles() {
  return [...new Bun.Glob('tests/**/*.test.ts').scanSync({ cwd: process.cwd() })].map(toPosix);
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function mutateFile(path, {
  options, config, guard, deadline, activeChild, testPaths, sourcePaths, importsOf, changedLines,
  stopRequested = () => false, onRecord,
}) {
  const originalBytes = readFileSync(path);
  const source = originalBytes.toString('utf8');
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const candidates = findMutants(source, { operators: options.operators, ignore: config.ignore ?? [] });
  const { valid, invalid, equivalent } = partitionMutants(source, candidates, (code) => transpiler.transformSync(code));
  // Ids stay those of the whole file, so a --mutants list from an earlier run still names the same mutants.
  const { kept: onDiff, filtered: offDiff } = changedLines === undefined
    ? { kept: valid, filtered: [] }
    : filterToChangedLines(valid, changedLines.get(toPosix(path)));
  const selected = options.mutantIds === undefined ? onDiff : onDiff.filter((mutant) => options.mutantIds.includes(mutant.id));
  const chosen = options.maximumMutantsPerFile === undefined ? selected : selected.slice(0, options.maximumMutantsPerFile);
  const mapping = options.tests.length > 0
    ? { tests: options.tests, via: 'command-line', candidates: options.tests.length, dropped: [] }
    : mapTests(path, {
      testPaths, sourcePaths, importsOf, overrides: config.testMap ?? {},
      maximum: options.maximumTestsPerFile ?? config.maxTestsPerFile,
    });
  const { tests } = mapping;
  const record = {
    path, tests, testMapping: { via: mapping.via, candidates: mapping.candidates, dropped: mapping.dropped },
    changedLines: changedLines === undefined ? undefined : { kept: onDiff.length, filtered: offDiff.length },
    invalid: invalid.length, equivalent: equivalent.length, skipped: undefined, baselineMs: undefined,
    mutants: chosen.map(({ id, operator, line, column, original, replacement, lineText }) => ({
      id, operator, line, column, original, replacement, lineText, status: 'not-run', durationMs: undefined,
    })),
  };
  const finishRecord = () => ({ ...record, counts: countStatuses(record.mutants) });
  // The file in flight, as it stands: what a partial report includes if the run is interrupted mid-file.
  onRecord?.(finishRecord);

  const offDiffNote = changedLines === undefined ? '' : `, ${offDiff.length} off the changed lines`;
  const capNote = mapping.dropped.length === 0 ? '' : `, ${mapping.dropped.length} more dropped by the cap`;
  console.log(`\n${path}: ${chosen.length} mutant(s) (${invalid.length} invalid, ${equivalent.length} equivalent dropped${offDiffNote}), `
    + `${tests.length} test file(s) via ${mapping.via}${capNote}`);
  if (mapping.dropped.length > 0) console.log(`  dropped by the test cap: ${mapping.dropped.join(', ')}`);
  if (options.dryRun) {
    for (const mutant of record.mutants) {
      console.log(`  #${mutant.id} ${mutant.line}:${mutant.column} ${mutant.operator}: ${mutant.original} → ${mutant.replacement}`);
    }
    return finishRecord();
  }
  // A barrel has nothing to mutate; its baseline run would cost minutes for no mutant.
  if (record.mutants.length === 0) return finishRecord();
  if (tests.length === 0) {
    for (const mutant of record.mutants) mutant.status = 'no-coverage';
    record.skipped = 'no test maps to this file';
    return finishRecord();
  }
  // Checked before the baseline as well as between mutants: a spent budget
  // must not buy one more file's coverage run, which can take minutes.
  if (budgetSpent(deadline, Date.now())) {
    record.skipped = 'budget exhausted';
    return finishRecord();
  }
  if (stopRequested()) {
    record.skipped = 'stopped';
    return finishRecord();
  }

  const coverageDirectory = join(options.reportDirectory, 'coverage');
  rmSync(coverageDirectory, { recursive: true, force: true });
  const baseline = await runWithTimeout(process.execPath, [
    'test', '--coverage', '--coverage-reporter=lcov', `--coverage-dir=${coverageDirectory}`, ...tests,
  ], { timeoutMs: BASELINE_TIMEOUT_MS, onChild: activeChild });
  record.baselineMs = baseline.durationMs;
  if (baseline.timedOut || baseline.exitCode !== 0) {
    record.skipped = baseline.timedOut ? 'baseline hung' : 'baseline red';
    writeFileSync(join(options.reportDirectory, `baseline-${path.replaceAll('/', '_')}.log`), baseline.output);
    console.log(`  skipped: ${record.skipped} — every mutant would read as killed`);
    return finishRecord();
  }
  const lcovPath = join(coverageDirectory, 'lcov.info');
  const hits = existsSync(lcovPath) ? lineHits(readFileSync(lcovPath, 'utf8'), path) : new Map();
  const timeoutMs = timeoutFor(baseline.durationMs, { factor: options.timeoutFactor, fixedMs: options.timeoutMs });
  console.log(`  baseline ${baseline.durationMs} ms, per-mutant timeout ${timeoutMs} ms`);

  for (const mutant of record.mutants) {
    if (hits.get(mutant.line) === 0) { mutant.status = 'no-coverage'; continue; }
    if (budgetSpent(deadline, Date.now()) || stopRequested()) break;
    const candidate = chosen.find((entry) => entry.id === mutant.id);
    try {
      guard.mutate(path, originalBytes, applyMutant(source, candidate));
      const result = await runWithTimeout(process.execPath, ['test', '--bail', ...tests], { timeoutMs, onChild: activeChild });
      mutant.status = classifyRun(result);
      mutant.durationMs = result.durationMs;
    } finally {
      guard.restore(path);
    }
    const marker = mutant.status === 'survived' ? 'SURVIVED' : mutant.status;
    console.log(`  #${mutant.id} ${mutant.line}:${mutant.column} ${mutant.operator} ${mutant.original} → ${mutant.replacement}: ${marker}`);
  }
  return finishRecord();
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    process.exit(2);
  }
  const reportDirectory = resolve(options.reportDirectory);
  options.reportDirectory = reportDirectory;
  const guard = createFileGuard({ journalDirectory: join(reportDirectory, 'journal') });

  const recovered = guard.recover();
  if (recovered.length > 0) console.warn(`mutation-run: restored ${recovered.length} file(s) an interrupted run left mutated: ${recovered.join(', ')}`);
  if (options.recoverOnly) return;

  let child;
  const records = [];
  let current;
  let startedAt = new Date().toISOString();
  let commit = null;
  try { commit = git(['rev-parse', '--short', 'HEAD']); } catch { /* not a checkout */ }
  const buildReport = (interrupted) => {
    const files = current === undefined ? records : [...records, current()];
    return {
      startedAt, finishedAt: new Date().toISOString(), bunVersion: process.versions.bun ?? null, commit,
      ...(interrupted === undefined ? {} : { interrupted }),
      operators: options.operators, files, totals: countStatuses(files.flatMap((record) => record.mutants)),
      baseline: existsSync(options.baselinePath) ? JSON.parse(readFileSync(options.baselinePath, 'utf8')).files : undefined,
    };
  };
  const writeReport = (report) => {
    mkdirSync(reportDirectory, { recursive: true });
    writeFileSync(join(reportDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    const markdown = renderMarkdown(report);
    writeFileSync(join(reportDirectory, 'report.md'), markdown);
    return markdown;
  };
  const writePartialReport = (signal) => {
    writeReport(buildReport({ signal, at: new Date().toISOString() }));
    console.error(`mutation-run: interrupted by ${signal}; partial report in ${relative(process.cwd(), reportDirectory) || '.'}`);
  };
  installRestoreHandlers(guard, {
    onSignal: () => { if (child !== undefined) killTree(child); },
    onInterrupted: writePartialReport,
  });
  // Polled between mutants and before each baseline.  The portable way to stop
  // a detached run: on Windows a signal sent to a process does not run its JS
  // handlers, a file appearing always reaches this check.
  const stopRequested = () => options.stopFile !== undefined && existsSync(options.stopFile);

  const config = JSON.parse(readFileSync(options.configPath, 'utf8'));
  const { files, changedLines } = selectFiles(options, config);
  if (files.length === 0) {
    console.error('mutation-run: no source files selected (give paths, --files=<glob>, --since=<ref> or --set=<name>)');
    process.exit(2);
  }
  mkdirSync(reportDirectory, { recursive: true });
  const deadline = options.budgetMinutes === undefined ? undefined : Date.now() + options.budgetMinutes * 60_000;
  const testPaths = allTestFiles();
  const sourcePaths = allSourceFiles();
  const importCache = new Map();
  const importsOf = (path) => {
    let imports = importCache.get(path);
    if (imports === undefined) {
      imports = existsSync(path) ? importedSources(path, readFileSync(path, 'utf8')) : new Set();
      importCache.set(path, imports);
    }
    return imports;
  };
  startedAt = new Date().toISOString();
  for (const path of files) {
    if (stopRequested()) break;
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    records.push(await mutateFile(path, {
      options, config, guard, deadline, testPaths, sourcePaths, importsOf, changedLines, stopRequested,
      activeChild: (spawned) => { child = spawned; },
      onRecord: (snapshot) => { current = snapshot; },
    }));
    current = undefined;
  }

  // The lcov scratch is per file and large; the report is what is kept.
  rmSync(join(reportDirectory, 'coverage'), { recursive: true, force: true });

  if (stopRequested()) {
    // Same partial report as a signal, same exit status as SIGTERM.  The stop
    // file is consumed, so the next run does not stop at its first check.
    guard.restoreAll();
    rmSync(options.stopFile, { force: true });
    writePartialReport('stop-file');
    process.exit(STOP_EXIT_CODE);
  }

  const report = buildReport(undefined);
  if (options.writeBaseline && !options.dryRun) {
    // Merged over what is recorded, so a run over one file does not erase the others.
    const document = baselineDocument(report);
    document.files = { ...(report.baseline ?? {}), ...document.files };
    writeFileSync(options.baselinePath, `${JSON.stringify(document, null, 2)}\n`);
    console.log(`mutation-run: baseline written to ${options.baselinePath}`);
  }
  const markdown = writeReport(report);
  console.log(`\n${markdown}`);
  console.log(`mutation-run: report in ${relative(process.cwd(), reportDirectory) || '.'}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}

if (import.meta.main) await main();
