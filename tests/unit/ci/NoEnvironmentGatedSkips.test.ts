import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **An environment variable may not remove a test from CI.**
 *
 * This is the mechanism that hid three suites for months.  `ACTOR_TS_SKIP_FLAKY_MNS=1`
 * in three workflows, three copy-pasted `process.env.… ? describe.skip : describe`
 * ternaries, and a written exit criterion — fourteen consecutive green nights —
 * that lived in a YAML comment and was counted by a human reading run
 * annotations.  Nobody counted.  The workflow said so about itself: *"Nothing
 * accumulates the streak.  It is counted by a human reading these annotations,
 * which is the same failure that made the quarantine permanent in the first
 * place."*
 *
 * When the criterion was finally read against the runs, it had been met for
 * two of the three suites, and the third was not a runner problem at all — it
 * was a product defect in split-brain resolution (#839) that the quarantine had
 * been hiding rather than measuring.
 *
 * So the rule is not "do not skip tests".  It is narrower and it is the part
 * that failed:
 *
 * - **A capability probe is fine.**  `available ? describe : describe.skip` asks
 *   the machine what it can do — is there a live MinIO, can this filesystem make
 *   a symlink — and no workflow can set the answer.  A dozen of those exist and
 *   they stay.
 * - **An environment variable is not**, because it is exactly the thing a
 *   workflow *can* set, and setting it is how a red suite becomes an absent one.
 *
 * Anything genuinely in the second category needs a line in
 * {@link ENVIRONMENT_GATED_SKIPS} carrying the reason, which makes it a decision
 * somebody wrote down rather than a flag somebody exported.
 *
 * Sibling repo-file guards, same shape: `tests/unit/ci/WorkflowHygiene.test.ts`,
 * `tests/unit/ci/SleepRatchet.test.ts`, `tests/unit/ci/ExampleBindAddresses.test.ts`.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const TESTS_DIRECTORY = join(REPOSITORY_ROOT, 'tests');

/** A single backslash, spelled so no shell heredoc or editor can eat it. */
const BACKSLASH = String.fromCharCode(92);

/**
 * The skips an environment variable is allowed to decide, and why each is not
 * a quarantine.
 *
 * The distinguishing property is the **default**: an entry here is skipped
 * unless somebody asks for it, so it can never turn a failing product test into
 * an absent one.  A quarantine is the other way round — it runs by default and
 * a workflow switches it off.
 */
const ENVIRONMENT_GATED_SKIPS: ReadonlyMap<string, string> = new Map([
  [
    'tests/unit/ci/SleepRatchet.test.ts',
    'ACTOR_TS_SLEEP_RATCHET_REMEASURE is an opt-in re-measurement path, not a '
    + 'test of the product: it is skipped unless explicitly requested, so it '
    + 'cannot hide a failure.',
  ],
]);

/** Every source this repository wrote under `tests/`. */
function testSources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      testSources(full, found);
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs')) found.push(full);
  }
  return found;
}

/**
 * `source` with comments **and** string literals replaced by spaces, character
 * for character so line numbers still line up.
 *
 * Both have to go.  A comment describing the old quarantine is not a
 * quarantine, and neither is the fixture string in
 * `StressHarnessQuarantine.test.ts` — which contains a verbatim copy of the
 * ternary this file bans, on purpose, because that test's whole subject is
 * whether the harness really drops the variable before spawning a child.
 *
 * Quote state resets at every newline.  A scanner this simple cannot tell a
 * quote inside a regular-expression literal from the start of a string, and a
 * test tree is full of both; a JavaScript string cannot span an unescaped
 * newline, so the reset costs nothing on real strings and bounds the damage
 * from a regex literal to its own line.  The one loser is a multi-line template
 * literal, whose later lines read as code — which can only ever produce a false
 * *offender*, never a missed one.
 */
function blankCommentsAndStrings(source: string): string {
  const withoutComments = blankComments(source);
  return withoutComments
    .split('\n')
    .map((line) => {
      const out = line.split('');
      let index = 0;
      while (index < line.length) {
        const character = line[index];
        if (character === "'" || character === '"' || character === '`') {
          const quote = character;
          out[index] = ' ';
          index++;
          while (index < line.length) {
            if (line[index] === BACKSLASH) {
              out[index] = ' ';
              out[index + 1] = ' ';
              index += 2;
              continue;
            }
            const closing = line[index] === quote;
            out[index] = ' ';
            index++;
            if (closing) break;
          }
          continue;
        }
        index++;
      }
      return out.join('');
    })
    .join('\n');
}

/** `source` with every comment blanked, string literals kept. */
function blankComments(source: string): string {
  const out = source.split('');
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') { out[index] = ' '; index++; }
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] !== '\n') out[index] = ' ';
        index++;
      }
      if (index < source.length) { out[index] = ' '; out[index + 1] = ' '; index += 2; }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      index++;
      while (index < source.length) {
        if (source[index] === BACKSLASH) { index += 2; continue; }
        if (source[index] === quote) break;
        index++;
      }
      index++;
      continue;
    }
    index++;
  }
  return out.join('');
}

/** A read of the process environment, in either spelling the tree uses. */
const ENVIRONMENT_READ = /\bprocess\.env\b|\bglobalThis\.process\.env\b/;
/** Anything that removes a test or a block from the run. */
const SKIP = /\.skip\b|\bskipIf\s*\(/;

type Offender = { readonly file: string; readonly line: number; readonly text: string };

/**
 * Lines where an environment read and a skip meet.
 *
 * Per line rather than per expression: a skip decided by an environment
 * variable is written on one line in every form the tree has ever used — the
 * ternary, `skipIf(...)`, a `const gate = process.env.X ? … : …` — and a
 * scanner that tried to follow the value through a variable would be a type
 * checker.  The failure message names the line, which is where the decision is.
 */
function environmentGatedSkips(): Offender[] {
  const offenders: Offender[] = [];
  for (const file of testSources(TESTS_DIRECTORY)) {
    const label = file.split(BACKSLASH).join('/')
      .slice(REPOSITORY_ROOT.split(BACKSLASH).join('/').length + 1);
    if (label === 'tests/unit/ci/NoEnvironmentGatedSkips.test.ts') continue;
    if (ENVIRONMENT_GATED_SKIPS.has(label)) continue;
    const code = blankCommentsAndStrings(readFileSync(file, 'utf8'));
    code.split('\n').forEach((line, index) => {
      if (ENVIRONMENT_READ.test(line) && SKIP.test(line)) {
        offenders.push({ file: label, line: index + 1, text: line.trim() });
      }
    });
  }
  return offenders;
}

describe('no environment variable removes a test from CI', () => {
  test('the scanner reads the tree it claims to', () => {
    // A guard that quietly stopped reading would satisfy the assertion below by
    // finding nothing at all.
    expect(testSources(TESTS_DIRECTORY).length).toBeGreaterThan(400);
  });

  test('every environment-gated skip is one somebody wrote down', () => {
    expect(
      environmentGatedSkips(),
      'A test that an environment variable can switch off is a quarantine, and a '
      + 'quarantine with no owner is how three suites stayed out of CI for months '
      + '(#538). Gate on a capability probe instead — ask the machine what it can '
      + 'do, which no workflow can answer for it — or add the file to '
      + 'ENVIRONMENT_GATED_SKIPS with the reason it cannot hide a failure.',
    ).toEqual([]);
  }, 30_000);

  test.each([...ENVIRONMENT_GATED_SKIPS])(
    '%s is still gated, so its entry is not stale',
    (file) => {
      const code = blankCommentsAndStrings(readFileSync(join(REPOSITORY_ROOT, file), 'utf8'));
      const gated = code.split('\n').some((line) => ENVIRONMENT_READ.test(line) && SKIP.test(line));
      expect(
        gated,
        `${file} no longer gates on the environment, so its allow-list entry should go — `
        + 'an exemption nobody uses is an exemption nobody re-reads.',
      ).toBe(true);
    },
  );

  test('the three suites that were quarantined are gated by nothing', () => {
    // Named rather than derived: these are the files the rule was written for,
    // and "no offenders anywhere" would also be satisfied by deleting them.
    for (const file of [
      'tests/multi-node/LeaseMajority.test.ts',
      'tests/multi-node/ParallelPubSub.test.ts',
      'tests/unit/testkit/ParallelMultiNodeSpec.test.ts',
    ]) {
      const code = blankCommentsAndStrings(readFileSync(join(REPOSITORY_ROOT, file), 'utf8'));
      expect(ENVIRONMENT_READ.test(code), `${file} reads the environment again`).toBe(false);
    }
  });
});

describe('the guards on the guard', () => {
  test('the scanner sees a skip an environment variable decides', () => {
    const ternary = "const gate = process.env.SOMETHING === '1' ? describe.skip : describe;";
    const skipIf = "test.skipIf(process.env.SOMETHING === '1')('name', () => {});";
    for (const shape of [ternary, skipIf]) {
      const code = blankCommentsAndStrings(shape);
      expect(ENVIRONMENT_READ.test(code) && SKIP.test(code)).toBe(true);
    }
  });

  test('it does not see a capability probe, a comment, or a fixture string', () => {
    const probe = 'const suite = available ? describe : describe.skip;';
    const comment = '// process.env.SOMETHING used to decide describe.skip here.';
    const fixture = 'const source = "process.env.X ? describe.skip : describe";';
    for (const shape of [probe, comment, fixture]) {
      const code = blankCommentsAndStrings(shape);
      expect(ENVIRONMENT_READ.test(code) && SKIP.test(code)).toBe(false);
    }
  });

  test('an environment read on its own is not a skip', () => {
    // Tests read the environment for all sorts of reasons — a temp directory, a
    // broker URL. Only the pairing is the offence.
    const code = blankCommentsAndStrings("const url = process.env.BROKER_URL ?? 'amqp://localhost';");
    expect(ENVIRONMENT_READ.test(code)).toBe(true);
    expect(SKIP.test(code)).toBe(false);
  });
});
