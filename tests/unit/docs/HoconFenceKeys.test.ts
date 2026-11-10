import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **Every HOCON key the docs publish is kebab-case.**
 *
 * Nothing looked at a HOCON fence before this.  `scripts/check-doc-samples.mjs`
 * compiles the `ts` fences and skips every other language, and the only pinned
 * HOCON anywhere is `reference-conf.mdx`, whose guard
 * (`tests/unit/config/ReferenceConfDocs.test.ts`) compares it byte-for-byte
 * against `REFERENCE_CONF` — a copy check, not a semantic one.  So while #1405
 * converted the camelCase leaves — the last of them, under
 * `actor-ts.io.broker.*`, went with #1443 — sixteen pages could have kept the
 * old spelling with `bun test` fully green, and the reader who copied one of
 * them into an `application.conf` would have met the rejection of a retired
 * spelling instead of a working config.
 *
 * ## What counts as a key
 *
 * Only tokens in **key position** — a name immediately followed by `=`, `:` or
 * `{`.  A fence is mostly comments, and those comments legitimately name
 * TypeScript methods and options (`whenTerminated()`, `stableObservation`,
 * `hardwareConcurrency`); flagging every camelCase *word* would make the guard
 * unusable in the file it most needs to cover.
 *
 * A leading `#` is stripped first, so a commented-out key is still a key.  That
 * is not pedantry: `reference.conf` documents `max-connections` and
 * `prefix-quotas` **only** as comments, both are genuinely read, and both are
 * republished verbatim onto two pages by the byte pin — a worked example the
 * code would now reject is exactly the thing that ships unnoticed.
 *
 * ## Why the fence has to be found with a leading-whitespace anchor
 *
 * The three `http/middleware/*` pages put their HOCON inside indented blocks.
 * A scan anchored at column 0 reports those pages clean — eight lines per
 * language — while correctly finding every other page, so it looks like it
 * works.  Anchor after leading whitespace, as {@link HOCON_FENCE_OPEN} does —
 * and after a blockquote's `>` markers, for the same reason.
 */

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

/**
 * TypeDoc's API reference, which the docs build writes into the content tree.
 * It is generated from the JSDoc in `src/`, never written by hand, and it is
 * gitignored, so it exists after a local build and in none of the CI jobs that
 * run this suite.  Walking it made the suite's case set depend on whether
 * somebody had built the site — about 350 more cases after a build, every one
 * vacuous, since no generated page carries a HOCON fence.  Only the top level
 * is skipped, because that is where the build writes it; a hand-written `api`
 * directory further down is still checked.  `FrontmatterParses` and
 * `NoBraceLedLines` skip it the same way.
 */
const GENERATED_DIRECTORY = 'api';

/**
 * Pages whose fences may still publish a camelCase key, each with the issue
 * that converts it.
 *
 * **Empty, and meant to stay so.**  It held the six `actor-ts.io.broker.*`
 * pages, and their German mirrors, that #1405 left for #1443, which converted
 * them together with the readers: every HOCON key the docs publish is
 * kebab-case now.  An entry exempts a whole page rather than one key — while
 * the io pages were listed, a camelCase key put back into any of their fences
 * stayed green — so a page converted in part is not to be listed again to
 * cover the rest of it.
 *
 * The list is still checked in **both** directions — an entry that no longer
 * has a violation fails — and every reason has to name an issue, so an entry
 * added later says which change owes the conversion instead of reading as a
 * permanent exception.  Both checks are the shape `NoDeadConfigKeys`'
 * `KNOWN_DEAD_KEYS` has, and both keep holding while the map is empty.
 */
const KNOWN_CAMEL_CASE_PAGES: ReadonlyMap<string, string> = new Map<string, string>();

/**
 * The opening fence of a HOCON sample, in every form a Markdown page can open
 * one: indented, see above; inside a blockquote, once {@link BLOCKQUOTE} is off
 * the line; with backticks or tildes, three or more; with the language in any
 * case; and carrying a title or other meta after the language.  Each of these
 * was a way past this guard while it matched only ```` ```hocon ```` (#1405).
 */
const HOCON_FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})[ \t]*hocon(?:[ \t].*)?$/i;
/** A line that can close a fence: a bare run of backticks or tildes. */
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
/** The markers of a blockquote, nested ones included, in front of a line. */
const BLOCKQUOTE = /^[ \t]*(?:>[ \t]?)+/;
/** A leading HOCON comment marker, either spelling, so a commented-out key is still scanned. */
const COMMENT_MARKER = /^[ \t]*(?:#+|\/\/+)[ \t]?/;
/** One segment of a key path: a bare name, or a quoted one — a quoted segment may hold dots. */
const KEY_SEGMENT = String.raw`(?:"[^"\n]*"|[A-Za-z_][A-Za-z0-9_-]*)`;
/**
 * A key path in key position: at the start of the line, or after `{`, `,` or
 * whitespace, and followed by `=`, `+=`, `:` or `{`.  The whole dotted path is
 * one token and every word of it is judged, so neither a camelCase block in
 * the middle of a path nor a quoted segment is a way past.
 */
const KEY_POSITION = new RegExp(String.raw`(?:^|[{,\s])(${KEY_SEGMENT}(?:\.${KEY_SEGMENT})*)[ \t]*(?:\+?=|:|\{)`, 'g');
/**
 * A quoted string that is a value — one no key separator follows — blanked
 * before the scan, so `mode = "fooBar = 1"` publishes no key.
 */
const VALUE_STRING = /"[^"\n]*"(?![ \t]*(?:\+?=|:|\{|\.))/g;
/**
 * The spelling being retired: a word that begins in lowercase and turns
 * uppercase — `maxConnections`, `http2Enabled`, the tail of `max-lineLen`.  A
 * word is what stands between non-alphanumerics, so the hyphen and the dot
 * start a new one.  A PascalCase word is not matched: comment prose puts type
 * names in key position (`its ActorSystem: local refs`), six times on the
 * reference-conf page alone.
 */
const CAMEL_CASE_WORD = /(?:^|[^A-Za-z0-9])([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)/g;

type FenceKeyViolation = {
  readonly page: string;
  readonly line: number;
  readonly key: string;
  readonly text: string;
};

/** Every `.md`/`.mdx` page under `directory`, the generated API reference left out. */
function docsPages(directory: string, topLevel = true): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (topLevel && entry.name === GENERATED_DIRECTORY) continue;
      out.push(...docsPages(full, false));
    } else if (entry.name.endsWith('.mdx') || entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * The camelCase keys in `page`'s HOCON fences, with the line each sits on.
 *
 * A fence closes on a bare run of its own character at least as long as the
 * one it opened with, as Markdown closes it — so a ```` ``` ```` line inside a
 * ```` ```` ```` or `~~~` fence is a line of the sample, not its end.
 */
function camelCaseKeysIn(page: string, text: string): FenceKeyViolation[] {
  const out: FenceKeyViolation[] = [];
  let opener: string | null = null;
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const unquoted = line.replace(BLOCKQUOTE, '');
    if (opener === null) {
      opener = HOCON_FENCE_OPEN.exec(unquoted)?.[1] ?? null;
      continue;
    }
    const close = FENCE_CLOSE.exec(unquoted);
    if (close !== null && close[1]![0] === opener[0] && close[1]!.length >= opener.length) {
      opener = null;
      continue;
    }
    const scanned = unquoted.replace(COMMENT_MARKER, '').replace(VALUE_STRING, '""');
    for (const match of scanned.matchAll(KEY_POSITION)) {
      const path = match[1]!.replace(/"/g, ' ');
      for (const word of path.matchAll(CAMEL_CASE_WORD)) {
        out.push({ page, line: index + 1, key: word[1]!, text: line.trim() });
      }
    }
  }
  return out;
}

const pages = docsPages(DOCS_ROOT).map((file) => ({
  page: relative(DOCS_ROOT, file).split(sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

const violationsByPage = new Map<string, FenceKeyViolation[]>();
for (const { page, text } of pages) {
  const found = camelCaseKeysIn(page, text);
  if (found.length > 0) violationsByPage.set(page, found);
}

describe('HOCON samples in the docs use kebab-case keys', () => {
  test('the scan actually reaches the fences it is meant to check', () => {
    // Guards the guard: a regex change that matched nothing would make every
    // assertion below vacuously pass, which is how this class of test rots.
    const referenceConf = pages.find((p) => p.page === 'reference/reference-conf.mdx');
    expect(referenceConf, 'reference/reference-conf.mdx is missing').toBeDefined();

    const withCamelKeys = camelCaseKeysIn(
      'probe',
      ['```hocon', 'actor-ts.http.client {', '  maxResponseBytes = 8M', '  # cleanupMs = 60000', '}', '```'].join('\n'),
    );
    expect(withCamelKeys.map((v) => v.key)).toEqual(['maxResponseBytes', 'cleanupMs']);

    // Prose inside a comment is not a key, however camelCase it reads.
    const proseOnly = camelCaseKeysIn(
      'probe',
      ['```hocon', '# Override per actor with ActorOptions.withThroughput().', 'max-entries = 1', '```'].join('\n'),
    );
    expect(proseOnly).toEqual([]);
  });

  test.each<[string, readonly string[], readonly string[]]>([
    ['a quoted key', ['```hocon', '"maxConnections" = 10', '```'], ['maxConnections']],
    ['a quoted segment of a dotted path', ['```hocon', 'actor-ts.io.broker.tcp.framing."maxLineLen" = 64K', '```'], ['maxLineLen']],
    ['a quoted key that holds the dots', ['```hocon', '"actor-ts.http.client.maxResponseBytes" = 8M', '```'], ['maxResponseBytes']],
    ['an append', ['```hocon', 'actor-ts.cluster.seedNodes += "tcp://10.0.0.1:2552"', '```'], ['seedNodes']],
    ['a numeral before the capital', ['```hocon', 'actor-ts.http.server.http2Enabled = true', '```'], ['http2Enabled']],
    ['a camelCase tail after a hyphen', ['```hocon', 'max-lineLen = 1', '```'], ['lineLen']],
    ['a camelCase block in the middle of a path', ['```hocon', 'actor-ts.io.brokerOptions.tcp.port = 1', '```'], ['brokerOptions']],
    ['a tilde fence', ['~~~hocon', 'maxConnections = 10', '~~~'], ['maxConnections']],
    ['a four-backtick fence', ['````hocon', 'maxConnections = 10', '````'], ['maxConnections']],
    ['a four-backtick fence around a three-backtick line', ['````hocon', '```', 'maxConnections = 10', '````'], ['maxConnections']],
    ['a tilde fence around a backtick line', ['~~~hocon', '```', 'maxConnections = 10', '~~~'], ['maxConnections']],
    ['an uppercase language', ['```HOCON', 'maxConnections = 10', '```'], ['maxConnections']],
    ['a fence in a blockquote', ['> ```hocon', '> maxConnections = 10', '> ```'], ['maxConnections']],
    ['a fence in a nested blockquote', ['> > ~~~hocon title="application.conf"', '> > # cleanupMs = 60000', '> > ~~~'], ['cleanupMs']],
  ])('%s is scanned like any other', (_form, lines, keys) => {
    // No page writes any of these today — which is why each needs a case of
    // its own: a scan that missed one would stay green over the whole tree.
    expect(camelCaseKeysIn('probe', lines.join('\n')).map((v) => v.key)).toEqual([...keys]);
  });

  test('a value, however it is spelt, is not a key', () => {
    const sample = (line: string): string[] => camelCaseKeysIn('probe', ['```hocon', line, '```'].join('\n')).map((v) => v.key);
    expect(sample('mode = "fooBar"')).toEqual([]);
    expect(sample('statement = "SELECT * FROM events WHERE pageSize = 10"')).toEqual([]);
    expect(sample('names = ["fooBar", "bazQux"]')).toEqual([]);
    expect(sample('label = "retries: maxAttempts: 3"')).toEqual([]);
    // Type names in comment prose sit in key position too, and are not keys.
    expect(sample('# Honoured by every ref that can reach its ActorSystem: local refs')).toEqual([]);
    // Text after the fence is prose again.
    expect(camelCaseKeysIn('probe', ['~~~hocon', 'max-entries = 1', '~~~', 'maxEntries: the option field'].join('\n'))).toEqual([]);
  });

  test('a fence carrying a title or other meta after the language is still scanned', () => {
    // Starlight's code blocks take meta after the language, and an opening
    // pattern anchored right after `hocon` treated every such fence as some
    // other language — a camelCase key inside one stayed green.  BrokerFenceKeys
    // reads them; this guard has to as well, or a title is a way past it.
    const sample = (opening: string): string[] => camelCaseKeysIn(
      'probe',
      [opening, 'actor-ts.io.broker.tcp-server {', '  maxConnections = 10', '}', '```'].join('\n'),
    ).map((v) => v.key);
    expect(sample('```hocon title="application.conf"')).toEqual(['maxConnections']);
    expect(sample('```hocon\ttitle="application.conf"')).toEqual(['maxConnections']);
    expect(sample('  ```hocon {2} title="application.conf"')).toEqual(['maxConnections']);
    expect(sample('```hocon   ')).toEqual(['maxConnections']);
    // A different language that merely starts with the same letters is not HOCON.
    expect(sample('```hoconish')).toEqual([]);
    expect(sample('```json title="hocon"')).toEqual([]);
  });

  test('the walk leaves out the generated API reference, and only that', () => {
    // A fixture root rather than a page dropped into the real tree: the
    // generated directory is absent from every clone, so a check against
    // DOCS_ROOT would pass vacuously in exactly the runs that gate a merge.
    const root = mkdtempSync(join(tmpdir(), 'hocon-fence-keys-'));
    try {
      for (const page of [
        'guide.mdx',
        'de/guide.mdx',
        'reference/api/handwritten.mdx',
        'api/index.md',
        'api/classes/ActorSystem.md',
      ]) {
        mkdirSync(dirname(join(root, page)), { recursive: true });
        writeFileSync(join(root, page), '# page\n');
      }

      const walked = docsPages(root).map((file) => relative(root, file).split(sep).join('/')).sort();
      expect(walked).toEqual(['de/guide.mdx', 'guide.mdx', 'reference/api/handwritten.mdx']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([...pages])('$page publishes no camelCase HOCON key', ({ page }) => {
    if (KNOWN_CAMEL_CASE_PAGES.has(page)) return;
    const found = violationsByPage.get(page) ?? [];

    expect(
      found.map((v) => `${v.page}:${v.line} ${v.key} — ${v.text}`),
      `${page} publishes a camelCase HOCON key.  Every leaf is the kebab-case of `
      + 'its options field with any unit suffix dropped (#1405), and the retired '
      + 'spellings are rejected at startup — so a sample that keeps one is a '
      + 'sample that no longer loads.',
    ).toEqual([]);
  });

  test.each([...KNOWN_CAMEL_CASE_PAGES.keys()])('%s is still exempt for a reason', (page) => {
    expect(
      violationsByPage.has(page),
      `${page} has no camelCase HOCON key left — drop its KNOWN_CAMEL_CASE_PAGES entry `
      + 'in the same commit, so the exemption cannot outlive what it exempts.',
    ).toBe(true);
  });

  test('every KNOWN_CAMEL_CASE_PAGES entry names the issue that converts it', () => {
    // Otherwise an exemption reads as settled rather than owed, and nothing
    // says which change is meant to take it out.
    for (const [page, reason] of KNOWN_CAMEL_CASE_PAGES) {
      expect(reason, `${page} needs an issue reference, not just a note`).toMatch(/#\d+/);
    }
  });
});
