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
 *  1. **`rejectUnauthorized: false` never appears in executable code under
 *     `src/`.**  Structural and absolute: an occurrence in a comment can only
 *     mislead a reader, one in code turns verification off for real.  A line
 *     counts as a comment only when it *starts* with `*`, `//` or `/*`, which
 *     is deliberately conservative — `foo({ rejectUnauthorized: false })` can
 *     never be misread as prose, and a block comment opened halfway along a
 *     code line is reported rather than excused.
 *  2. **Only the files this inventory names may mention it at all.**  A phrase
 *     heuristic would be the obvious alternative and is the weaker one: a
 *     heuristic is satisfied by writing the phrase, whereas an inventory entry
 *     is a visible edit in the diff that adds the occurrence, next to a written
 *     reason.  Same shape as the coverage-gate ratchet — it may be edited, on
 *     purpose, and never by accident.
 *  3. **Each occurrence sits in a comment block that warns.**  The block has to
 *     name the hazard or point at the safe shape, so an entry on the inventory
 *     still cannot be a bare illustration.
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

/** The anti-pattern, spelled exactly as `tls-everywhere.mdx` spells it. */
const DISABLED_VERIFICATION = 'rejectUnauthorized: false';

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
};

const occurrences: ReadonlyArray<Occurrence> = sourceFiles(SOURCE_ROOT).flatMap((absolutePath) => {
  const file = relativeToRoot(absolutePath);
  const lines = readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  return lines.flatMap((source, index) => (
    source.includes(DISABLED_VERIFICATION)
      ? [{
        file,
        line: index + 1,
        source: source.trim(),
        inComment: isCommentLine(source),
        block: enclosingCommentBlock(lines, index),
      }]
      : []
  ));
});

const describeOccurrence = (occurrence: Occurrence): string =>
  `  ${occurrence.file}:${occurrence.line}  ${occurrence.source}`;

describe('TLS verification guidance in shipped source (#755)', () => {
  test(`"${DISABLED_VERIFICATION}" never appears in executable code under src/`, () => {
    const inCode = occurrences.filter((occurrence) => !occurrence.inComment);
    expect(
      inCode.length === 0
        ? []
        : [`${DISABLED_VERIFICATION} is set in code, not merely mentioned:\n`
          + `${inCode.map(describeOccurrence).join('\n')}\n`
          + 'Encryption without verification authenticates nobody. Supply the '
          + `signing CA instead — ${TLS_PAGE}`],
    ).toEqual([]);
  });

  test('only the files this test names may mention it at all', () => {
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
