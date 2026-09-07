import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * A repo-wide invariant over the *test* tree: an `awaitCondition` budget must
 * be reachable inside the per-test timeout that contains it.
 *
 * `awaitCondition`'s whole value over a fixed sleep is the message it throws —
 * it names the state that never became true, so a red run says which step
 * stalled instead of that the test was slow.  That message only ever reaches
 * the reporter if the budget expires *before* bun's per-test timeout kills the
 * test.  Bun's default is 5 000 ms and nothing in this repository raises it
 * globally, so a `timeoutMs: 10_000` is not a generous failure budget: it is
 * unreachable, and every run that hits it reports the runner's
 * `this test timed out after 5000ms` instead — the one line that says nothing
 * about which wait it was.
 *
 * Measured on bun 1.3.1 before this guard existed (a probe over
 * `tests/util/AwaitCondition.ts`):
 *
 *   (fail) budget 10s under the implicit 5s cap [5015.00ms]
 *     ^ this test timed out after 5000ms.        <- no label
 *   ...
 *   # Unhandled error between tests
 *   error: awaitCondition: never true (A) did not become true within 10000ms
 *
 * The label is not merely lost: it resurfaces 5 s later as an *unhandled*
 * error attributed to no test at all, adding a phantom entry to the run's
 * error count and pointing at whichever test happened to be running then.
 * That is worse than silence, because it accuses the wrong test.
 *
 * The gate below is deliberately the *narrow* one — the single largest budget
 * a test can reach, plus headroom, must fit in the cap.  It is not the sum of
 * a test's budgets: in a real failure one wait stalls and the ones before it
 * returned on their fast path, so the elapsed time when the stalling wait
 * starts is near zero.  Gating the sum would flag 84 tests whose labels do
 * print, and the noise would cost the gate its credibility.  {@link HEADROOM_MS}
 * is what covers the setup those earlier waits and the spawns around them
 * actually cost.
 *
 * Sibling repo-file guards: `tests/unit/ci/WorkflowHygiene.test.ts`,
 * `tests/unit/config/NoDeadConfigKeys.test.ts`.
 */

const TESTS_DIRECTORY = join(import.meta.dir, '..', '..');
const REPOSITORY_ROOT = join(TESTS_DIRECTORY, '..');

/**
 * Bun's per-test timeout when `test()` is given no third argument.  Not
 * readable from bun at runtime, and `bunfig.toml` does not raise it — the
 * spawned proof at the bottom of this file is what keeps the number honest.
 */
const BUN_DEFAULT_TEST_TIMEOUT_MS = 5_000;

/**
 * Slack between the largest reachable budget and the per-test cap, to cover
 * whatever the test spent before the stalling wait began — a cluster
 * `bootstrap`, a TestKit, a journal replay.  1 000 ms is not a round guess:
 * the repository's settled shape is a 4 000 ms budget under bun's 5 000 ms
 * default, which is exactly this much, so anything tighter would condemn the
 * house style and anything looser would stop binding it.
 */
const HEADROOM_MS = 1_000;

/** `awaitCondition`'s own default, applied when a call passes no `timeoutMs`. */
const AWAIT_CONDITION_DEFAULT_MS = 2_000;

/* ------------------------------------------------------------------ */
/* A very small TypeScript scanner                                     */
/* ------------------------------------------------------------------ */

/**
 * Comments, string bodies and regex literals blanked out, character for
 * character so every index still lines up with the original source.  Brace
 * and paren matching below would otherwise trip over a `)` inside a test name
 * or a `/[)]/` in an assertion — and the failure mode of a confused scanner
 * is a violation that goes unseen, so the accounting tests further down
 * assert it found the offenders it is supposed to find.
 */
function blankNonCode(source: string): string {
  const out = source.split('');
  let index = 0;
  let previous = '';
  const length = source.length;
  while (index < length) {
    const character = source[index];
    if (character === '/' && source[index + 1] === '/') {
      while (index < length && source[index] !== '\n') { out[index] = ' '; index++; }
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] !== '\n') out[index] = ' ';
        index++;
      }
      if (index < length) { out[index] = ' '; out[index + 1] = ' '; index += 2; }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      out[index] = ' ';
      index++;
      while (index < length) {
        if (source[index] === '\\') {
          out[index] = ' ';
          if (index + 1 < length && source[index + 1] !== '\n') out[index + 1] = ' ';
          index += 2;
          continue;
        }
        if (source[index] === quote) break;
        if (source[index] !== '\n') out[index] = ' ';
        index++;
      }
      if (index < length) out[index] = ' ';
      index++;
      previous = 'x';
      continue;
    }
    // A `/` right after an operator or an opener starts a regex, not a
    // division — the standard heuristic, and sufficient here.
    if (character === '/' && /[=(,:[!&|?{};+\-*%~^<>]/.test(previous)) {
      out[index] = ' ';
      index++;
      let inCharacterClass = false;
      while (index < length && source[index] !== '\n') {
        if (source[index] === '\\') {
          out[index] = ' ';
          if (index + 1 < length) out[index + 1] = ' ';
          index += 2;
          continue;
        }
        if (source[index] === '[') inCharacterClass = true;
        else if (source[index] === ']') inCharacterClass = false;
        else if (source[index] === '/' && !inCharacterClass) break;
        out[index] = ' ';
        index++;
      }
      if (index < length) out[index] = ' ';
      index++;
      previous = 'x';
      continue;
    }
    if (!/\s/.test(character)) previous = character;
    index++;
  }
  return out.join('');
}

/** Index of the closer matching the opener at `open`, or -1. */
function matchDelimiter(blanked: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let index = open; index < blanked.length; index++) {
    if (blanked[index] === opener) depth++;
    else if (blanked[index] === closer) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

const TEST_CALL = /\b(?:test|it)(?:\.(?:skip|todo|only|failing|if|skipIf|todoIf|each))?\s*\(/g;
/** The third argument of `test(name, fn, timeout)` — the per-test cap. */
const TRAILING_TIMEOUT_ARGUMENT = /,\s*([0-9][0-9_]*)\s*$/;
const AWAIT_CONDITION_CALL = /\bawaitCondition\s*\(/g;
/**
 * A `timeoutMs` in an options object, in every form the tree writes it.
 *
 * The capture is optional on purpose: `{ timeoutMs, intervalMs: 25 }` is the
 * **shorthand** form, and it is the one that made this guard blind.  Thirty-five
 * files wrap `awaitCondition` in a local `waitFor(predicate, timeoutMs = N, …)`
 * and forward the parameter that way; a pattern that insisted on a literal
 * matched none of them, so `budgetsBetween` fell through to
 * `AWAIT_CONDITION_DEFAULT_MS` and every one of those budgets read as 2 000 ms
 * (#1315).  Measured when this was fixed: 31 tests across 8 files could reach a
 * budget their cap could not accommodate, and the guard was green.
 */
const TIMEOUT_OPTION = /timeoutMs\s*(?::\s*([A-Za-z0-9_$]+))?/g;
/** A module-level `const NAME = 4_000;`, so a budget may be named. */
const NUMERIC_CONSTANT =
  /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*([0-9][0-9_]*)\s*;/gm;
const HELPER_DECLARATION =
  /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=/gm;

const numeric = (literal: string): number => Number(literal.replaceAll('_', ''));

/**
 * What one `timeoutMs` in an options object is worth, or `undefined` when it
 * cannot be read.
 *
 * `undefined` is a **finding**, not a silent zero.  The direction of this
 * fallback is the whole of #1315: the old scanner treated everything it could
 * not parse as the 2 000 ms default, so an 8 000 ms budget forwarded through a
 * wrapper read as comfortably inside a 5 000 ms cap.  A budget the guard cannot
 * evaluate has to be reported, because the alternative is a guard that is most
 * confident exactly where it understands least.
 */
function resolveBudget(
  token: string | undefined,
  constants: ReadonlyMap<string, number>,
  shorthandDefault: number | undefined,
): number | undefined {
  // `{ timeoutMs }` — the value comes from an enclosing parameter, whose
  // default the caller resolved for us.
  if (token === undefined) return shorthandDefault ?? AWAIT_CONDITION_DEFAULT_MS;
  if (/^[0-9][0-9_]*$/.test(token)) return numeric(token);
  return constants.get(token);
}

/** A budget the scanner could not evaluate, with enough to name it in a failure. */
type UnreadableBudget = { readonly file: string; readonly line: number; readonly token: string };

/**
 * Every `awaitCondition` budget between two offsets of the blanked source.
 *
 * `shorthandDefault` is what `{ timeoutMs }` resolves to in this region — for a
 * helper, the default of its own `timeoutMs` parameter.  Anything unreadable is
 * pushed onto `unreadable` rather than guessed at.
 */
function budgetsBetween(
  blanked: string,
  from: number,
  to: number,
  constants: ReadonlyMap<string, number> = new Map(),
  shorthandDefault?: number,
  unreadable?: UnreadableBudget[],
  file = '',
): number[] {
  const budgets: number[] = [];
  const region = blanked.slice(from, to);
  for (const call of region.matchAll(AWAIT_CONDITION_CALL)) {
    const open = call.index + call[0].length - 1;
    const close = matchDelimiter(region, open, '(', ')');
    if (close < 0) continue;
    const options = [...region.slice(open + 1, close).matchAll(TIMEOUT_OPTION)];
    if (options.length === 0) {
      budgets.push(AWAIT_CONDITION_DEFAULT_MS);
      continue;
    }
    const token = options.at(-1)![1];
    const resolved = resolveBudget(token, constants, shorthandDefault);
    if (resolved === undefined) {
      unreadable?.push({
        file,
        line: blanked.slice(0, from + call.index).split('\n').length,
        token: token ?? '(shorthand)',
      });
      continue;
    }
    budgets.push(resolved);
  }
  return budgets;
}

/**
 * Where a helper takes its budget, so a call site passing one positionally can
 * be read.
 *
 * `waitFor(predicate, 8_000)` is the shape #1315 names, and it is the only way
 * these wrappers are ever given a non-default budget.  Reading the *index* of
 * the `timeoutMs` parameter rather than assuming it is the second argument
 * costs one line and survives a wrapper that orders its parameters differently.
 */
type HelperBudgetParameter = { readonly index: number; readonly fallback: number | undefined };

function budgetParameterOf(parameterList: string): HelperBudgetParameter | undefined {
  const parameters = parameterList.split(/,(?![^(]*\))/).map((parameter) => parameter.trim());
  const index = parameters.findIndex((parameter) => /^timeoutMs\b/.test(parameter));
  if (index < 0) return undefined;
  const declaredDefault = /=\s*([0-9][0-9_]*)/.exec(parameters[index]!);
  return { index, fallback: declaredDefault ? numeric(declaredDefault[1]!) : undefined };
}

/** The budget a call passes at `index`, when it is a literal this scanner can read. */
function positionalBudget(argumentList: string, index: number): number | undefined {
  const args = argumentList.split(/,(?![^()]*\))/).map((argument) => argument.trim());
  const candidate = args[index];
  if (candidate === undefined || !/^[0-9][0-9_]*$/.test(candidate)) return undefined;
  return numeric(candidate);
}

type Budget = {
  readonly milliseconds: number;
  /** Name of the module-level helper the budget came from, or '' if inline. */
  readonly helper: string;
};

type TestBlock = {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  /** The third argument, when the test declares one. */
  readonly declaredTimeoutMs: number | undefined;
  readonly effectiveTimeoutMs: number;
  readonly budgets: readonly Budget[];
  readonly largest: Budget;
};

/**
 * Every `test()` in one file, with the budgets it can reach.
 *
 * Budgets arrive two ways.  Inline is the common one.  The other is a
 * module-level helper — `awaitAnycastReaches`, `awaitListing` — that wraps an
 * `awaitCondition` and is called from the test body; 32 call sites are shaped
 * that way, and ignoring them would leave the guard blind to exactly the
 * budgets a reader is least likely to notice.  Helper bodies are resolved
 * transitively (a helper calling a helper), by name, which is coarse: a name
 * that merely *appears* in a test body counts.  Over-attribution is the safe
 * direction — it can only demand more headroom.
 */
function scanFile(absolutePath: string, unreadable: UnreadableBudget[] = []): TestBlock[] {
  const source = readFileSync(absolutePath, 'utf8');
  const blanked = blankNonCode(source);
  const file = relative(REPOSITORY_ROOT, absolutePath).replaceAll('\\', '/');

  const blocks: { start: number; end: number; head: number }[] = [];
  for (const call of blanked.matchAll(TEST_CALL)) {
    const open = call.index + call[0].length - 1;
    let close = matchDelimiter(blanked, open, '(', ')');
    if (close < 0) continue;
    let start = open + 1;
    // `test.each(table)(name, fn, timeout)` — the first paren group is the
    // table, so reading it as the argument list would both miss the body's
    // budgets and mistake a trailing number in the table for a per-test cap.
    // Step onto the second group when there is one.
    if (call[0].includes('.each')) {
      const second = blanked.indexOf('(', close + 1);
      const between = blanked.slice(close + 1, second < 0 ? undefined : second);
      if (second >= 0 && between.trim() === '') {
        const secondClose = matchDelimiter(blanked, second, '(', ')');
        if (secondClose < 0) continue;
        start = second + 1;
        close = secondClose;
      }
    }
    blocks.push({ start, end: close, head: call.index });
  }
  const insideATest = (index: number): boolean =>
    blocks.some((block) => index >= block.start && index < block.end);

  // Module-level numeric constants, so `{ timeoutMs: SETTLE_MS }` is a budget
  // this scanner can read rather than one it has to report.
  const constants = new Map<string, number>();
  for (const constant of blanked.matchAll(NUMERIC_CONSTANT)) {
    constants.set(constant[1]!, numeric(constant[2]!));
  }

  /** The `(…)` parameter list that follows a declaration, blanked. */
  const parameterListAt = (from: number): string => {
    const open = blanked.indexOf('(', from);
    if (open < 0) return '';
    const close = matchDelimiter(blanked, open, '(', ')');
    return close < 0 ? '' : blanked.slice(open + 1, close);
  };

  type Helper = {
    start: number;
    end: number;
    budgets: number[];
    /** Where this helper takes a budget positionally, when it does. */
    parameter: HelperBudgetParameter | undefined;
  };
  const helpers = new Map<string, Helper>();
  for (const declaration of blanked.matchAll(HELPER_DECLARATION)) {
    if (insideATest(declaration.index)) continue;
    const name = declaration[1] ?? declaration[2];
    if (name === undefined) continue;
    const brace = blanked.indexOf('{', declaration.index + declaration[0].length - 1);
    if (brace < 0) continue;
    const end = matchDelimiter(blanked, brace, '{', '}');
    if (end < 0) continue;
    const parameter = budgetParameterOf(parameterListAt(declaration.index));
    helpers.set(name, {
      start: declaration.index,
      end,
      parameter,
      budgets: budgetsBetween(
        blanked, declaration.index, end, constants, parameter?.fallback, unreadable, file,
      ),
    });
  }
  // Expression-bodied arrows — `const waitFor = (p, l) => awaitCondition(…);` —
  // have no brace body for the pass above to bound.
  for (const declaration of blanked.matchAll(
    /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\(/gm,
  )) {
    if (insideATest(declaration.index)) continue;
    const name = declaration[1]!;
    if ((helpers.get(name)?.budgets.length ?? 0) > 0) continue;
    const statementEnd = blanked.indexOf(';', declaration.index);
    if (statementEnd < 0) continue;
    const parameter = budgetParameterOf(parameterListAt(declaration.index));
    const budgets = budgetsBetween(
      blanked, declaration.index, statementEnd, constants, parameter?.fallback, unreadable, file,
    );
    if (budgets.length > 0) {
      helpers.set(name, { start: declaration.index, end: statementEnd, budgets, parameter });
    }
  }
  // A helper that calls another helper reaches its budgets too.  Three passes
  // settle any chain this repository has; deeper nesting would need a fixpoint.
  for (let pass = 0; pass < 3; pass++) {
    for (const helper of helpers.values()) {
      const body = blanked.slice(helper.start, helper.end);
      for (const [otherName, other] of helpers) {
        if (other === helper) continue;
        if (new RegExp(`\\b${otherName}\\s*\\(`).test(body)) helper.budgets.push(...other.budgets);
      }
    }
  }

  const out: TestBlock[] = [];
  for (const block of blocks) {
    const argumentsBlanked = blanked.slice(block.start, block.end);
    const declared = TRAILING_TIMEOUT_ARGUMENT.exec(argumentsBlanked);
    const declaredTimeoutMs = declared ? numeric(declared[1]!) : undefined;
    const budgets: Budget[] = budgetsBetween(
      blanked, block.start, block.end, constants, undefined, unreadable, file,
    ).map((milliseconds) => ({ milliseconds, helper: '' }));
    for (const [name, helper] of helpers) {
      if (helper.budgets.length === 0) continue;
      const calls = [...argumentsBlanked.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))];
      if (calls.length === 0) continue;
      for (const milliseconds of helper.budgets) budgets.push({ milliseconds, helper: name });
      // A call site may pass a bigger budget positionally — `waitFor(p, 8_000)`
      // — which is the form #1315 names and the one the helper's own default
      // says nothing about.  Read it where the helper declares that parameter.
      if (helper.parameter === undefined) continue;
      for (const call of calls) {
        const open = block.start + call.index + call[0].length - 1;
        const close = matchDelimiter(blanked, open, '(', ')');
        if (close < 0) continue;
        const passed = positionalBudget(blanked.slice(open + 1, close), helper.parameter.index);
        if (passed !== undefined) budgets.push({ milliseconds: passed, helper: name });
      }
    }
    if (budgets.length === 0) continue;
    const largest = budgets.reduce((a, b) => (b.milliseconds > a.milliseconds ? b : a));
    out.push({
      file,
      line: source.slice(0, block.head).split('\n').length,
      name: /^\s*(['"`])([\s\S]*?)\1/.exec(source.slice(block.start, block.end))?.[2] ?? '(computed)',
      declaredTimeoutMs,
      effectiveTimeoutMs: declaredTimeoutMs ?? BUN_DEFAULT_TEST_TIMEOUT_MS,
      budgets,
      largest,
    });
  }
  return out;
}

function testFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (path.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

const unreadableBudgets: UnreadableBudget[] = [];
const blocks = testFiles(TESTS_DIRECTORY).flatMap((file) => scanFile(file, unreadableBudgets));

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

describe('awaitCondition budgets fit inside the per-test timeout', () => {
  /**
   * The gate itself, as one assertion rather than `test.each`: the whole
   * point is to read the offenders together, and 500-odd passing rows in the
   * reporter would bury the handful that matter.
   */
  test('every reachable budget leaves room for its message to be thrown', () => {
    const offenders = blocks
      .filter((block) => block.largest.milliseconds + HEADROOM_MS > block.effectiveTimeoutMs)
      .map((block) =>
        `  ${block.file}:${block.line}\n`
        + `      cap ${block.effectiveTimeoutMs}ms`
        + `${block.declaredTimeoutMs === undefined ? " (bun's default — the test declares none)" : ''}`
        + `, largest budget ${block.largest.milliseconds}ms`
        + `${block.largest.helper === '' ? '' : ` via ${block.largest.helper}()`}\n`
        + `      "${block.name}"`,
      );
    expect(
      offenders,
      `${offenders.length} test(s) declare an awaitCondition budget the per-test timeout `
      + `cannot reach, so the label never reaches the reporter and the run says `
      + `"this test timed out after ${BUN_DEFAULT_TEST_TIMEOUT_MS}ms" instead:\n`
      + `${offenders.join('\n')}\n`
      + `Give the test a third argument — test(name, fn, ${HEADROOM_MS}+budget) — or lower the budget.`,
    ).toEqual([]);
  });

  /**
   * A budget this scanner cannot evaluate is a finding, not a default.
   *
   * The direction of that fallback is the whole of #1315.  The old scanner read
   * one shape — `timeoutMs: <literal>` — and treated everything else as
   * `awaitCondition`'s 2 000 ms default, so an 8 000 ms budget forwarded through
   * a wrapper read as comfortably inside a 5 000 ms cap.  A guard is at its most
   * confident exactly where it understands least, which is the worst possible
   * arrangement, so anything unreadable now has to be made readable: a literal,
   * or a module-level `const`.
   */
  test('every budget is one the scanner could actually read', () => {
    const offenders = unreadableBudgets.map(
      (budget) => `  ${budget.file}:${budget.line}  timeoutMs: ${budget.token}`,
    );
    expect(
      offenders,
      `${offenders.length} awaitCondition budget(s) could not be evaluated, so this guard cannot `
      + 'say whether the per-test cap can reach them:\n'
      + `${offenders.join('\n')}\n`
      + 'State the budget as a numeric literal, or as a module-level `const NAME = 4_000;` this '
      + 'file can resolve. An expression the scanner has to guess at is a budget nobody can check.',
    ).toEqual([]);
  });

  /**
   * Guards the guard.  A scanner that silently matched nothing would satisfy
   * the assertion above forever; these pin that it is still reading the tree.
   */
  test('the scanner still sees the tree it is scanning', () => {
    expect(blocks.length).toBeGreaterThan(400);
    expect(blocks.some((block) => block.declaredTimeoutMs !== undefined)).toBe(true);
    expect(blocks.some((block) => block.largest.helper !== '')).toBe(true);
    // No test may reach a budget of zero or a negative one: that would mean the
    // parser produced a number from something that is not a `timeoutMs`.
    expect(blocks.every((block) => block.largest.milliseconds > 0)).toBe(true);
  });

  test.each([
    {
      what: 'an inline budget under an implicit cap',
      source: "test('a', async () => { await awaitCondition(f, { timeoutMs: 9_000 }); });",
      cap: 5_000,
      largest: 9_000,
    },
    {
      what: 'a declared third argument',
      source: "test('a', async () => { await awaitCondition(f, { timeoutMs: 9_000 }); }, 30_000);",
      cap: 30_000,
      largest: 9_000,
    },
    {
      what: 'a call with no timeoutMs at all',
      source: "test('a', async () => { await awaitCondition(f); });",
      cap: 5_000,
      largest: AWAIT_CONDITION_DEFAULT_MS,
    },
    {
      what: 'a budget reached through a module-level helper',
      source: 'const settle = (p) => awaitCondition(p, { timeoutMs: 8_000 });\n'
        + "test('a', async () => { await settle(f); });",
      cap: 5_000,
      largest: 8_000,
    },
    {
      what: 'a name containing a paren and a quoted brace',
      source: 'test(\'expect(a > b) and "}"\', async () => '
        + '{ await awaitCondition(f, { timeoutMs: 7_000 }); });',
      cap: 5_000,
      largest: 7_000,
    },
    {
      // The table is the first paren group, the test is the second.  Read the
      // wrong one and the body's budgets vanish while a number at the end of
      // the table is mistaken for the cap — a false pass in both halves.
      what: 'a test.each table, whose arguments live in the second call',
      source: 'test.each([{ n: 1 }, { n: 9_000 }])(\n'
        + "  'case $n', async () => { await awaitCondition(f, { timeoutMs: 6_000 }); }, 25_000);",
      cap: 25_000,
      largest: 6_000,
    },
    {
      // The #1315 shape, and the one that was invisible: the wrapper forwards
      // `timeoutMs` in shorthand, so there is no literal inside the
      // `awaitCondition(` call at all.  Its value is the parameter's default.
      what: 'a wrapper that forwards timeoutMs in shorthand',
      source: 'const waitFor = (p, timeoutMs = 4_000, label = 0) =>'
        + ' awaitCondition(p, { timeoutMs, intervalMs: 25, label });\n'
        + "test('a', async () => { await waitFor(f); });",
      cap: 5_000,
      largest: 4_000,
    },
    {
      // ...and the half that made the guard wrong rather than merely blind: a
      // call site may pass a bigger budget positionally, which the helper's own
      // default says nothing about.
      what: 'a budget passed positionally to such a wrapper',
      source: 'const waitFor = (p, timeoutMs = 4_000, label = 0) =>'
        + ' awaitCondition(p, { timeoutMs, intervalMs: 25, label });\n'
        + "test('a', async () => { await waitFor(f, 8_000); });",
      cap: 5_000,
      largest: 8_000,
    },
    {
      what: 'a budget named by a module-level constant',
      source: 'const SETTLE_MS = 7_000;\n'
        + "test('a', async () => { await awaitCondition(f, { timeoutMs: SETTLE_MS }); });",
      cap: 5_000,
      largest: 7_000,
    },
  ])('the scanner reads $what', ({ source, cap, largest }) => {
    const directory = mkdtempSync(join(tmpdir(), 'actor-ts-budget-scan-'));
    try {
      const path = join(directory, 'Fixture.test.ts');
      writeFileSync(path, source);
      const scanned = scanFile(path);
      expect(scanned).toHaveLength(1);
      expect(scanned[0]!.effectiveTimeoutMs).toBe(cap);
      expect(scanned[0]!.largest.milliseconds).toBe(largest);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  /**
   * A budget the scanner cannot evaluate must be reported rather than assumed,
   * and this is the case that proves the fallback runs in the safe direction.
   */
  test('a budget it cannot evaluate is reported, not defaulted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'actor-ts-budget-unreadable-'));
    try {
      const path = join(directory, 'Fixture.test.ts');
      writeFileSync(
        path,
        "test('a', async () => { await awaitCondition(f, { timeoutMs: budgets.slow }); });",
      );
      const unreadable: UnreadableBudget[] = [];
      const scanned = scanFile(path, unreadable);
      // No budget was attributed at all — the old scanner would have silently
      // called this 2 000 ms and passed.
      expect(scanned).toEqual([]);
      expect(unreadable).toHaveLength(1);
      expect(unreadable[0]!.token).toBe('budgets');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* The premise, re-measured                                            */
/* ------------------------------------------------------------------ */

describe("bun's per-test timeout is what makes the budgets matter", () => {
  /**
   * The positive half, in process: a budget comfortably inside the cap throws
   * its own error, so the label is what the reporter shows.  If bun preempted
   * instead, this test would not reach the assertion at all — it would be
   * killed and reported as a timeout, which is the failure this file exists
   * to prevent.
   */
  test('a budget inside the cap throws the labelled message', async () => {
    const thrown = await awaitCondition(() => false, {
      timeoutMs: 200,
      label: 'a condition that is never true',
    }).then(() => undefined, (error: unknown) => error as Error);
    expect(thrown?.message).toContain('a condition that is never true');
    expect(thrown?.message).toContain('did not become true within 200ms');
  }, 3_000);

  /**
   * The negative half, out of process, because it cannot be observed from
   * inside a test bun is in the middle of killing.  A child `bun test` runs
   * two fixtures that differ only in whether their rejection fits the cap;
   * the assertion is on what the reporter printed for each.
   *
   * This is the only check on {@link BUN_DEFAULT_TEST_TIMEOUT_MS} and on the
   * premise of the whole file.  Without it the gate above would be asserting
   * a fact about bun that nothing re-measures — precisely the shape of decay
   * it was written to stop.
   */
  test('a budget past the cap is replaced by the runner’s own message', () => {
    const directory = mkdtempSync(join(tmpdir(), 'actor-ts-budget-proof-'));
    try {
      writeFileSync(
        join(directory, 'Cap.test.ts'),
        [
          "import { test } from 'bun:test';",
          'const rejectAfter = (ms: number, label: string): Promise<never> =>',
          '  new Promise((_, reject) => {',
          '    setTimeout(() => { reject(new Error(`BUDGET-EXPIRED:${label}`)); }, ms);',
          '  });',
          "test('over the cap', async () => { await rejectAfter(1_200, 'over'); }, 300);",
          "test('under the cap', async () => { await rejectAfter(120, 'under'); }, 3_000);",
          '',
        ].join('\n'),
      );
      const child = spawnSync('bun', ['test', 'Cap.test.ts'], {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
        timeout: 60_000,
      });
      const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
      expect(output, 'the child bun run produced no reporter output').toContain('over the cap');

      // The over-cap test: bun's message, and the rejection's label is NOT
      // what the reporter attached to it.
      const overLine = output
        .split(/\r?\n/)
        .findIndex((line) => line.includes('over the cap'));
      expect(overLine).toBeGreaterThanOrEqual(0);
      expect(
        output.split(/\r?\n/).slice(overLine, overLine + 2).join('\n'),
        'bun no longer preempts a rejection scheduled past the per-test timeout — '
        + 'if that is now true, this whole guard can be deleted',
      ).toContain('timed out after 300ms');

      // The under-cap test: its own label survives to the reporter.
      expect(output).toContain('BUDGET-EXPIRED:under');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
