import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
 *  1. **No `rejectUnauthorized` binding in executable code under any of
 *     {@link SCAN_ROOTS} sets anything but a recognisably safe value.**
 *     Structural and absolute: an
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
 *  3. **Each occurrence sits in a sentence that warns.**  The sentence carrying
 *     the value has to name the hazard or point at the safe shape, so an entry
 *     on the inventory still cannot be a bare illustration.  The sentence, not
 *     the comment block: this property was per block when it shipped, and a
 *     verifier appended a bare, copyable `{ ssl: { rejectUnauthorized: false } }`
 *     line to the one permitted block with the guard staying green, because the
 *     block already said "instead" forty characters earlier (#1513).  That is
 *     #755's own failure mode re-created inside the allow-list.  Per sentence,
 *     every mention earns its own keep; the cost is that a block warning once
 *     and illustrating twice has to warn twice, which is the right cost.
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
 *     this key, and none of them is checked here.  SQL Server's driver spells
 *     the same decision `trustServerCertificate` and inverts it into
 *     `rejectUnauthorized` itself, so that key written in code is invisible
 *     here too.  Nothing in `src/` writes it — the SQL Server stores hand
 *     `poolConfig` to `new mssql.ConnectionPool(...)` untouched, which is the
 *     seam the positive half below covers — and a scanner for it is the second
 *     design #1416 weighs, deliberately not built.
 *   - **Anything outside {@link SCAN_ROOTS}** — `tests/` (which has to be able
 *     to write the unsafe shape as a fixture, and does, at the bottom of this
 *     file) and the code samples in `docs/`, which are MDX rather than
 *     TypeScript.  `examples/` and `benchmarks/` were outside it too until
 *     this was widened: `examples/` in particular is the copy-paste surface
 *     #755's own verifier went and audited by hand ("examples/ contains
 *     none"), which is a fact about one afternoon rather than an invariant.
 *     Both trees scan clean today, so the widening pins what was already
 *     true rather than changing anything.
 *
 * Those limits are fixtures too, at the bottom of this file, so the paragraph
 * above is executable rather than a claim.
 *
 * Then the positive half, which is what actually binds #755 and #1416: the
 * twelve relational `poolConfig` surfaces — Postgres, MariaDB and SQL Server,
 * the shared connection type plus one builder per store each — must *show* the
 * safe form for their driver and link the TLS page.  Property 1 alone would be
 * satisfied by a JSDoc that says nothing at all, and for SQL Server it is
 * satisfied by construction, because that driver spells the knob differently.
 *
 * Note what the fixed JSDoc deliberately does **not** do: it names the knob in
 * prose ("switching certificate verification off") instead of spelling the
 * value out.  A tooltip has none of the red framing a Starlight
 * `<Aside type="caution">` gives the docs pages, so a warning that quotes the
 * unsafe snippet at the point of decision still hands over the paste — which
 * is the failure mode #755 is about.  That is a documentation judgement, and
 * this file's carve-out exists for the one site where naming the value is
 * unavoidable, not to spare the maintainers of these twelve.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

/**
 * The trees this invariant covers: everything this repository publishes or
 * hands a reader as runnable TypeScript.
 *
 * `src/` alone was the original scope, and it left the two trees a reader is
 * most likely to paste FROM outside it — `examples/` is what the docs point
 * at, and its files are complete programs rather than fragments.  Neither
 * carries an occurrence today, which is what makes adding them a pin rather
 * than a change.
 */
const SCAN_ROOTS: ReadonlyArray<string> = ['src', 'examples', 'benchmarks'];

/**
 * Extensions that can hold an executable binding.  Listed rather than assumed:
 * the walk matched `.ts` exactly, so a `.mts`, `.cts` or `.tsx` file was
 * outside the invariant for no stated reason — and the example frontends are
 * `.tsx`.
 */
const SOURCE_EXTENSIONS: ReadonlyArray<string> = ['.ts', '.mts', '.cts', '.tsx'];

/** Directory names that hold something other than this repository's own source. */
const NOT_OUR_SOURCE: ReadonlySet<string> = new Set(['node_modules', 'dist', 'build', '.next']);

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
 * A mention earns its place by naming the hazard or pointing at the safe
 * shape.  Matched case-insensitively over the **sentence** that carries the
 * value — not the line, which splits a warning from its value wherever the
 * comment happens to wrap, and not the whole comment block, which let a bare
 * copyable line ride on a warning several sentences away (#1513).  A sentence
 * runs from one full stop, question or exclamation mark to the next, and never
 * across the delimiters of a block comment.
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

/**
 * The two things the prose has to *say*, beyond showing the safe shape.
 *
 * The illustration and the link were the only pinned parts, and the nine
 * warning lines around them could be deleted with this file fully green — the
 * comment then still showed a correct `ssl` object and linked the page, and
 * said nothing about why the other shape is wrong.  That is the difference
 * between a snippet and guidance, and this file's own class comment names the
 * prose-not-value phrasing as the fix's third load-bearing detail.
 *
 * Two phrases, not the whole paragraph: the remedy and the consequence.  Each
 * site adds its own third clause naming what the link carries (the journal,
 * the snapshots, the durable state), which is deliberately not pinned — that
 * is the sentence a maintainer should be free to rewrite.
 */
const WARNING_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ['the remedy, as prose rather than as a copyable value', 'supply the signing ca'],
  ['what is lost without it', 'authenticates nobody'],
];

/**
 * One relational backend's `poolConfig` surfaces and what their JSDocs have
 * to show and must not spell.
 */
type RelationalBackend = {
  readonly name: string;
  /** The shape to copy, identical on every surface of the backend; it may wrap. */
  readonly illustration: string;
  /**
   * The copyable unsafe value, in any spelling of the pair — `:` or `=`, any
   * whitespace, either case — so that neither the object form nor the
   * connection-string form of the knob gets written out where a hover shows
   * it.  The prose names the knob; it never hands over the paste.
   */
  readonly unsafeSpelling: RegExp;
  /**
   * `[file, anchor]` per surface.  The anchor is the declaration line whose
   * JSDoc is under test, and it has to match that line *alone*: `withPoolConfig(`
   * matched the class-level usage example first in five of the eight non-Postgres
   * builders, and the block above that line is the class comment, so a table
   * copied from the Postgres rows would have bound the wrong block and passed or
   * failed for the wrong reason (#1416).  The test refuses an ambiguous anchor.
   */
  readonly sites: ReadonlyArray<readonly [string, string]>;
};

/** node-postgres and the `mariadb` connector both take Node's own TLS options, so one shape serves both. */
const NODE_TLS_ILLUSTRATION = "ssl: { rejectUnauthorized: true, ca: fs.readFileSync('rds-ca.pem') }";

/**
 * {@link DISABLED_VERIFICATION} in the spellings prose could hand over as a
 * paste: the key bare, quoted or in a code span, `:` or `=`, the value likewise
 * — `` `rejectUnauthorized` = `false` `` reads as a value to copy just as the
 * bare pair does.
 */
const NODE_TLS_UNSAFE_SPELLING = /rejectUnauthorized['"\x60]?\s*[:=]\s*['"\x60]?false/i;

/**
 * The twelve surfaces a developer reaches for when wiring TLS to a relational
 * journal: per backend the shared connection type plus one builder per store.
 * `poolConfig` is a `Record<string, unknown>` on every one of them, so the
 * compiler has nothing to say about its contents and the doc comment is the
 * whole contract.
 *
 * SQL Server's shape is the odd one out because its driver is: tedious takes
 * the CA through `cryptoCredentialsDetails`, which it hands to
 * `tls.createSecureContext`, and spells the switch that turns verification
 * off `trustServerCertificate` — inverting it into `rejectUnauthorized`
 * itself, which is why a connection string's `TrustServerCertificate=` is the
 * same knob under a third name.  The prose on those four surfaces names that
 * switch without writing its value, exactly as the Postgres prose names
 * "switching certificate verification off" (#1416).
 */
const RELATIONAL_BACKENDS: ReadonlyArray<RelationalBackend> = [
  {
    name: 'Postgres',
    illustration: NODE_TLS_ILLUSTRATION,
    unsafeSpelling: NODE_TLS_UNSAFE_SPELLING,
    sites: [
      ['src/persistence/journals/PostgresClient.ts', 'readonly poolConfig?:'],
      ['src/persistence/journals/PostgresJournalOptions.ts', 'withPoolConfig(poolConfig:'],
      ['src/persistence/snapshot-stores/PostgresSnapshotStoreOptions.ts', 'withPoolConfig(poolConfig:'],
      ['src/persistence/durable-state-stores/PostgresDurableStateStoreOptions.ts', 'withPoolConfig(poolConfig:'],
    ],
  },
  {
    name: 'MariaDB',
    illustration: NODE_TLS_ILLUSTRATION,
    unsafeSpelling: NODE_TLS_UNSAFE_SPELLING,
    sites: [
      ['src/persistence/journals/MariaDbClient.ts', 'readonly poolConfig?:'],
      ['src/persistence/journals/MariaDbJournalOptions.ts', 'withPoolConfig(poolConfig:'],
      ['src/persistence/snapshot-stores/MariaDbSnapshotStoreOptions.ts', 'withPoolConfig(poolConfig:'],
      ['src/persistence/durable-state-stores/MariaDbDurableStateStoreOptions.ts', 'withPoolConfig(poolConfig:'],
    ],
  },
  {
    name: 'SQL Server',
    illustration: "options: { encrypt: true, cryptoCredentialsDetails: { ca: fs.readFileSync('rds-ca.pem') } }",
    unsafeSpelling: /trustServerCertificate['"\x60]?\s*[:=]\s*['"\x60]?true/i,
    sites: [
      ['src/persistence/journals/MsSqlClient.ts', 'readonly poolConfig?:'],
      ['src/persistence/journals/MsSqlJournalOptions.ts', 'withPoolConfig(poolConfig:'],
      ['src/persistence/snapshot-stores/MsSqlSnapshotStoreOptions.ts', 'withPoolConfig(poolConfig:'],
      ['src/persistence/durable-state-stores/MsSqlDurableStateStoreOptions.ts', 'withPoolConfig(poolConfig:'],
    ],
  },
];

/**
 * Where the reasoning lives in full.  Quoted, and checked against the tree
 * below: quoting alone made nothing loud (#1508).  The constant was only ever
 * compared against the JSDocs that carry it, so the page could be renamed with
 * every assertion in this file green and the shipped links pointing at a 404.
 */
const TLS_PAGE = 'https://actor-ts.dev/operations/security/tls-everywhere/';

/**
 * The documentation site's origin.  The page path is *derived* from
 * {@link TLS_PAGE} against it rather than written a second time, so the
 * existence check cannot drift from the link it is checking — and the
 * derivation is asserted non-vacuous, so a rewritten constant cannot satisfy it
 * by pointing nowhere in particular.
 */
const SITE_ORIGIN = 'https://actor-ts.dev/';

/** `operations/security/tls-everywhere` — the page's path relative to either content root. */
const TLS_PAGE_PATH = TLS_PAGE.slice(SITE_ORIGIN.length).replace(/\/$/, '');

/**
 * Both language trees a page has to exist in.  The German mirror is a 1:1
 * structure, so a rename that only moved the English page would leave `/de/`
 * readers on a 404 while the English link still resolved.
 */
const DOCS_CONTENT_ROOTS: ReadonlyArray<string> = ['docs/src/content/docs', 'docs/src/content/docs/de'];

function sourceFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (NOT_OUR_SOURCE.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) out.push(path);
  }
  return out;
}

const relativeToRoot = (absolutePath: string): string =>
  relative(REPOSITORY_ROOT, absolutePath).replaceAll('\\', '/');

const isCommentLine = (line: string): boolean => /^\s*(\*|\/\/|\/\*)/.test(line);

/**
 * A comment line as prose: the continuation prefixes ` * ` and `// ` are
 * stripped, the delimiters `/**`, `/*` and `*\/` are kept so they can serve as
 * sentence boundaries below.
 */
const proseOf = (line: string): string => line.replace(/^\s*(?:\/\/|\*(?!\/))\s?/, '');

/**
 * Where one sentence ends and the next begins: a full stop, question mark or
 * exclamation mark followed by whitespace or the end of the text, and either
 * delimiter of a block comment — so prose never runs across `*\/` into a `//`
 * line that merely follows the block, and a JSDoc with no closing full stop
 * cannot lend its last sentence to one.  `e.g.` splits a sentence in two, which
 * only ever makes the check stricter.
 */
const SENTENCE_BOUNDARY = /[.!?](?=\s|$)|\/\*\*?|\*\//g;

/**
 * The sentence of the comment block around `index` that contains the mention
 * at `column` — the unit property 3 reads (#1513).  The block is the contiguous
 * run of comment lines, joined as prose with a space where each line wrapped,
 * so a sentence split across lines reads as one and a line holding two
 * sentences reads as two.
 */
function enclosingSentence(lines: ReadonlyArray<string>, index: number, column: number): string {
  let first = index;
  while (first > 0 && isCommentLine(lines[first - 1]!)) first--;
  let last = index;
  while (last + 1 < lines.length && isCommentLine(lines[last + 1]!)) last++;
  const prose = lines.slice(first, last + 1).map(proseOf);
  const prefixLength = lines[index]!.length - prose[index - first]!.length;
  let position = Math.max(0, column - prefixLength);
  for (let i = first; i < index; i += 1) position += prose[i - first]!.length + 1;
  const text = prose.join(' ');
  let start = 0;
  let end = text.length;
  for (const boundary of text.matchAll(SENTENCE_BOUNDARY)) {
    const boundaryEnd = boundary.index + boundary[0].length;
    if (boundaryEnd <= position) {
      start = boundaryEnd;
    } else {
      end = boundary.index;
      break;
    }
  }
  return text.slice(start, end).trim();
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
  /** The sentence carrying the mention when it is commentary — `''` in code. */
  readonly sentence: string;
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
 * Every in-tree code site matches one of these, and they are right to — a
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
  // The two shapes a HOCON leaf for the knob adds (#1522).  Both are as
  // narrow as they read: the first is the *name* of a leaf under `actor-ts.`
  // ending in the kebab spelling of the knob — a `ConfigKeys` entry, which
  // binds no value at all — and the second is exactly the reader that
  // forwards what the operator wrote at that leaf, or leaves it unset.
  // Neither admits a literal; a `false` still has to be written by the
  // deployment, in its own file, which is the same line the forward above
  // draws for a value written in code.
  [
    'the name of a HOCON leaf for the knob, which binds no value',
    /^'actor-ts\.[a-z0-9.-]+\.reject-unauthorized'$/,
  ],
  [
    'a forward of the configured value, read by that leaf or left unset',
    /^config\.hasPath\(keys\.rejectUnauthorized\) \? config\.getBoolean\(keys\.rejectUnauthorized\) : undefined$/,
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
  const at = (index: number, column: number, value: string): Occurrence => {
    // Conservative on purpose, and unchanged: a mention counts as commentary
    // only when its line is *entirely* a comment, so a block comment opened
    // halfway along a code line is reported rather than excused.
    const inComment = isCommentLine(lines[index] ?? '');
    return {
      file,
      line: index + 1,
      source: (lines[index] ?? '').trim(),
      inComment,
      sentence: inComment ? enclosingSentence(lines, index, column) : '',
      value,
    };
  };

  const pattern = bindingPattern();
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const value = valueFrom(text, match.index + match[0].length);
    if (isRecognisablySafe(value)) continue;
    const column = match.index - (text.lastIndexOf('\n', match.index - 1) + 1);
    found.push(at(lineIndexAt(text, match.index), column, value));
  }

  lines.forEach((source, index) => {
    const column = source.indexOf(DISABLED_VERIFICATION);
    if (column < 0) return;
    if (found.some((occurrence) => occurrence.line === index + 1)) return;
    found.push(at(index, column, 'false'));
  });

  return found.sort((first, second) => first.line - second.line);
}

const scannedFiles: ReadonlyArray<string> = SCAN_ROOTS.flatMap(
  (root) => sourceFiles(join(REPOSITORY_ROOT, root)),
);

const occurrences: ReadonlyArray<Occurrence> = scannedFiles.flatMap(
  (absolutePath) => scanForDisabledVerification(
    relativeToRoot(absolutePath),
    readFileSync(absolutePath, 'utf8'),
  ),
);

const describeOccurrence = (occurrence: Occurrence): string => {
  const value = occurrence.value.length > 60 ? `${occurrence.value.slice(0, 57)}…` : occurrence.value;
  return `  ${occurrence.file}:${occurrence.line}  ${occurrence.source}  [value: ${value}]`;
};

/** As {@link describeOccurrence}, plus the sentence property 3 judged. */
const describeMention = (occurrence: Occurrence): string =>
  `${describeOccurrence(occurrence)}\n    sentence: "${occurrence.sentence}"`;

/**
 * Whether a sentence names the hazard or points at the safe shape.  Code spans
 * are removed first: a marker has to be prose, so a key named `instead` inside
 * the copyable value itself does not make the value a warning.
 */
const sentenceWarns = (sentence: string): boolean => {
  const prose = sentence.replace(/`[^`]*`/g, '').toLowerCase();
  return WARNING_MARKERS.some((marker) => prose.includes(marker.toLowerCase()));
};

/** Occurrences a fixture puts in executable code — what property 1 refuses. */
const inCodeOf = (fixture: string): ReadonlyArray<Occurrence> =>
  scanForDisabledVerification('fixture.ts', fixture).filter((occurrence) => !occurrence.inComment);

/** Line numbers of the mentions a fixture puts in commentary without a warning in their sentence — what property 3 refuses. */
const bareMentionsIn = (fixture: string): ReadonlyArray<number> =>
  scanForDisabledVerification('fixture.ts', fixture)
    .filter((occurrence) => occurrence.inComment && !sentenceWarns(occurrence.sentence))
    .map((occurrence) => occurrence.line);

describe('TLS verification guidance in shipped source (#755)', () => {
  test('the scanner reads every tree it claims to', () => {
    // Guards the guard: the invariant below is an emptiness assertion, so a
    // walk that silently stopped reaching a root — a renamed directory, an
    // extension list that no longer matches anything there — satisfies it by
    // reading nothing.  Per root, because that is the failure this widening
    // introduces: `src/` alone would still look healthy.
    for (const root of SCAN_ROOTS) {
      const underRoot = scannedFiles.filter(
        (path) => relativeToRoot(path).startsWith(`${root}/`),
      );
      expect(underRoot.length, `no source files found under ${root}/`).toBeGreaterThan(10);
    }
    // And the extension list is not decoration: the example frontends are the
    // `.tsx` half of the tree, and they were outside the walk entirely.
    expect(
      scannedFiles.filter((path) => path.endsWith('.tsx')).length,
      'no .tsx file was scanned, so widening the extension list changed nothing',
    ).toBeGreaterThan(0);
  });

  test(`no ${VERIFICATION_KNOB} binding in executable code sets an unsafe value`, () => {
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

  test('every mention sits in a sentence that warns', () => {
    const bare = occurrences.filter((occurrence) => !sentenceWarns(occurrence.sentence));
    expect(
      bare.length === 0
        ? []
        : [`${DISABLED_VERIFICATION} is mentioned in a sentence that does not warn. `
          + 'The sentence carrying the value must name the hazard or point at the safe shape '
          + `(one of: ${WARNING_MARKERS.join(', ')}); a warning elsewhere in the same comment `
          + `block does not count:\n${bare.map(describeMention).join('\n')}`],
    ).toEqual([]);
  });
});

describe('relational poolConfig documents the safe TLS shape (#755, #1416)', () => {
  for (const backend of RELATIONAL_BACKENDS) {
    for (const [file, anchor] of backend.sites) {
      test(`${file} illustrates ${backend.name} TLS with a CA and links the TLS page`, () => {
        const lines = readFileSync(join(REPOSITORY_ROOT, file), 'utf8').split(/\r?\n/);
        const matches = lines.flatMap((line, index) => (line.includes(anchor) ? [index] : []));
        // Exactly one, so the block read below is the declaration's own JSDoc
        // and not whichever earlier comment happened to quote the method.
        expect(matches, `${JSON.stringify(anchor)} must match exactly one line of ${file}`).toHaveLength(1);

        // Joined without the leading ` * `, so the illustration may wrap.
        const documentation = precedingCommentBlock(lines, matches[0]!)
          .split('\n')
          .map((line) => line.replace(/^\s*(\/\*\*?|\*\/|\*)\s?/, ''))
          .join(' ');

        expect(documentation).toContain(backend.illustration);
        expect(documentation).toContain(TLS_PAGE);
        // The knob is named in prose, never spelled out as a copyable value.
        expect(documentation).not.toMatch(backend.unsafeSpelling);
        // And the prose says the two things that make it guidance rather than a
        // snippet: what to do instead, and what is lost by not doing it.
        const lowercase = documentation.toLowerCase();
        for (const [what, phrase] of WARNING_PHRASES) {
          expect(lowercase, `${file} no longer states ${what}`).toContain(phrase);
        }
      });
    }
  }
});

describe('the page the guidance links to exists (#1508)', () => {
  test('the link is on the documentation site, so a page path can be derived from it', () => {
    // Guards the guard: the existence check below derives its path from the
    // constant, and a constant rewritten to some other host, or to the site
    // root, would give it nothing to check rather than something false.
    expect(TLS_PAGE.startsWith(SITE_ORIGIN), `${TLS_PAGE} is not under ${SITE_ORIGIN}`).toBe(true);
    expect(TLS_PAGE_PATH, 'the link names no page').not.toBe('');
  });

  for (const root of DOCS_CONTENT_ROOTS) {
    test(`${root} carries it`, () => {
      const page = join(REPOSITORY_ROOT, root, `${TLS_PAGE_PATH}.mdx`);
      expect(
        existsSync(page),
        `${TLS_PAGE} is linked from the poolConfig JSDocs but no page exists at ${relativeToRoot(page)}`,
      ).toBe(true);
    });
  }
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
  ['the name of a HOCON leaf', "tls: { rejectUnauthorized: 'actor-ts.http.server.tls.reject-unauthorized' },"],
  [
    'a forward of the configured value',
    'tls = { rejectUnauthorized: config.hasPath(keys.rejectUnauthorized) ? config.getBoolean(keys.rejectUnauthorized) : undefined };',
  ],
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
  ["SQL Server's spelling of the same decision", 'config.options = { trustServerCertificate: true };'],
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

/**
 * The one block the inventory permits, condensed to the sentence that earns
 * it: `DenoTcpBackend.denoConnectTlsOptions` names the value because on Deno
 * setting it does nothing, and the same sentence says so and points at `ca`.
 * A fixture rather than a read of the file, so the shape property 3 accepts is
 * pinned here whatever that comment is later reworded to.
 */
const PERMITTED_BLOCK: ReadonlyArray<string> = [
  '  /**',
  '   * `rejectUnauthorized` has no Deno equivalent and is deliberately not mapped:',
  '   * Deno always validates the chain.  Setting `rejectUnauthorized: false` to reach a',
  '   * self-signed peer therefore does nothing on Deno — supply the signing CA in',
  '   * `ca` instead, which is the shape the docs already recommend.',
  '   */',
];

/** {@link PERMITTED_BLOCK} with `line` spliced in before the closing delimiter. */
const permittedBlockPlus = (line: string): string =>
  [...PERMITTED_BLOCK.slice(0, -1), line, ...PERMITTED_BLOCK.slice(-1)].join('\n');

/**
 * Property 3 as fixtures — which mentions it reports, by line, and which it
 * lets stand.  The second entry is the verifier's mutation from #1513 exactly:
 * a bare, copyable line appended to the permitted block, which the per-block
 * check accepted because the block already warned.  The original mention on
 * line 3 has to stay accepted at the same time, or the repair would merely
 * have moved the failure.
 */
const MENTION_FIXTURES: ReadonlyArray<readonly [string, string, ReadonlyArray<number>]> = [
  ['the permitted block, whose own sentence names the hazard', PERMITTED_BLOCK.join('\n'), []],
  [
    "the verifier's mutation: a copyable line appended to that block",
    permittedBlockPlus('   * e.g. `{ ssl: { rejectUnauthorized: false } }`'),
    [6],
  ],
  [
    'the same line in a block of its own',
    ['  /**', '   * e.g. `{ ssl: { rejectUnauthorized: false } }`', '   */'].join('\n'),
    [2],
  ],
  [
    'a warning in the sentence before the value, on the same line',
    '  // Supply the signing CA instead.  Otherwise `{ rejectUnauthorized: false }` also works.',
    [1],
  ],
  [
    'a warning in the sentence after the value',
    '  // `{ rejectUnauthorized: false }` works.  It leaves the peer unverified.',
    [1],
  ],
  [
    'the pair split across two comment lines, warned in its own sentence',
    ['  // A `{ rejectUnauthorized:', '  //   false }` does nothing on Deno.'].join('\n'),
    [],
  ],
  ['the permitted block with CRLF line endings', PERMITTED_BLOCK.join('\r\n'), []],
  [
    'a `//` line after a JSDoc that has no closing full stop',
    ['  /**', '   * Supply the signing CA instead', '   */', '  // `{ rejectUnauthorized: false }`'].join('\n'),
    [4],
  ],
  ['a marker smuggled into the code span itself', '  // `{ rejectUnauthorized: false, instead: 1 }`', [1]],
  // What the property cannot tell apart, stated as a fixture so the limit is
  // executable: a marker *word* in the value's sentence satisfies it, whatever
  // the sentence means.  That is the phrase heuristic the class comment calls
  // the weaker check, and it is why the inventory exists in front of it.
  ['a marker word written into the same sentence — NOT reported', '  // e.g. `{ rejectUnauthorized: false }` instead', []],
];

describe('every mention earns its own keep (#1513)', () => {
  test.each(MENTION_FIXTURES)('%s', (_name, fixture, expectedBareLines) => {
    expect(bareMentionsIn(fixture)).toEqual([...expectedBareLines]);
  });

  test('the permitted block is an occurrence at all, so the fixtures above judge something', () => {
    // Guards the guard: an empty report is also what a scanner that saw no
    // mention would produce.
    const mentions = scanForDisabledVerification('fixture.ts', PERMITTED_BLOCK.join('\n'));
    expect(mentions.map((occurrence) => [occurrence.line, occurrence.inComment])).toEqual([[3, true]]);
  });
});
