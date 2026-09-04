import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **Every HOCON key the docs publish is kebab-case.**
 *
 * Nothing looked at a HOCON fence before this.  `scripts/check-doc-samples.mjs`
 * compiles the `ts` fences and skips every other language, and the only pinned
 * HOCON anywhere is `reference-conf.mdx`, whose guard
 * (`tests/unit/config/ReferenceConfDocs.test.ts`) compares it byte-for-byte
 * against `REFERENCE_CONF` — a copy check, not a semantic one.  So while #1405
 * converted the last camelCase leaves, sixteen pages could have kept the old
 * spelling with `bun test` fully green, and the reader who copied one of them
 * into an `application.conf` would have met the startup rejection instead of a
 * working config.
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
 * works.  Anchor on `/^[ \t]*```hocon/`.
 */

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

/**
 * Pages whose fences still publish camelCase keys, and why.
 *
 * Every entry is an `actor-ts.io.broker.*` block, which #1405 deliberately left
 * alone: those blocks ship no `reference.conf` leaves, so none of the config
 * guards can see them, and converting ~55 leaves in the same change would have
 * tripled a diff that shares none of the guard work.  They come out with the
 * follow-up that converts `src/io/`, and this map empties then.
 *
 * The list is checked in **both** directions — an entry that no longer has a
 * violation fails too — so the follow-up cannot land and leave the exemption
 * behind, the same shape `NoDeadConfigKeys`' `KNOWN_DEAD_KEYS` has.
 */
const KNOWN_CAMEL_CASE_PAGES: ReadonlyMap<string, string> = new Map([
  ['io/email-bridge.mdx', 'actor-ts.io.broker.email-bridge — converted with src/io/'],
  ['io/grpc.mdx', 'actor-ts.io.broker.grpc.* — converted with src/io/'],
  ['io/jetstream-kv.mdx', 'actor-ts.io.broker.jetstream-key-value — converted with src/io/'],
  ['io/sse.mdx', 'actor-ts.io.broker.sse — converted with src/io/'],
  ['io/udp.mdx', 'actor-ts.io.broker.udp — converted with src/io/'],
  ['io/websocket.mdx', 'actor-ts.io.broker.websocket — converted with src/io/'],
  ['de/io/email-bridge.mdx', 'German mirror of io/email-bridge.mdx'],
  ['de/io/grpc.mdx', 'German mirror of io/grpc.mdx'],
  ['de/io/jetstream-kv.mdx', 'German mirror of io/jetstream-kv.mdx'],
  ['de/io/sse.mdx', 'German mirror of io/sse.mdx'],
  ['de/io/udp.mdx', 'German mirror of io/udp.mdx'],
  ['de/io/websocket.mdx', 'German mirror of io/websocket.mdx'],
]);

/** The opening fence of a HOCON sample — indented ones included, see above. */
const HOCON_FENCE_OPEN = /^[ \t]*```hocon\s*$/;
/** Any fence delimiter; the first one after an opening fence closes it. */
const FENCE_DELIMITER = /^[ \t]*```/;
/** A leading HOCON comment marker, so a commented-out key is still scanned. */
const COMMENT_MARKER = /^[ \t]*#+[ \t]?/;
/**
 * A name in key position: at the start of the line, or after `{`, `,` or
 * whitespace, and immediately followed by `=`, `:` or `{`.  Dotted paths are
 * one token so `a.b.camelCase = 1` is judged on its last segment.
 */
const KEY_POSITION = /(?:^|[{,\s])([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*(?:=|:|\{)/g;
/** The spelling being retired: a lowercase run followed by a capital. */
const CAMEL_CASE = /^[a-z]+[A-Z]/;

type FenceKeyViolation = {
  readonly page: string;
  readonly line: number;
  readonly key: string;
  readonly text: string;
};

function docsPages(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...docsPages(full));
    else if (entry.name.endsWith('.mdx') || entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** The camelCase keys in `page`'s HOCON fences, with the line each sits on. */
function camelCaseKeysIn(page: string, text: string): FenceKeyViolation[] {
  const out: FenceKeyViolation[] = [];
  let inFence = false;
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!inFence) {
      if (HOCON_FENCE_OPEN.test(line)) inFence = true;
      continue;
    }
    if (FENCE_DELIMITER.test(line)) {
      inFence = false;
      continue;
    }
    const scanned = line.replace(COMMENT_MARKER, '');
    for (const match of scanned.matchAll(KEY_POSITION)) {
      const key = match[1]!;
      const leaf = key.slice(key.lastIndexOf('.') + 1);
      if (CAMEL_CASE.test(leaf)) {
        out.push({ page, line: index + 1, key: leaf, text: line.trim() });
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
});
