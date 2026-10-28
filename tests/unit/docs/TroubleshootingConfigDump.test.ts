import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { configDumpLines } from '../../../src/diagnostics/ConfigDump.js';
import { CONFIG_SECRET_PATTERN } from '../../../src/util/Constants.js';

/**
 * The troubleshooting page describes the config dump the code prints (found
 * while #1546).
 *
 * "Making the framework talk" is where an operator is sent to turn the boot
 * dump on, and it is the page that tells them what that record withholds
 * before they paste it into a ticket.  When the dump learned five layer names
 * and two new ways to withhold a value, the page went on saying three names
 * and "by key name only" — nothing tied the paragraph to the renderer, so the
 * one statement a reader acts on with a password at stake was the one that had
 * stopped being true, and every suite stayed green.
 *
 * So the page is held to the code rather than to a paraphrase of it, in both
 * languages:
 *
 * - the layer names it lists are the names the dump prints for a load that
 *   fills every layer `Config.load` merges;
 * - the words it lists are the words `CONFIG_SECRET_PATTERN` accepts;
 * - **every** code fence in the section is bound, not only the first: an
 *   excerpt (a `text` fence) is lines the dump prints, in the dump's order, for
 *   the fixture below, and a `hocon` fence parses and names only keys
 *   `reference.conf` ships.  A fence of any other kind fails, and so does a
 *   `<pre>` or `<Code>` block, so a second excerpt has nowhere to sit unbound
 *   — one that contradicted the rules used to pass beside the bound one;
 * - together the excerpts show every layer and each of the three rules that
 *   withhold a value: by key name — from a word that is not the last of the
 *   name too — by the secrets file, and by field name inside a list.
 *
 * What this cannot see is the prose around those spans: a sentence asserting
 * the opposite of a rule keeps every check here green.  Nor can it see a layer
 * the fixture does not fill — a seventh layer would need a line here first.
 */

const DOCUMENTATION_ROOT = join(
  import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs',
);

/** The section on each page, found by its heading — the pages are mirrors. */
const PAGES = [
  {
    language: 'en',
    page: join(DOCUMENTATION_ROOT, 'operations', 'troubleshooting.mdx'),
    heading: '## Making the framework talk',
  },
  {
    language: 'de',
    page: join(DOCUMENTATION_ROOT, 'de', 'operations', 'troubleshooting.mdx'),
    heading: '## Das Framework zum Reden bringen',
  },
] as const;

/**
 * A key in every layer, so the dump has a line under each name: the
 * application file's root and its `production` profile, the secrets file's
 * root and its `production` profile, and the code's overrides above them all
 * — which replace a key the secrets file set, the case where withholding by
 * the winning layer would print it.  `reference.conf` is there on its own.
 * `auth-header` is withheld by a word of its name that is not the last one.
 */
const APPLICATION_CONF = [
  'actor-ts.diagnostics.log-config-on-start = on',
  'my-app {',
  '  auth-header = "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig"',
  '  db.host = "localhost"',
  '  payments.api-key = "pk_live_123"',
  '  upstreams = [ { host = "db-1", password = "hunter2" } ]',
  '}',
  'profiles.production.my-app.db.host = "db.internal"',
].join('\n');

const SECRETS_CONF = [
  'my-app.db.user = "app"',
  'profiles.production.my-app.db.password = "s3cr3t"',
].join('\n');

/**
 * Unset until `beforeAll` has made it, and unset means `undefined`, never
 * `''`: bun runs `afterAll` after a `beforeAll` that threw, and bun 1.4.2's
 * `rmSync('', { recursive: true, force: true })` empties the working
 * directory — the repository root, under `bun test` — where Node's removes
 * nothing (measured on Windows).  `undefined` is refused outright.
 */
let directory: string | undefined;
let dumpBody: string[] = [];

beforeAll(() => {
  const created = mkdtempSync(join(tmpdir(), 'troubleshooting-config-dump-'));
  directory = created;
  writeFileSync(join(created, 'application.conf'), APPLICATION_CONF);
  writeFileSync(join(created, 'secrets.conf'), SECRETS_CONF);
  const config = Config.load({
    appConfPath: join(created, 'application.conf'),
    secretsConfPath: join(created, 'secrets.conf'),
    profile: 'production',
    overrides: Config.parseString('my-app.db.user = "migrator"'),
  });
  // The header carries machine-specific paths and counts that move with
  // every key `reference.conf` gains, so the page describes it in prose and
  // only the body is compared.
  dumpBody = configDumpLines(config).split('\n').slice(1);
});

afterAll(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
});

/** The origin column of one dump line — `[secrets]` or `[profile, overrides a lower layer]` — as its layer name. */
const layerOf = (line: string): string => {
  const origin = /\[([a-z]+)(?:, overrides a lower layer)?\]$/.exec(line);
  expect(origin, `no origin column in: ${line}`).not.toBeNull();
  return origin![1]!;
};

/** The lines of the `## ` section headed exactly `heading`. */
function sectionOf(page: string, heading: string): string[] {
  const lines = readFileSync(page, 'utf8').split(/\r?\n/);
  const start = lines.indexOf(heading);
  expect(start, `${heading} is missing from ${page}`).toBeGreaterThan(-1);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, next === -1 ? undefined : next);
}

/**
 * The section's prose as one line: fences dropped, and MDX comments too,
 * because a list inside either renders as nothing a reader sees.
 */
function proseOf(section: string[]): string {
  const prose: string[] = [];
  let inFence = false;
  for (const line of section) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) prose.push(line);
  }
  return prose.join(' ').replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\s+/g, ' ');
}

/**
 * The run of code spans that reads as a list and names `member`.
 *
 * Exactly one, so a second list naming the same thing — a stale one left
 * beside the corrected one — fails rather than letting either pass.  A list is
 * read the way `ConfigSecretWordLists.test.ts` reads one: spans joined by
 * commas, by any conjunction, by both, by slashes, as table cells or as list
 * items — a stale list written with `and` used to pass beside one written
 * with `or`.
 */
function listNaming(prose: string, member: string): string[] {
  const lists = [...prose.matchAll(CODE_SPAN_LIST)]
    .map((match) => [...match[0].matchAll(/`([^`]+)`/g)].map((span) => span[1]!))
    .filter((spans) => spans.includes(member));
  expect(lists, `one list of code spans naming \`${member}\``).toHaveLength(1);
  return lists[0]!;
}

/** A run of code spans joined the ways {@link listNaming} reads as a list. */
const CODE_SPAN_LIST = new RegExp(
  '`[^`]+`(?:(?:'
    + String.raw`\s*,\s*(?:(?:or|and|nor|plus|oder|und|sowie)\s+)?`
    + String.raw`|\s+(?:or|and|nor|plus|oder|und|sowie)\s+`
    + String.raw`|\s*[/|]\s*`
    + String.raw`|\s+(?:[-*+]|\d+[.)])\s+`
    + ')`[^`]+`)+',
  'g',
);

/** One code fence of a section: the word its info string starts with, and its lines. */
type Fence = {
  readonly language: string;
  readonly lines: readonly string[];
};

/**
 * Every code fence of the section, in order — backticks or tildes, three or
 * more, at any indentation and behind a blockquote's `>`, the way a fence
 * still renders as a code block inside a list item or a quote.
 *
 * Generous on purpose: a fence this reads that does not render is a false
 * alarm, while one it misses is an excerpt nothing binds.  A fence runs to a
 * closing run of the same character at least as long, or to the end of the
 * section.  Lines come back trimmed, empty ones dropped.
 */
function fencesOf(section: readonly string[]): Fence[] {
  const fences: Fence[] = [];
  let open: { readonly marker: string; readonly language: string; readonly lines: string[] } | null = null;
  for (const line of section) {
    const content = line.replace(/^[\s>]*/, '');
    if (open !== null) {
      const close = /^(`{3,}|~{3,})\s*$/.exec(content);
      if (close !== null && close[1]![0] === open.marker[0] && close[1]!.length >= open.marker.length) {
        fences.push({ language: open.language, lines: open.lines });
        open = null;
      } else if (line.trim() !== '') {
        open.lines.push(content.trim());
      }
      continue;
    }
    const opening = /^(`{3,}|~{3,})(.*)$/.exec(content);
    if (opening === null) continue;
    // A backtick run with a backtick in its info string is inline code, not a fence.
    if (opening[1]![0] === '`' && opening[2]!.includes('`')) continue;
    open = { marker: opening[1]!, language: opening[2]!.trim().split(/\s+/)[0]!, lines: [] };
  }
  if (open !== null) fences.push({ language: open.language, lines: open.lines });
  return fences;
}

/** The section's `text` fences — the excerpts of the dump — each line by line. */
const excerptsOf = (section: readonly string[]): (readonly string[])[] =>
  fencesOf(section).filter((fence) => fence.language === 'text').map((fence) => fence.lines);

/** The kinds of fence this file binds; any other in the section is a failure. */
const BOUND_FENCE_LANGUAGES: ReadonlySet<string> = new Set(['hocon', 'text']);

/** Every leaf path of a parsed tree, as dotted keys. */
function leafPathsOf(tree: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? leafPathsOf(value as Record<string, unknown>, path)
      : [path];
  });
}

/**
 * Every word `CONFIG_SECRET_PATTERN` accepts, in the singular.
 *
 * The pattern is a finite alternation of literals, so each word it accepts is
 * a concatenation of letter runs in its source — `pass` + `wd`, `secret` +
 * `s` — and trying every concatenation of up to three runs lists them without
 * parsing the expression; the longest today, `pass` + `word` + `s`, takes
 * three.  A plural is dropped when its singular is accepted as well.
 */
function wordsThePatternAccepts(): string[] {
  const runs = [...new Set(CONFIG_SECRET_PATTERN.source.match(/[a-z]+/gi) ?? [])];
  const candidates = new Set<string>();
  for (const first of runs) {
    for (const second of ['', ...runs]) {
      for (const third of ['', ...runs]) candidates.add((first + second + third).toLowerCase());
    }
  }
  const accepted = [...candidates].filter((word) => CONFIG_SECRET_PATTERN.test(word));
  return accepted
    .filter((word) => !(word.endsWith('s') && accepted.includes(word.slice(0, -1))))
    .sort();
}

/** The dotted path a dump line prints. */
const pathOf = (line: string): string => line.trim().split(' ')[0]!;

/**
 * True when no word of a dotted path is one the pattern accepts — the dump's
 * own reading, which takes every word of every segment (#867), short of its
 * camelCase split: the page's sample is kebab-case, so a path that passes
 * here names no credential.
 */
const namesNoCredential = (path: string): boolean =>
  path.split(/[^A-Za-z0-9]+/).every((word) => !CONFIG_SECRET_PATTERN.test(word));

/** The last word of a dotted path — `header` of `my-app.auth-header`. */
const lastWordOf = (path: string): string => {
  const words = path.split(/[^A-Za-z0-9]+/).filter((word) => word !== '');
  return words[words.length - 1] ?? '';
};

describe('the troubleshooting page describes the config dump the code prints — #1546', () => {
  test('the fixture fills every layer the dump can name', () => {
    expect([...new Set(dumpBody.map(layerOf))].sort())
      .toEqual(['application', 'override', 'profile', 'reference', 'secrets']);
  });

  for (const { language, page, heading } of PAGES) {
    test(`it lists the layer names the dump prints (${language})`, () => {
      const listed = listNaming(proseOf(sectionOf(page, heading)), 'reference');
      expect([...listed].sort()).toEqual([...new Set(dumpBody.map(layerOf))].sort());
    });

    test(`it lists the words a key name is withheld by (${language})`, () => {
      const listed = listNaming(proseOf(sectionOf(page, heading)), 'password');
      expect([...listed].sort()).toEqual(wordsThePatternAccepts());
    });

    test(`every code block in it is a fence this file binds (${language})`, () => {
      const section = sectionOf(page, heading);
      const fences = fencesOf(section);
      // Vacuity guard: the switches and the excerpt are there to be bound.
      expect(fences.map((fence) => fence.language)).toEqual(expect.arrayContaining(['hocon', 'text']));
      for (const fence of fences) {
        expect(BOUND_FENCE_LANGUAGES.has(fence.language), `a fence this file does not bind: \`\`\`${fence.language}`)
          .toBe(true);
      }
      // Markup that renders as a code block without being a fence.
      expect(proseOf(section)).not.toMatch(/<pre\b|<Code\b/i);
    });

    test(`every excerpt in it is lines the dump prints, in order (${language})`, () => {
      const excerpts = excerptsOf(sectionOf(page, heading));
      expect(excerpts.length).toBeGreaterThan(0);
      for (const excerpt of excerpts) {
        expect(excerpt.length).toBeGreaterThan(0);
        const positions = excerpt.map((line) => {
          const position = dumpBody.findIndex((printed) => printed.trim() === line);
          expect(position, `the dump does not print: ${line}`).toBeGreaterThan(-1);
          return position;
        });
        expect(positions).toEqual([...positions].sort((left, right) => left - right));
      }
    });

    test(`every hocon fence in it names only keys reference.conf ships (${language})`, () => {
      const reference = Config.loadReference();
      const hocon = fencesOf(sectionOf(page, heading)).filter((fence) => fence.language === 'hocon');
      for (const fence of hocon) {
        const keys = leafPathsOf(Config.parseString(fence.lines.join('\n')).toJSON());
        expect(keys.length).toBeGreaterThan(0);
        for (const key of keys) expect(reference.hasPath(key), `not a shipped key: ${key}`).toBe(true);
      }
    });

    test(`its excerpts show every layer and each rule that withholds a value (${language})`, () => {
      const sample = excerptsOf(sectionOf(page, heading)).flat();
      expect([...new Set(sample.map(layerOf))].sort()).toEqual([...new Set(dumpBody.map(layerOf))].sort());
      const withheld = sample.filter((line) => / = <redacted> {2}\[/.test(line));
      // By the secrets file: a key whose name says nothing about a credential,
      // withheld although a layer above the file won it — the one case a rule
      // keyed on the winning layer would print.
      expect(withheld.some((line) => layerOf(line) !== 'secrets' && namesNoCredential(pathOf(line))))
        .toBe(true);
      // By key name: a credential-named key from a layer other than the secrets file.
      expect(withheld.some((line) => layerOf(line) !== 'secrets' && !namesNoCredential(pathOf(line))))
        .toBe(true);
      // By key name, from a word that is not the last one of the name — the
      // line a rule reading only the last word would print in full.
      expect(withheld.some((line) => layerOf(line) !== 'secrets'
        && !namesNoCredential(pathOf(line)) && namesNoCredential(lastWordOf(pathOf(line)))))
        .toBe(true);
      // By field name inside a list: the list prints, its credential field does not.
      expect(sample.some((line) => / = \[.*"<redacted>".*\] {2}\[/.test(line))).toBe(true);
    });
  }
});
