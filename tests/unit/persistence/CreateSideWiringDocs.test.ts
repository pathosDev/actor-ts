import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * The persistence pages wire a backend where the system is created (#1473).
 *
 * Since the plug-ins moved to the create side, a system that selects a backend
 * resolves the selected stores inside `ActorSystem.create` and opens them as
 * part of its startup.  A `register*Plugins` call made on
 * `system.extension(PersistenceExtensionId)` after `create` comes too late for
 * a selected store — the startup fails with `Unknown journal plugin` — so a
 * snippet that still registers there is not an older style, it is a sample
 * that, copied, fails the startup it was meant to configure.  And a sentence
 * saying a store connects "on first use" now states the exception, the
 * boot-time open turned off, as if it were the rule.
 *
 * Four things are pinned, in both languages:
 *
 *   - every call of the ten register helpers in a fence sits inside the
 *     `plugins` array of a `withPersistence(...)` call and is handed that
 *     plug-in's own parameter, the extension the system passes in;
 *   - a fence that wires persistence is byte-identical on the English page and
 *     its German mirror — the code is shared, only the prose is translated;
 *   - a prose sentence that says a store opens on first use, lazily or on
 *     demand also says that this holds when the boot-time open is turned off,
 *     or links the overview section that says so;
 *   - the persistence overview shows the `plugins` route once, under its
 *     pluggable-backends heading, and its startup section points there.
 *
 * This is a scanner over text, not a TypeScript parse — the compiler the
 * project pins exposes no parser API to a test.  It reads the fence as
 * written, comments included, because a reader copies the comments too, and
 * it skips string literals and comments only while matching brackets.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const DOCS_ROOT = join(REPOSITORY_ROOT, 'docs', 'src', 'content', 'docs');

type Language = 'english' | 'german';

const LANGUAGES: readonly Language[] = ['english', 'german'];

/** The ten helpers a backend registers through. */
const HELPERS: readonly string[] = [
  'registerCassandraPlugins',
  'registerD1Plugins',
  'registerDynamoDbPlugins',
  'registerLibSqlPlugins',
  'registerMariaDbPlugins',
  'registerMongoPlugins',
  'registerMsSqlPlugins',
  'registerPostgresPlugins',
  'registerSqlitePlugins',
  'registerObjectStoragePlugins',
];

/** The pages that wire a backend, relative to the docs root; the German mirror is the same path under `de/`. */
const PAGES: readonly string[] = [
  'persistence/overview.mdx',
  'persistence/journals/cloudflare-d1.mdx',
  'persistence/journals/libsql.mdx',
  'persistence/journals/mariadb.mdx',
  'persistence/journals/mssql.mdx',
  'persistence/journals/postgres.mdx',
  'persistence/journals/wire-compatible.mdx',
];

/**
 * The configuration reference is one page for every subsystem, so only its
 * persistence section is read.  Its table rows are left out as well: a row
 * documents one leaf's default, and its wording moves with that leaf's other
 * descriptions, not with the prose this guard holds.
 */
const SCOPED_PAGES: Readonly<Record<string, { readonly heading: string }>> = {
  'reference/configuration.mdx': { heading: '### `actor-ts.persistence`' },
};

/**
 * A sentence that has a store open late — on first use, lazily, on demand.
 * The German half carries no `\b` beside an umlaut: without the `u` flag `Ö`
 * is not a word character, so `\bÖ` after a space never matches.
 */
const OPENS_LATE: Readonly<Record<Language, RegExp>> = {
  english: /\bfirst use\b|\bfirst used\b|\blaz(?:y|ily)\b|\bon demand\b|\bfirst persistence operation\b/i,
  german: /\bbei der ersten (?:Verwendung|Nutzung)\b|\bbeim ersten Zugriff\b|\bzum ersten Mal genutzt\b|\berste[n]? (?:Benutzung|Nutzung|Verwendung) des Stores\b|\bbei Bedarf\b|\blazy\b/i,
};

/**
 * What such a sentence has to say as well — why this store opens late.  Either
 * the boot-time open is turned off ("the boot-time open is turned off", "turn
 * the boot-time open off in code", "wenn das Öffnen beim Start abgeschaltet
 * ist", "schalte das Öffnen beim Start im Code ab"), or the store is not a
 * selected one — the boot-time open covers the selected stores, so one wired
 * by hand through a helper's returned handle does open on first use — or the
 * sentence links the overview section that says it.
 */
const LATE_OPEN_EXPLAINED: Readonly<Record<Language, RegExp>> = {
  english: /\bboot-time open (?:[\w-]+ ){0,3}off\b|\bnot a selected (?:one|store)\b|\(\/persistence\/overview\/#opening-the-stores-at-startup\)|\(#opening-the-stores-at-startup\)/,
  german: /Öffnen beim Start (?:[\wäöüÄÖÜß-]+ ){0,3}(?:abgeschaltet|ab)\b|\babgeschaltete[mn]? Öffnen beim Start\b|\bkein ausgewählter\b|\(\/de\/persistence\/overview\/#stores-beim-start-öffnen\)|\(#stores-beim-start-öffnen\)/,
};

/** A fence that wires persistence: a helper call or a `withPersistence(...)`. */
const WIRING = new RegExp(`\\b(?:${HELPERS.join('|')})\\b|\\bwithPersistence\\s*\\(`);

function pageFile(language: Language, page: string): string {
  return language === 'german' ? join(DOCS_ROOT, 'de', page) : join(DOCS_ROOT, page);
}

/**
 * Read a page with its line endings normalised.  Not cosmetic: the repository
 * checks out with `core.autocrlf=true` on Windows, and every anchor below
 * would otherwise have to be spelled `\r?\n` or silently match nothing.
 */
function read(language: Language, page: string): string {
  return readFileSync(pageFile(language, page), 'utf8').replace(/\r\n/g, '\n');
}

type Fence = {
  /** 1-based line of the opening marker. */
  readonly line: number;
  /** The fence as written, opening and closing marker lines included. */
  readonly text: string;
  /** The lines between the markers. */
  readonly code: string;
};

/** Every fenced block, indented ones inside an `<Aside>` included. */
function fencesOf(page: string): Fence[] {
  const lines = page.split('\n');
  const fences: Fence[] = [];
  let opener: { readonly marker: string; readonly line: number } | null = null;
  let block: string[] = [];
  for (const [index, line] of lines.entries()) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (opener === null) {
      if (marker) {
        opener = { marker: marker[1]!, line: index + 1 };
        block = [line];
      }
      continue;
    }
    block.push(line);
    const closes = marker !== null
      && marker[1]![0] === opener.marker[0]
      && marker[1]!.length >= opener.marker.length
      && marker[2]!.trim() === '';
    if (closes) {
      fences.push({ line: opener.line, text: block.join('\n'), code: block.slice(1, -1).join('\n') });
      opener = null;
    }
  }
  return fences;
}

/** Index of the last character of the string literal opening at `start`, or -1. */
function endOfString(code: string, start: number): number {
  const quote = code[start];
  for (let index = start + 1; index < code.length; index++) {
    if (code[index] === '\\') { index++; continue; }
    if (code[index] === quote) return index;
    if (quote !== '`' && code[index] === '\n') return index;
  }
  return -1;
}

/**
 * Index of the bracket closing the one at `open`, or -1 when it never closes.
 * String literals and comments are skipped, so a `(` in a `// …` line or a
 * `'('` cannot unbalance the count.
 */
function closingBracket(code: string, open: number): number {
  const closers: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
  const expected: string[] = [];
  for (let index = open; index < code.length; index++) {
    const character = code[index]!;
    if (character === '/' && code[index + 1] === '/') {
      const lineEnd = code.indexOf('\n', index);
      if (lineEnd < 0) return -1;
      index = lineEnd;
      continue;
    }
    if (character === '/' && code[index + 1] === '*') {
      const commentEnd = code.indexOf('*/', index + 2);
      if (commentEnd < 0) return -1;
      index = commentEnd + 1;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      const stringEnd = endOfString(code, index);
      if (stringEnd < 0) return -1;
      index = stringEnd;
      continue;
    }
    const closer = closers[character];
    if (closer !== undefined) {
      expected.push(closer);
    } else if (character === ')' || character === ']' || character === '}') {
      if (expected.pop() !== character) return -1;
      if (expected.length === 0) return index;
    }
  }
  return -1;
}

/** The text of the first argument of the call whose `(` is at `open`. */
function firstArgument(code: string, open: number): string {
  const close = closingBracket(code, open);
  if (close < 0) return '';
  let depth = 0;
  for (let index = open + 1; index < close; index++) {
    const character = code[index]!;
    if (character === '(' || character === '[' || character === '{') depth++;
    else if (character === ')' || character === ']' || character === '}') depth--;
    else if (character === ',' && depth === 0) return code.slice(open + 1, index).trim();
  }
  return code.slice(open + 1, close).trim();
}

type Span = { readonly start: number; readonly end: number };

/** The `[...]` of every `plugins:` inside the argument list of a `withPersistence(...)`. */
function pluginArrays(code: string): Span[] {
  const spans: Span[] = [];
  for (const call of code.matchAll(/\bwithPersistence\s*\(/g)) {
    const open = call.index! + call[0].length - 1;
    const close = closingBracket(code, open);
    if (close < 0) continue;
    const argumentsText = code.slice(open, close);
    for (const slot of argumentsText.matchAll(/\bplugins\s*:\s*\[/g)) {
      const arrayOpen = open + slot.index! + slot[0].length - 1;
      const arrayClose = closingBracket(code, arrayOpen);
      if (arrayClose > 0) spans.push({ start: arrayOpen, end: arrayClose });
    }
  }
  return spans;
}

/** Every `import … from '…'` statement, so a helper named in one is not taken for a use. */
function importStatements(code: string): Span[] {
  return [...code.matchAll(/^\s*import\s[\s\S]*?\sfrom\s*['"][^'"\n]+['"];?/gm)]
    .map((statement) => ({ start: statement.index!, end: statement.index! + statement[0].length }));
}

/** The helpers' names as the fence spells them — an import alias (`registerPostgresPlugins as register`) included. */
function helperNames(code: string): Map<string, string> {
  const names = new Map(HELPERS.map((helper): [string, string] => [helper, helper]));
  for (const alias of code.matchAll(/\b(register\w+Plugins)\s+as\s+([A-Za-z_$][\w$]*)/g)) {
    if (HELPERS.includes(alias[1]!)) names.set(alias[2]!, alias[1]!);
  }
  return names;
}

/** The parameter of the last arrow function that starts between `from` and `before`. */
function nearestArrowParameter(code: string, from: number, before: number): string | null {
  const heads = [...code.slice(from, before).matchAll(/(?:\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)|\b([A-Za-z_$][\w$]*))\s*=>/g)];
  const last = heads.at(-1);
  return last === undefined ? null : (last[1] ?? last[2] ?? null);
}

const inside = (spans: readonly Span[], at: number): boolean => spans.some((span) => at > span.start && at < span.end);

/**
 * Where a fence names a register helper anywhere but in an import or as a call
 * a `plugins` callback makes with its own parameter.  Comments are read too: a
 * `// registerPostgresPlugins(ext)` in a sample is an instruction its reader
 * follows.
 */
function misplacedHelpers(fence: Fence): string[] {
  const { code } = fence;
  const names = helperNames(code);
  const imports = importStatements(code);
  const plugins = pluginArrays(code);
  const problems: string[] = [];
  // A preceding `.` is not excluded: `persistence.registerPostgresPlugins(...)`
  // through a namespace import is the same call, and has to sit in the same place.
  const pattern = new RegExp(`(?<![\\w$])(${[...names.keys()].join('|')})(?![\\w$])`, 'g');
  for (const use of code.matchAll(pattern)) {
    const at = use.index!;
    if (inside(imports, at)) continue;
    const line = fence.line + code.slice(0, at).split('\n').length;
    const helper = names.get(use[1]!)!;
    const call = /^\s*\(/.exec(code.slice(at + use[1]!.length));
    if (call === null) {
      problems.push(`line ${line}: ${helper} is referenced without being called`);
      continue;
    }
    const span = plugins.find((candidate) => at > candidate.start && at < candidate.end);
    if (span === undefined) {
      problems.push(`line ${line}: ${helper}(...) is not inside the plugins array of a withPersistence(...) call`);
      continue;
    }
    const parameter = nearestArrowParameter(code, span.start, at);
    const argument = firstArgument(code, at + use[1]!.length + call[0].length - 1);
    if (parameter === null || argument !== parameter) {
      problems.push(`line ${line}: ${helper}(${argument}, ...) is not handed the plug-in's own parameter (${parameter ?? 'none'})`);
    }
  }
  return problems;
}

/**
 * What a reader sees: frontmatter, fences, MDX and HTML comments and MDX
 * `import` lines removed, a scoped page cut to its section and its table rows
 * dropped.
 */
function proseOf(page: string, text: string): string {
  let lines = text.split('\n');
  const scope = SCOPED_PAGES[page];
  if (scope !== undefined) {
    const start = lines.indexOf(scope.heading);
    if (start < 0) throw new Error(`${page}: the "${scope.heading}" heading is gone — re-point this guard.`);
    const level = scope.heading.slice(0, scope.heading.indexOf(' '));
    const end = lines.findIndex((line, index) => index > start && line.startsWith(`${level} `));
    lines = lines.slice(start, end < 0 ? lines.length : end).filter((line) => !line.trimStart().startsWith('|'));
  }
  const kept: string[] = [];
  let fence: string | null = null;
  let frontmatter = lines[0] === '---';
  for (const [index, line] of lines.entries()) {
    if (frontmatter) {
      if (index > 0 && line === '---') frontmatter = false;
      kept.push('');
      continue;
    }
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === null && marker) {
      fence = marker[1]!;
      kept.push('');
      continue;
    }
    if (fence !== null) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && marker[2]!.trim() === '') fence = null;
      kept.push('');
      continue;
    }
    kept.push(/^import\s.*\sfrom\s['"]/.test(line) ? '' : line);
  }
  return kept.join('\n').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/<!--[\s\S]*?-->/g, '');
}

/** The prose as sentences, each paragraph's line breaks folded into spaces. */
function sentencesOf(prose: string): string[] {
  return prose
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph !== '')
    .flatMap((paragraph) => paragraph.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ`*[(<])/));
}

function sentencesOpeningLate(language: Language, page: string): string[] {
  return sentencesOf(proseOf(page, read(language, page)))
    .filter((sentence) => OPENS_LATE[language].test(sentence) && !LATE_OPEN_EXPLAINED[language].test(sentence));
}

/** The lines of a page from `heading` up to the next heading of its level. */
function sectionOf(text: string, heading: string): { readonly from: number; readonly to: number } {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`the "${heading}" heading is gone — re-point this guard.`);
  const level = heading.slice(0, heading.indexOf(' '));
  const end = lines.findIndex((line, index) => index > start && line.startsWith(`${level} `));
  return { from: start + 1, to: end < 0 ? lines.length : end };
}

describe('the persistence pages register a backend through the plugins slot (#1473)', () => {
  for (const page of PAGES) {
    for (const language of LANGUAGES) {
      test(`${language} ${page}: every register helper call is a plug-in handed its own parameter`, () => {
        const problems = fencesOf(read(language, page)).flatMap((fence) => misplacedHelpers(fence));
        expect(problems, `${pageFile(language, page)} registers a backend outside the plugins slot`).toEqual([]);
      });
    }

    test(`${page}: a fence that wires persistence is byte-identical in English and German`, () => {
      const english = fencesOf(read('english', page));
      const german = fencesOf(read('german', page));
      expect(german.length, `${page}: the mirrors hold different numbers of fences, so they cannot be paired`)
        .toBe(english.length);
      const differing = english
        .map((fence, index) => ({ english: fence, german: german[index]! }))
        .filter((pair) => WIRING.test(pair.english.text) || WIRING.test(pair.german.text))
        .filter((pair) => pair.english.text !== pair.german.text)
        .map((pair) => `English :${pair.english.line} / German :${pair.german.line}`);
      expect(differing, `${page}: a wiring sample differs between the languages`).toEqual([]);
    });
  }
});

describe('a store that opens late says it is the boot-time open turned off (#1473)', () => {
  for (const page of PAGES) {
    for (const language of LANGUAGES) {
      test(`${language} ${page}`, () => {
        expect(
          sentencesOpeningLate(language, page),
          `${pageFile(language, page)}: a sentence has a store open on first use without saying that is the `
          + 'boot-time open turned off — the selected stores open at startup.',
        ).toEqual([]);
      });
    }
  }
});

const OVERVIEW = 'persistence/overview.mdx';

const OVERVIEW_HEADINGS: Readonly<Record<Language, { readonly backends: string; readonly startup: string; readonly backendsAnchor: string }>> = {
  english: {
    backends: '## Pluggable backends',
    startup: '## Opening the stores at startup',
    backendsAnchor: '](#pluggable-backends)',
  },
  german: {
    backends: '## Austauschbare Backends',
    startup: '## Stores beim Start öffnen',
    backendsAnchor: '](#austauschbare-backends)',
  },
};

describe('the persistence overview shows the plugins route once (#1473)', () => {
  for (const language of LANGUAGES) {
    const headings = OVERVIEW_HEADINGS[language];

    test(`${language}: one fence wires a plug-in, and it stands under "${headings.backends}"`, () => {
      const text = read(language, OVERVIEW);
      const routes = fencesOf(text).filter((fence) => /\bwithPersistence\s*\(/.test(fence.code) && /\bplugins\s*:/.test(fence.code));
      expect(routes.map((fence) => fence.line), `${pageFile(language, OVERVIEW)} shows the plugins route more or less than once`)
        .toHaveLength(1);
      const backends = sectionOf(text, headings.backends);
      expect(routes[0]!.line, `${pageFile(language, OVERVIEW)}: the plugins route is not under "${headings.backends}"`)
        .toBeGreaterThan(backends.from);
      expect(routes[0]!.line).toBeLessThan(backends.to);
    });

    test(`${language}: "${headings.startup}" points to the route rather than repeating it`, () => {
      const text = read(language, OVERVIEW);
      const startup = sectionOf(text, headings.startup);
      const section = text.split('\n').slice(startup.from, startup.to).join('\n');
      expect(section).toContain(headings.backendsAnchor);
    });
  }
});
