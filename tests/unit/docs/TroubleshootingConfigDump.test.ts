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
 * - its sample is lines the dump prints, in the dump's order, for the fixture
 *   below — and it shows every layer and each of the three rules that withhold
 *   a value: by key name, by the secrets file, and by field name inside a
 *   list.
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
 */
const APPLICATION_CONF = [
  'actor-ts.diagnostics.log-config-on-start = on',
  'my-app {',
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
 * The run of code spans that reads "`a`, `b` or `c`" and names `member`.
 *
 * Exactly one, so a second list naming the same thing — a stale one left
 * beside the corrected one — fails rather than letting either pass.
 */
function listNaming(prose: string, member: string): string[] {
  const lists = [...prose.matchAll(/`[^`]+`(?:,\s*`[^`]+`)*,?\s+(?:or|oder)\s+`[^`]+`/g)]
    .map((match) => [...match[0].matchAll(/`([^`]+)`/g)].map((span) => span[1]!))
    .filter((spans) => spans.includes(member));
  expect(lists, `one list of code spans naming \`${member}\``).toHaveLength(1);
  return lists[0]!;
}

/** The first `text` fence of the section, line by line. */
function sampleOf(section: string[]): string[] {
  const open = section.findIndex((line) => /^```text\s*$/.test(line));
  expect(open, 'the section has a text fence').toBeGreaterThan(-1);
  const close = section.findIndex((line, index) => index > open && line.startsWith('```'));
  return section.slice(open + 1, close).map((line) => line.trimEnd()).filter((line) => line !== '');
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
 * True when no word of a dotted path is one the pattern accepts — stricter
 * than the dump's own reading, which looks only at the head word of each
 * segment, so a path that passes here names no credential by any reading.
 */
const namesNoCredential = (path: string): boolean =>
  path.split(/[^A-Za-z0-9]+/).every((word) => !CONFIG_SECRET_PATTERN.test(word));

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

    test(`its sample is lines the dump prints, in order (${language})`, () => {
      const positions = sampleOf(sectionOf(page, heading)).map((line) => {
        const position = dumpBody.findIndex((printed) => printed.trimEnd() === line);
        expect(position, `the dump does not print: ${line}`).toBeGreaterThan(-1);
        return position;
      });
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
    });

    test(`its sample shows every layer and each rule that withholds a value (${language})`, () => {
      const sample = sampleOf(sectionOf(page, heading));
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
      // By field name inside a list: the list prints, its credential field does not.
      expect(sample.some((line) => / = \[.*"<redacted>".*\] {2}\[/.test(line))).toBe(true);
    });
  }
});
