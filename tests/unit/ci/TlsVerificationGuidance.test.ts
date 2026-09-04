import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * A repo invariant over what the shipped source *says* about TLS certificate
 * verification (#755).
 *
 * The defect this replaces was documentation, not code: `PostgresConnection`'s
 * `poolConfig` field illustrated itself with
 * `{ max: 10, ssl: { rejectUnauthorized: false } }` — the exact pattern
 * `operations/security/tls-everywhere.mdx` marks with a ✗ — and `buildPgPool`
 * spreads that object into `new pg.Pool(...)` unfiltered, so the snippet
 * worked.  A doc comment is the surface an editor shows on hover and
 * completion, which is to say it is guidance at the point of decision, and at
 * that point the framework was recommending the unsafe form to anyone wiring
 * TLS to their journal database.
 *
 * **This file exists because nothing in the suite can fail on JSDoc text.**
 * `bun test` transpiles comments away, `bun run typecheck` never reads them,
 * and no reviewer diffs a doc comment for a security property.  Without an
 * assertion the fix is unverifiable by the test suite and reverts in silence —
 * so the guard is the fix's binding, not an extra.
 *
 * Three properties, in narrowing order:
 *
 *  1. **No `rejectUnauthorized` binding in executable code under `src/` sets
 *     anything but a recognisably safe value.**  Structural and absolute: an
 *     occurrence in a comment can only mislead a reader, one in code turns
 *     verification off for real.  A line counts as a comment only when it
 *     *starts* with `*`, `//` or `/*`, which is deliberately conservative —
 *     `foo({ rejectUnauthorized: false })` can never be misread as prose, and
 *     a block comment opened halfway along a code line is reported rather than
 *     excused.
 *  2. **Only the files this inventory names may carry such a binding at all.**
 *     A phrase heuristic would be the obvious alternative and is the weaker
 *     one: a heuristic is satisfied by writing the phrase, whereas an
 *     inventory entry is a visible edit in the diff that adds the occurrence,
 *     next to a written reason.  Same shape as the coverage-gate ratchet — it
 *     may be edited, on purpose, and never by accident.
 *  3. **Each occurrence sits in a comment block that warns.**  The block has to
 *     name the hazard or point at the safe shape, so an entry on the inventory
 *     still cannot be a bare illustration.
 *
 * ### What "recognisably safe" means, and what this cannot promise
 *
 * The first version of this file matched one **exact substring**,
 * `rejectUnauthorized: false`, line by line.  An independent verifier put four
 * spellings into `buildPgPool` afterwards — the space removed, the pair split
 * across two lines, the key quoted, and the value written as an expression
 * that evaluates to false — and all four reached `new pg.Pool(...)` with this
 * file staying green.  The repair is a **whitelist of value shapes** instead of
 * a blacklist of falsy spellings, because the falsy spellings are open-ended
 * (`false`, `0`, `null`, `''`, `1 === 2`, `Boolean(0)`, …) and the shapes a
 * transport legitimately writes are not.  So the scan now finds the key in any
 * spelling — bare or quoted, any whitespace including newlines between key,
 * colon and value, `:` or `=` — and refuses every value that is not `true`,
 * a `boolean` type annotation, or a forward of the caller's own value
 * (`options.tls.rejectUnauthorized`, optionally `?? true`).  The four in-tree
 * code sites are all of the third shape and stay green; see the fixtures at
 * the bottom, which pin both directions.
 *
 * What it still **cannot** see, stated plainly because a guard that overstates
 * itself is worse than none — it stops the next reviewer looking:
 *
 *   - **A key that is not written literally** — a computed key such as
 *     `['reject' + 'Unauthorized']` or `[KNOB]`, or an object spread from a
 *     literal that lives outside `src/`.  A literal *inside* `src/` is caught
 *     wherever it is written, so the escape is a genuinely dynamic key, not a
 *     variable.
 *   - **What a caller passes.**  `PostgresConnection.poolConfig` lands in
 *     `new pg.Pool(...)` verbatim and by design; the caller's own choice is not
 *     this repo's source.  That seam is documentation's job, which is the
 *     positive half of this file.
 *   - **The other ways to disable verification** — a `checkServerIdentity`
 *     that returns `undefined`, a custom `secureContext` or agent, or the
 *     `NODE_TLS_REJECT_UNAUTHORIZED` environment variable.  None of them is
 *     this key, and none of them is checked here.
 *   - **Anything outside `src/`** — tests, examples, benchmarks and the code
 *     samples in `docs/` are all unscanned.
 *
 * Those limits are fixtures too, at the bottom of this file, so the paragraph
 * above is executable rather than a claim.
 *
 * Then the positive half, which is what actually binds #755: the four Postgres
 * `poolConfig` surfaces must *show* the safe form and link the TLS page.
 * Property 1 alone would be satisfied by a JSDoc that says nothing at all.
 *
 * Note what the fixed JSDoc deliberately does **not** do: it names the knob in
 * prose ("switching certificate verification off") instead of spelling the
 * value out.  A tooltip has none of the red framing a Starlight
 * `<Aside type="caution">` gives the docs pages, so a warning that quotes the
 * unsafe snippet at the point of decision still hands over the paste — which
 * is the failure mode #755 is about.  That is a documentation judgement, and
 * this file's carve-out exists for the one site where naming the value is
 * unavoidable, not to spare the maintainers of these four.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const SOURCE_ROOT = join(REPOSITORY_ROOT, 'src');

/** The knob itself, spelled as node-postgres and node:tls spell it. */
const VERIFICATION_KNOB = 'rejectUnauthorized';

/**
 * The anti-pattern in its canonical spelling — the one `tls-everywhere.mdx`
 * marks with a cross, and the one the failure messages quote.  It is no
 * longer what the scan *matches*: see {@link bindingPattern}.
 */
const DISABLED_VERIFICATION = `${VERIFICATION_KNOB}: false`;

/**
 * Files allowed to mention {@link DISABLED_VERIFICATION} at all, with the
 * reason.  Adding an entry is the deliberate act; doing it to make this test
 * pass, rather than because the comment genuinely warns, is the thing the
 * written reason is here to make awkward.
 */
const WARNING_SITES: Readonly<Record<string, string>> = {
  'src/runtime/tcp/DenoTcpBackend.ts':
    'explains that the option has no Deno equivalent and is deliberately not '
    + 'mapped — setting it there does nothing, so the comment has to name the '
    + 'value a reader would otherwise expect to work, and it points at `ca` '
    + 'instead',
};

/**
 * A block earns its occurrence by naming the hazard or pointing at the safe
 * shape.  Matched case-insensitively over the whole enclosing comment block,
 * not the single line, because the warning is usually a sentence away from the
 * value it is warning about.
 *
 * Deliberately a short list, and it *will* reject prose that warns in substance
 * while reaching for none of these words — a draft of the fix above said
 * "encryption without verification authenticates nobody", which is a perfectly
 * good warning and matches nothing here.  That is the intended cost: a new
 * warning site takes two deliberate acts (an inventory entry and recognisable
 * vocabulary), and the alternative — growing this list until any sufficiently
 * apologetic sentence passes — is how the check stops checking.
 */
const WARNING_MARKERS: ReadonlyArray<string> = [
  'instead',
  'mitm',
  'unauthenticated',
  'unverified',
  'does nothing',
  'no effect',
  '✗',
];

/** The safe illustration, identical on all four Postgres surfaces. */
const SAFE_ILLUSTRATION = "ssl: { rejectUnauthorized: true, ca: fs.readFileSync('rds-ca.pem') }";

/** Where the reasoning lives in full.  Quoted, so a page rename is loud. */
const TLS_PAGE = 'https://actor-ts.dev/operations/security/tls-everywhere/';

/**
 * The four surfaces a developer reaches for when wiring TLS to Postgres: the
 * shared connection type plus one builder per store.  `poolConfig` is a
 * `Record<string, unknown>` on every one of them, so the compiler has nothing
 * to say about its contents and the doc comment is the whole contract.
 */
const POSTGRES_POOL_CONFIG_SITES: ReadonlyArray<readonly [string, string]> = [
  ['src/persistence/journals/PostgresClient.ts', 'readonly poolConfig?:'],
  ['src/persistence/journals/PostgresJournalOptions.ts', 'withPoolConfig('],
  ['src/persistence/snapshot-stores/PostgresSnapshotStoreOptions.ts', 'withPoolConfig('],
  ['src/persistence/durable-state-stores/PostgresDurableStateStoreOptions.ts', 'withPoolConfig('],
];

function sourceFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const relativeToRoot = (absolutePath: string): string =>
  relative(REPOSITORY_ROOT, absolutePath).replaceAll('\\', '/');

const isCommentLine = (line: string): boolean => /^\s*(\*|\/\/|\/\*)/.test(line);

/** The contiguous run of comment lines around `index`, joined. */
function enclosingCommentBlock(lines: ReadonlyArray<string>, index: number): string {
  let first = index;
  while (first > 0 && isCommentLine(lines[first - 1]!)) first--;
  let last = index;
  while (last + 1 < lines.length && isCommentLine(lines[last + 1]!)) last++;
  return lines.slice(first, last + 1).join('\n');
}

/** The comment block immediately above `index` (its JSDoc), or `''`. */
function precedingCommentBlock(lines: ReadonlyArray<string>, index: number): string {
  let first = index;
  while (first > 0 && isCommentLine(lines[first - 1]!)) first--;
  return first === index ? '' : lines.slice(first, index).join('\n');
}

type Occurrence = {
  readonly file: string;
  readonly line: number;
  readonly source: string;
  readonly inComment: boolean;
  readonly block: string;
  /** The value as written, whitespace collapsed — `''` when none was read. */
  readonly value: string;
};

/**
 * Where a binding of the knob starts, in any spelling: the key bare or quoted
 * with `'`, `"` or a backtick (`\x60`, written as an escape so the character
 * class stays readable inside a template), an optional `?` for a TypeScript
 * optional member, an optional `]` for `config['rejectUnauthorized'] = …`, and
 * either `:` or `=` — with `(?!=)` so a `===` comparison, which reads the knob
 * rather than setting it, is not a binding.
 *
 * `\s*` matches newlines, which is the whole point: splitting the pair across
 * two lines is one of the four spellings that walked past the line-by-line
 * substring this replaced.
 *
 * Built fresh on every call because it carries `g` and therefore `lastIndex`.
 */
const bindingPattern = (): RegExp => new RegExp(
  String.raw`(?<![\w$])(['"\x60]?)${VERIFICATION_KNOB}\1\s*\]?\s*\??\s*[:=](?!=)`,
  'g',
);

/**
 * Value shapes that are recognisably safe, as a whitelist rather than a
 * blacklist of falsy spellings.  That direction is the point: `false`, `0`,
 * `null`, `''` and `1 === 2` are an open-ended set and enumerating them is how
 * the first version of this guard was evaded, whereas the shapes a store or
 * transport legitimately writes are a closed and short list.
 *
 * All four in-tree code sites match one of these, and they are right to — a
 * guard that also refused them would be reverted, which is its own way of not
 * guarding.
 */
const SAFE_VALUE_SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ['the literal `true`', /^true$/],
  ['a type annotation, which binds no value', /^boolean(?:\s*\|\s*undefined)?$/],
  [
    "a forward of the caller's own value, optionally defaulting safe",
    new RegExp(
      String.raw`^[A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*!?|\[[^\]]+\])*`
      + String.raw`(?:\?\.|\.)${VERIFICATION_KNOB}!?(?:\s*\?\?\s*true)?$`,
    ),
  ],
];

const isRecognisablySafe = (value: string): boolean =>
  SAFE_VALUE_SHAPES.some(([, shape]) => shape.test(value));

/**
 * The bound value as written, from `start` to the first `,` or `;` — or the
 * first bracket that closes a scope this value did not open — at nesting depth
 * zero.  Whitespace is collapsed, so a value split across lines reads back as
 * one expression.
 */
function valueFrom(text: string, start: number): string {
  let depth = 0;
  let index = start;
  for (; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if ((char === ',' || char === ';') && depth === 0) break;
  }
  return text.slice(start, index).replace(/\s+/g, ' ').trim();
}

/** Zero-based line index containing `offset`. */
const lineIndexAt = (text: string, offset: number): number =>
  text.slice(0, offset).split('\n').length - 1;

/**
 * Every place `text` binds the verification knob to something that is not
 * recognisably safe.  A pure function of the source, so the repo sweep below
 * and the fixtures at the bottom of this file exercise exactly one scanner.
 *
 * The line-by-line search for the exact substring — everything this guard did
 * when it shipped — is kept as a floor at the end, so the scan can only ever
 * see *more* than it used to, never less, whatever the pattern above misses.
 */
function scanForDisabledVerification(file: string, text: string): Occurrence[] {
  const lines = text.split(/\r?\n/);
  const found: Occurrence[] = [];
  const at = (index: number, value: string): Occurrence => ({
    file,
    line: index + 1,
    source: (lines[index] ?? '').trim(),
    // Conservative on purpose, and unchanged: a mention counts as commentary
    // only when its line is *entirely* a comment, so a block comment opened
    // halfway along a code line is reported rather than excused.
    inComment: isCommentLine(lines[index] ?? ''),
    block: enclosingCommentBlock(lines, index),
    value,
  });

  const pattern = bindingPattern();
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const value = valueFrom(text, match.index + match[0].length);
    if (isRecognisablySafe(value)) continue;
    found.push(at(lineIndexAt(text, match.index), value));
  }

  lines.forEach((source, index) => {
    if (!source.includes(DISABLED_VERIFICATION)) return;
    if (found.some((occurrence) => occurrence.line === index + 1)) return;
    found.push(at(index, 'false'));
  });

  return found.sort((first, second) => first.line - second.line);
}

const occurrences: ReadonlyArray<Occurrence> = sourceFiles(SOURCE_ROOT).flatMap(
  (absolutePath) => scanForDisabledVerification(
    relativeToRoot(absolutePath),
    readFileSync(absolutePath, 'utf8'),
  ),
);

const describeOccurrence = (occurrence: Occurrence): string => {
  const value = occurrence.value.length > 60 ? `${occurrence.value.slice(0, 57)}…` : occurrence.value;
  return `  ${occurrence.file}:${occurrence.line}  ${occurrence.source}  [value: ${value}]`;
};

/** Occurrences a fixture puts in executable code — what property 1 refuses. */
const inCodeOf = (fixture: string): ReadonlyArray<Occurrence> =>
  scanForDisabledVerification('fixture.ts', fixture).filter((occurrence) => !occurrence.inComment);

describe('TLS verification guidance in shipped source (#755)', () => {
  test(`no ${VERIFICATION_KNOB} binding in executable code under src/ sets an unsafe value`, () => {
    const inCode = occurrences.filter((occurrence) => !occurrence.inComment);
    expect(
      inCode.length === 0
        ? []
        : [`${VERIFICATION_KNOB} is bound in code to a value that is not recognisably safe `
          + `(one of: ${SAFE_VALUE_SHAPES.map(([description]) => description).join('; ')}):\n`
          + `${inCode.map(describeOccurrence).join('\n')}\n`
          + 'Encryption without verification authenticates nobody. Supply the '
          + `signing CA instead — ${TLS_PAGE}`],
    ).toEqual([]);
  });

  test('only the files this test names may carry such a binding at all', () => {
    const mentioning = [...new Set(occurrences.map((occurrence) => occurrence.file))].sort();
    const allowed = Object.keys(WARNING_SITES).sort();
    const unexpected = mentioning.filter((file) => !allowed.includes(file));
    const stale = allowed.filter((file) => !mentioning.includes(file));
    expect({ unexpected, stale }).toEqual({ unexpected: [], stale: [] });
  });

  test('every mention sits in a comment block that warns', () => {
    const bare = occurrences.filter((occurrence) => {
      const block = occurrence.block.toLowerCase();
      return !WARNING_MARKERS.some((marker) => block.includes(marker.toLowerCase()));
    });
    expect(
      bare.length === 0
        ? []
        : [`${DISABLED_VERIFICATION} is mentioned without a warning around it. `
          + 'The enclosing comment must name the hazard or point at the safe shape '
          + `(one of: ${WARNING_MARKERS.join(', ')}):\n${bare.map(describeOccurrence).join('\n')}`],
    ).toEqual([]);
  });
});

describe('Postgres poolConfig documents the safe TLS shape (#755)', () => {
  test.each(POSTGRES_POOL_CONFIG_SITES)('%s illustrates ssl with a CA and links the TLS page', (file, anchor) => {
    const lines = readFileSync(join(REPOSITORY_ROOT, file), 'utf8').split(/\r?\n/);
    const index = lines.findIndex((line) => line.includes(anchor));
    if (index < 0) throw new Error(`no line containing ${anchor} in ${file}`);

    // Joined without the leading ` * `, so the illustration may wrap.
    const documentation = precedingCommentBlock(lines, index)
      .split('\n')
      .map((line) => line.replace(/^\s*(\/\*\*?|\*\/|\*)\s?/, ''))
      .join(' ');

    expect(documentation).toContain(SAFE_ILLUSTRATION);
    expect(documentation).toContain(TLS_PAGE);
    // The knob is named in prose, never spelled out as a copyable value.
    expect(documentation).not.toContain(DISABLED_VERIFICATION);
  });
});

/**
 * The four spellings an independent verifier put into `buildPgPool` after the
 * guard shipped.  All four reach `new pg.Pool(...)` — measured by mocking the
 * `pg` module and reading the captured config back, which printed
 * `{"rejectUnauthorized":false}` — and the guard as first written saw none of
 * them, because it compared each line against one exact substring.
 *
 * They are fixtures rather than a patch to `src/`, so the scanner is exercised
 * by the suite instead of by a reviewer remembering to try them.  The last two
 * are not the verifier's; they are the obvious next moves, and a whitelist of
 * value shapes closes them for the same reason it closes the first four.
 */
const EVASIVE_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  ['the space removed', 'config.ssl = { rejectUnauthorized:false };'],
  ['the pair split across two lines', 'config.ssl = {\n  rejectUnauthorized:\n    false,\n};'],
  ['the key quoted', "config.ssl = { 'rejectUnauthorized': false };"],
  ['a value that is an expression evaluating to false', 'config.ssl = { rejectUnauthorized: 1 === 2 };'],
  ['another falsy literal', 'config.ssl = { rejectUnauthorized: 0 };'],
  ['a subscript assignment rather than a literal', "config.ssl['rejectUnauthorized'] = false;"],
];

/**
 * The shapes already in `src/` that must keep passing.  A guard that also
 * refused these would be reverted within a week, which is its own way of not
 * guarding: `TcpBackend`, `BunTcpBackend`, `NodeTcpBackend` and `BrokerTls`
 * all name the knob in code, and are right to.
 */
const SAFE_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  ['the explicit safe literal', 'tls = { rejectUnauthorized: true };'],
  ['a type member, which is not a value at all', 'type Tls = { readonly rejectUnauthorized?: boolean };'],
  ["a forward of the caller's own value", 'tls = { rejectUnauthorized: options.tls.rejectUnauthorized };'],
  ['a forward defaulting safe', 'tls = { rejectUnauthorized: options.tls!.rejectUnauthorized ?? true };'],
];

/**
 * The limits the class comment states, as fixtures.  They assert that the
 * scanner does **not** see these, which is an unusual thing to assert and the
 * point of it: the prose above is a promise about coverage, and a promise
 * nothing executes is how a guard comes to overstate itself.  Strengthening
 * the scanner past one of these is welcome — it fails here, and the same
 * commit rewrites the paragraph it belongs to.
 */
const BLIND_SPOTS: ReadonlyArray<readonly [string, string]> = [
  ['a key assembled at runtime', "config.ssl = { ['reject' + 'Unauthorized']: false };"],
  ['a key behind a constant', 'config.ssl = { [KNOB]: false };'],
  ['a different knob with the same effect', 'config.ssl = { checkServerIdentity: () => undefined };'],
  ['the environment', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';"],
];

describe('the disabled-verification scanner catches every spelling of the pair (#755)', () => {
  test.each(EVASIVE_SPELLINGS)('%s', (_name, fixture) => {
    expect(inCodeOf(fixture).map((occurrence) => occurrence.value)).toHaveLength(1);
  });

  test.each(SAFE_SPELLINGS)('%s is not an occurrence', (_name, fixture) => {
    expect(inCodeOf(fixture).map(describeOccurrence)).toEqual([]);
  });

  test.each(BLIND_SPOTS)('%s is NOT caught, and the class comment says so', (_name, fixture) => {
    expect(inCodeOf(fixture).map(describeOccurrence)).toEqual([]);
  });
});
