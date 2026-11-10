import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
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
 * Five things are pinned, in both languages:
 *
 *   - every call of the ten register helpers in a fence sits inside the
 *     `plugins` array of a `withPersistence(...)` call and is handed that
 *     plug-in's own parameter, the extension the system passes in, with its
 *     options, if any, built into a local beforehand, and the object-storage
 *     helper's promise handed on to the slot; a helper a fence imports is
 *     wired there too — and no
 *     fence sets a store on the extension with `setJournal` and its siblings,
 *     which can only happen after `create` and so misses the startup too;
 *   - the call runs while its plug-in does — before the plug-in's first
 *     `await` and not in a function the plug-in defers — and a failure of it
 *     is left to the startup rather than caught in the plug-in, and the
 *     options holding the `plugins` reach `ActorSystem.create`;
 *   - a fence that wires persistence has the same code on the English page and
 *     its German mirror — the code is shared; the prose around it, and the
 *     comments in it, may be translated;
 *   - a prose sentence that says a store opens on first use, lazily or on
 *     demand also says that this holds when the boot-time open is turned off,
 *     or links the overview section that says so — and so does an
 *     `auto-create-*` row of the configuration reference, the one kind of row
 *     that states when a store opens;
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

/** The helpers that return a promise the startup has to wait for. */
const ASYNC_HELPERS: readonly string[] = ['registerObjectStoragePlugins'];

/** The pages that wire a backend, relative to the docs root; the German mirror is the same path under `de/`. */
const PAGES: readonly string[] = [
  'persistence/overview.mdx',
  'persistence/durable-state.mdx',
  'persistence/journals/cassandra.mdx',
  'persistence/journals/cloudflare-d1.mdx',
  'persistence/journals/dynamodb.mdx',
  'persistence/journals/libsql.mdx',
  'persistence/journals/mariadb.mdx',
  'persistence/journals/mongodb.mdx',
  'persistence/journals/mssql.mdx',
  'persistence/journals/postgres.mdx',
  'persistence/journals/sqlite.mdx',
  'persistence/journals/wire-compatible.mdx',
  'persistence/object-storage/overview.mdx',
  'persistence/object-storage/encryption.mdx',
  'persistence/object-storage/snapshot-store-backend.mdx',
  'operations/upgrades/rolling-migration.md',
  'reference/configuration.mdx',
];

/**
 * Pages that are in {@link PAGES} for their prose alone: their fences register
 * nothing, but a sentence there says when a store opens.
 */
const PROSE_ONLY_PAGES: ReadonlyMap<string, string> = new Map([
  ['persistence/journals/wire-compatible.mdx', 'its prose names registerPostgresPlugins; its fences wire nothing'],
]);

/**
 * Pages whose fences name a register helper and that this guard leaves to
 * another one, with the reason.
 */
const CENSUS_EXEMPT_PAGES: ReadonlyMap<string, string> = new Map([
  ['reference/reference-conf.mdx', 'its one fence mirrors src/config/Reference.ts byte for byte, which ReferenceConfDocs holds; the helpers it names sit in HOCON comments'],
]);

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
  english: /\bfirst[ -]use\b|\bfirst used\b|\blaz(?:y|ily)\b|\bon demand\b|\bfirst persistence operation\b/i,
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

/**
 * A backstop against the opposite claim.  The explanation above is a phrase,
 * and a phrase cannot tell "on first use when the boot-time open is turned
 * off" from "on first use, even when the boot-time open is turned off"; the
 * spellings that invert it are refused outright.
 */
const OPENS_LATE_REGARDLESS: Readonly<Record<Language, RegExp>> = {
  english: /\b(?:even when|even if|even with|regardless of whether|whether or not)\b.{0,40}\bboot-time open\b/i,
  german: /\b(?:auch wenn|selbst wenn|auch mit|unabhängig davon, ob|egal, ob)\b.{0,40}Öffnen beim Start/i,
};

/** A fence that wires persistence: a helper call or a `withPersistence(...)`. */
const WIRING = new RegExp(`\\b(?:${HELPERS.join('|')})\\b|\\bwithPersistence\\s*\\(`);

/** A fence that registers a backend: it names a helper, or fills a `plugins` slot. */
function registersABackend(fence: Fence): boolean {
  return new RegExp(`\\b(?:${HELPERS.join('|')})\\b`).test(fence.code)
    || (/\bwithPersistence\s*\(/.test(fence.code) && /\bplugins\s*:/.test(fence.code));
}

/**
 * Every page under `root` — the docs root — whose fences register a backend in
 * either language, as its English path.  The generated `api/` tree at the top
 * is skipped, as everywhere else.
 */
function pagesRegisteringABackend(root: string, directory = root, out = new Set<string>()): Set<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!(directory === root && entry.name === 'api')) pagesRegisteringABackend(root, path, out);
    } else if (/\.mdx?$/.test(entry.name)) {
      const page = relative(root, path).split(sep).join('/');
      const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      if (fencesOf(text).some(registersABackend)) out.add(page.replace(/^de\//, ''));
    }
  }
  return out;
}

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

/** The markers of a blockquote, nested ones included, in front of a line. */
const BLOCKQUOTE = /^[ \t]*(?:>[ \t]?)+/;

/**
 * Every fenced block, indented ones inside an `<Aside>` included, and ones in
 * a blockquote — read without the quote's markers, so a sample quoted on a
 * page is held to the same rules.
 */
function fencesOf(page: string): Fence[] {
  const lines = page.split('\n');
  const fences: Fence[] = [];
  let opener: { readonly marker: string; readonly line: number; readonly quoted: boolean } | null = null;
  let block: string[] = [];
  for (const [index, written] of lines.entries()) {
    const quoted = BLOCKQUOTE.test(written);
    const line = opener === null ? written.replace(BLOCKQUOTE, '') : opener.quoted ? written.replace(BLOCKQUOTE, '') : written;
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (opener === null) {
      if (marker) {
        opener = { marker: marker[1]!, line: index + 1, quoted };
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

/** The texts of the arguments of the call whose `(` is at `open`, split at its top-level commas. */
function callArguments(code: string, open: number): string[] {
  const close = closingBracket(code, open);
  if (close < 0) return [];
  const found: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open + 1; index < close; index++) {
    const character = code[index]!;
    if (character === '(' || character === '[' || character === '{') depth++;
    else if (character === ')' || character === ']' || character === '}') depth--;
    else if (character === ',' && depth === 0) {
      found.push(code.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = code.slice(start, close).trim();
  if (last !== '') found.push(last);
  return found;
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

const inside = (spans: readonly Span[], at: number): boolean => spans.some((span) => at > span.start && at < span.end);

/**
 * `code` with its string literals and comments blanked to spaces, newlines
 * kept, so every position still lines up with the fence.  The timing rules
 * read this: an `await` in a comment, or a `try` in a string, is no statement.
 */
function codeOnly(code: string): string {
  let out = '';
  let index = 0;
  while (index < code.length) {
    const character = code[index]!;
    let end = -1;
    if (character === '/' && code[index + 1] === '/') {
      const lineEnd = code.indexOf('\n', index);
      end = lineEnd < 0 ? code.length : lineEnd;
    } else if (character === '/' && code[index + 1] === '*') {
      const commentEnd = code.indexOf('*/', index + 2);
      end = commentEnd < 0 ? code.length : commentEnd + 2;
    } else if (character === '\'' || character === '"' || character === '`') {
      const stringEnd = endOfString(code, index);
      end = stringEnd < 0 ? code.length : stringEnd + 1;
    }
    if (end < 0) {
      out += character;
      index++;
    } else {
      out += code.slice(index, end).replace(/[^\n]/g, ' ');
      index = end;
    }
  }
  return out;
}

/** One plug-in of a `plugins` array: its extent, where its body begins, and its parameter. */
type Plugin = Span & { readonly bodyStart: number; readonly parameter: string | null };

/**
 * The head of a plug-in, at the start of its element: an arrow function or a
 * function expression, `async` or not, its parameter typed or not.
 */
const PLUGIN_HEAD = /^\s*(?:async\s+)?(?:function\b[^(]*\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)\s*(?::[^{]*)?\{|\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)\s*(?::[^=]*)?=>|([A-Za-z_$][\w$]*)\s*=>)/;

/** The plug-ins of the `plugins` array `array` spans, split at its top-level commas. */
function pluginsIn(masked: string, array: Span): Plugin[] {
  const plugins: Plugin[] = [];
  let depth = 0;
  let start = array.start + 1;
  for (let index = array.start + 1; index <= array.end; index++) {
    const character = masked[index]!;
    if (index === array.end || (character === ',' && depth === 0)) {
      const head = PLUGIN_HEAD.exec(masked.slice(start, index));
      plugins.push({
        start,
        end: index,
        bodyStart: head === null ? start : start + head[0].length,
        parameter: head === null ? null : (head[1] ?? head[2] ?? head[3] ?? null),
      });
      start = index + 1;
    } else if (character === '(' || character === '[' || character === '{') {
      depth++;
    } else if (character === ')' || character === ']' || character === '}') {
      depth--;
    }
  }
  return plugins;
}

/** Where an arrow function's expression body ends: at a `,` or `;` outside brackets, or where the group around it closes. */
function expressionEnd(masked: string, from: number, limit: number): number {
  let depth = 0;
  for (let index = from; index < limit; index++) {
    const character = masked[index]!;
    if (character === '(' || character === '[' || character === '{') {
      depth++;
    } else if (character === ')' || character === ']' || character === '}') {
      if (depth === 0) return index;
      depth--;
    } else if ((character === ',' || character === ';') && depth === 0) {
      return index;
    }
  }
  return limit;
}

/**
 * The functions a plug-in defines in its body before `before`, each from its
 * head to the end of its body.  A helper inside one runs whenever that
 * function is called — after a microtask, a timer, a promise — and not while
 * the plug-in runs.
 */
function functionsInside(masked: string, plugin: Plugin, before: number): Span[] {
  const spans: Span[] = [];
  for (const head of masked.slice(plugin.bodyStart, before).matchAll(/=>|\bfunction\b/g)) {
    const at = plugin.bodyStart + head.index!;
    if (head[0] === '=>') {
      let body = at + 2;
      while (/\s/.test(masked[body] ?? '')) body++;
      spans.push({ start: at, end: masked[body] === '{' ? closingBracket(masked, body) : expressionEnd(masked, body, plugin.end) });
    } else {
      const parameters = masked.indexOf('(', at);
      const parametersClose = parameters < 0 ? -1 : closingBracket(masked, parameters);
      const brace = parametersClose < 0 ? -1 : masked.indexOf('{', parametersClose);
      spans.push({ start: at, end: brace < 0 ? plugin.end : closingBracket(masked, brace) });
    }
  }
  return spans;
}

const encloses = (span: Span, at: number): boolean => at > span.start && (span.end < 0 || at < span.end);

/**
 * Whether the plug-in awaits before it reaches `at`, in its own body rather
 * than in a function it defines.  The `await` of the helper's own promise is
 * the exception: the helper has registered by the time it suspends.
 */
function awaitsBefore(masked: string, plugin: Plugin, at: number, functions: readonly Span[]): boolean {
  const before = masked.slice(plugin.bodyStart, at);
  const own = /\bawait\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?$/.exec(before);
  return [...before.slice(0, own === null ? before.length : own.index).matchAll(/\bawait\b/g)]
    .some((found) => !functions.some((span) => encloses(span, plugin.bodyStart + found.index!)));
}

/**
 * Whether a rejection or a throw of the call opening at `callOpen` is handled
 * inside its plug-in: a `.catch(...)` or a two-argument `.then(...)` chained on
 * it, or a `try` around it with a `catch`.  Either one turns a malformed key
 * ring, a missing codec peer or a refused option into a startup that goes on.
 */
function failureCaught(code: string, masked: string, plugin: Plugin, at: number, callOpen: number): boolean {
  const callClose = closingBracket(code, callOpen);
  if (callClose > 0) {
    const chained = /^\s*\.\s*(catch|then)\s*\(/.exec(masked.slice(callClose + 1));
    if (chained !== null && (chained[1] === 'catch' || callArguments(code, callClose + chained[0].length).length > 1)) return true;
  }
  for (const attempt of masked.slice(plugin.bodyStart, at).matchAll(/\btry\s*\{/g)) {
    const blockClose = closingBracket(masked, plugin.bodyStart + attempt.index! + attempt[0].length - 1);
    if (blockClose > at && /^\s*catch\b/.test(masked.slice(blockClose + 1))) return true;
  }
  return false;
}

/** Every problem a wiring fence has. */
function wiringProblems(fence: Fence): string[] {
  return [...misplacedHelpers(fence), ...unpassedPluginOptions(fence)];
}

/**
 * The text of the statement holding `at`, from its start up to `at` — or
 * `null` when `at` sits in another call's arguments or in an array, whose
 * holder hands the value on as far as a fence can tell.
 */
function statementBefore(masked: string, at: number): string | null {
  let depth = 0;
  for (let index = at - 1; index >= 0; index--) {
    const character = masked[index]!;
    if (character === ')' || character === ']') {
      depth++;
    } else if (character === '}' || character === '{') {
      if (depth === 0) return masked.slice(index + 1, at);
      depth += character === '}' ? 1 : -1;
    } else if (character === '(' || character === '[') {
      if (depth === 0) return null;
      depth--;
    } else if (character === ';' && depth === 0) {
      return masked.slice(index + 1, at);
    }
  }
  return masked.slice(0, at);
}

/**
 * Where a fence builds options with plugins that never reach
 * `ActorSystem.create`: kept in a local that no `create` in the fence is
 * handed, or built and dropped.  A fence that creates no system shows the
 * options alone; options built as an argument — of `create` or of any other
 * call — returned, or set on a property are handed on, as far as a fence can
 * tell.
 */
function unpassedPluginOptions(fence: Fence): string[] {
  const { code } = fence;
  const masked = codeOnly(code);
  const handedToCreate = [...masked.matchAll(/\bActorSystem\s*\.\s*create\s*\(/g)]
    .map((create) => /^\s*([A-Za-z_$][\w$]*)/.exec(callArguments(code, create.index! + create[0].length - 1)[1] ?? '')?.[1]);
  const problems: string[] = [];
  for (const call of masked.matchAll(/\bwithPersistence\s*\(/g)) {
    const at = call.index!;
    const open = at + call[0].length - 1;
    const close = closingBracket(masked, open);
    if (close < 0 || !/\bplugins\s*:/.test(masked.slice(open, close))) continue;
    const statement = statementBefore(masked, at);
    if (statement === null || /^\s*return\b/.test(statement) || /=>/.test(statement)) continue;
    if (/^\s*[A-Za-z_$][\w$]*\s*:/.test(statement) && !statement.includes('=')) continue;
    const line = fence.line + code.slice(0, at).split('\n').length;
    const local = /^\s*(?:export\s+)?(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=(?![=>])/.exec(statement)?.[1];
    if (local === undefined) {
      problems.push(`line ${line}: the plugins of this withPersistence(...) are built and dropped, never handed to ActorSystem.create(...)`);
    } else if (handedToCreate.length > 0 && !handedToCreate.includes(local)) {
      problems.push(`line ${line}: ${local} holds the plugins of this withPersistence(...), but no ActorSystem.create(...) is handed it`);
    }
  }
  return problems;
}

/**
 * Where a fence names a register helper anywhere but in an import or as a call
 * a `plugins` callback makes with its own parameter, before its first `await`,
 * outside any function it defers, and with its failure left to the startup.
 * Comments are read too: a `// registerPostgresPlugins(ext)` in a sample is an
 * instruction its reader follows.
 */
function misplacedHelpers(fence: Fence): string[] {
  const { code } = fence;
  const masked = codeOnly(code);
  const names = helperNames(code);
  const imports = importStatements(code);
  const plugins = pluginArrays(code);
  const problems: string[] = [];
  // A preceding `.` is not excluded: `persistence.registerPostgresPlugins(...)`
  // through a namespace import is the same call, and has to sit in the same place.
  const pattern = new RegExp(`(?<![\\w$])(${[...names.keys()].join('|')})(?![\\w$])`, 'g');
  const imported = new Set<string>();
  const called = new Set<string>();
  for (const use of code.matchAll(pattern)) {
    const at = use.index!;
    const helper = names.get(use[1]!)!;
    if (inside(imports, at)) {
      imported.add(helper);
      continue;
    }
    const line = fence.line + code.slice(0, at).split('\n').length;
    called.add(helper);
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
    const plugin = pluginsIn(masked, span).find((candidate) => at >= candidate.start && at < candidate.end);
    const parameter = plugin?.parameter ?? null;
    const callOpen = at + use[1]!.length + call[0].length - 1;
    const [extension = '', options] = callArguments(code, callOpen);
    if (parameter === null || extension !== parameter) {
      problems.push(`line ${line}: ${helper}(${extension}, ...) is not handed the plug-in's own parameter (${parameter ?? 'none'})`);
    }
    // The options are built into a local first and handed over by name — a
    // builder chain or an object literal nested into the call is refused, the
    // project-wide rule for every options builder.
    if (options !== undefined && !/^[A-Za-z_$][\w$]*$/.test(options)) {
      problems.push(`line ${line}: ${helper}(..., ${options.split('\n')[0]}) builds its options inside the call instead of in a local`);
    }
    // The one asynchronous helper: its promise carries the codec probes, and
    // the startup can only wait for it if it reaches the slot — returned by an
    // expression-bodied plug-in or awaited inside an async one.  Called as a
    // statement, a failed probe is an unhandled rejection and the startup
    // carries on without it.
    if (ASYNC_HELPERS.includes(helper) && !/(?:=>|\bawait|\breturn)\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?$/.test(code.slice(span.start, at))) {
      problems.push(`line ${line}: the promise ${helper}(...) returns never reaches the plugins slot`);
    }
    // When it runs, and where its failure goes — for a call in a comment too,
    // which a reader uncomments where it stands.  What came before it is read
    // as code only: an `await` in a comment is no statement.
    if (plugin !== undefined) {
      const functions = functionsInside(masked, plugin, at);
      if (functions.some((span) => encloses(span, at))) {
        problems.push(`line ${line}: ${helper}(...) runs in a function its plug-in defers, so it registers after create returns`);
      } else if (awaitsBefore(masked, plugin, at, functions)) {
        problems.push(`line ${line}: ${helper}(...) runs after an await in its plug-in, so it registers after create returns`);
      }
      if (failureCaught(code, masked, plugin, at, callOpen)) {
        problems.push(`line ${line}: a failure of ${helper}(...) is caught inside its plug-in and never reaches the startup`);
      }
    }
  }
  for (const helper of imported) {
    if (!called.has(helper)) problems.push(`${helper} is imported but never wired`);
  }
  // The extension exists only once `create` has returned, so a store set on it
  // is set after the startup resolved the selected ones and is not opened with
  // them.  `withPersistence({ journal, snapshotStore, durableStateStore })` is
  // where an instance goes.
  for (const setter of code.matchAll(/\.(setJournal|setSnapshotStore|setDurableStateStore)\s*\(/g)) {
    const line = fence.line + code.slice(0, setter.index!).split('\n').length;
    problems.push(`line ${line}: ${setter[1]}(...) sets a store on the extension after create instead of in withPersistence(...)`);
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
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line.replace(BLOCKQUOTE, ''));
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

/** The sentences of `prose` that have a store open late without saying why, or while saying the opposite. */
function lateOpenSentences(language: Language, prose: string): string[] {
  return sentencesOf(prose)
    .filter((sentence) => OPENS_LATE[language].test(sentence))
    .filter((sentence) => !LATE_OPEN_EXPLAINED[language].test(sentence) || OPENS_LATE_REGARDLESS[language].test(sentence));
}

function sentencesOpeningLate(language: Language, page: string): string[] {
  return lateOpenSentences(language, proseOf(page, read(language, page)));
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
        const problems = fencesOf(read(language, page)).flatMap((fence) => wiringProblems(fence));
        expect(problems, `${pageFile(language, page)} registers a backend outside the plugins slot`).toEqual([]);
      });
    }

    test(`${page}: a fence that wires persistence has the same code in English and German`, () => {
      expect(wiringFenceDifferences(read('english', page), read('german', page)), `${page}: a wiring sample differs between the languages`)
        .toEqual([]);
    });
  }

  test('the page list is every page that registers a backend in a fence, and the pages it holds for their prose', () => {
    // Both directions: a page dropped from the list, a new page that wires a
    // backend, and a census that stopped finding anything all fail here.
    expect([...pagesRegisteringABackend(DOCS_ROOT)].sort()).toEqual(
      [...PAGES.filter((page) => !PROSE_ONLY_PAGES.has(page)), ...CENSUS_EXEMPT_PAGES.keys()].sort(),
    );
    for (const page of PROSE_ONLY_PAGES.keys()) expect(PAGES, `${page} is held for its prose`).toContain(page);
  });
});

/**
 * What the two languages of a fence have to share: its language and its code,
 * comments taken out, line ends trimmed and blank lines dropped.  A comment
 * may be translated, as AGENTS.md allows for every fence but the reference-conf
 * one — and nothing is lost by it here, because the scanner reads each
 * language's own comments, so a German one that registers after `create` is
 * refused on the German page.
 */
function sharedCodeOf(fence: Fence): string {
  const language = /^\s*(?:`{3,}|~{3,})\s*(\S*)/.exec(fence.text)?.[1] ?? '';
  let code = '';
  let index = 0;
  while (index < fence.code.length) {
    const character = fence.code[index]!;
    if (character === '/' && fence.code[index + 1] === '/') {
      const lineEnd = fence.code.indexOf('\n', index);
      index = lineEnd < 0 ? fence.code.length : lineEnd;
    } else if (character === '/' && fence.code[index + 1] === '*') {
      const commentEnd = fence.code.indexOf('*/', index + 2);
      index = commentEnd < 0 ? fence.code.length : commentEnd + 2;
    } else if (character === '\'' || character === '"' || character === '`') {
      const stringEnd = endOfString(fence.code, index);
      const end = stringEnd < 0 ? fence.code.length : stringEnd + 1;
      code += fence.code.slice(index, end);
      index = end;
    } else {
      code += character;
      index++;
    }
  }
  const lines = code.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
  return [language, ...lines].join('\n');
}

/**
 * Where the wiring fences of a page and its mirror differ in their code, by
 * position.  The mirrors are paired fence by fence, so their numbers of fences
 * have to agree first.
 */
function wiringFenceDifferences(englishText: string, germanText: string): string[] {
  const english = fencesOf(englishText);
  const german = fencesOf(germanText);
  if (german.length !== english.length) {
    return [`the mirrors hold ${english.length} and ${german.length} fences, so they cannot be paired`];
  }
  return english
    .map((fence, index) => ({ english: fence, german: german[index]! }))
    .filter((pair) => WIRING.test(pair.english.text) || WIRING.test(pair.german.text))
    .filter((pair) => sharedCodeOf(pair.english) !== sharedCodeOf(pair.german))
    .map((pair) => `English :${pair.english.line} / German :${pair.german.line}`);
}

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

/**
 * The purpose cells of the configuration reference's `auto-create-*` rows.
 *
 * The sentence check above leaves table rows out, because a row's wording
 * moves with its leaf's other descriptions.  These rows are the exception:
 * a store creates its schema when it opens, so each of them states when a
 * store opens, and "on first use" there told the reader the boot-time open
 * did not exist.
 */
function schemaCreationCells(language: Language): string[] {
  const lines = read(language, 'reference/configuration.mdx').split('\n');
  const heading = SCOPED_PAGES['reference/configuration.mdx']!.heading;
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`reference/configuration.mdx: the "${heading}" heading is gone — re-point this guard.`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('### '));
  return lines
    .slice(start, end < 0 ? lines.length : end)
    .filter((line) => /^\|\s*`persistence\.[\w.-]+\.auto-create-(?:tables|indexes)`\s*\|/.test(line))
    .map((line) => line.split('|').slice(3, -1).join('|').trim());
}

describe('the configuration reference says when a store creates its schema (#1473)', () => {
  for (const language of LANGUAGES) {
    test(`${language}: no auto-create row has the store open late without saying it is the boot-time open turned off`, () => {
      const cells = schemaCreationCells(language);
      expect(cells.length, 'the auto-create rows are gone — re-point this guard').toBeGreaterThan(20);
      expect(
        cells.flatMap((cell) => lateOpenSentences(language, cell)),
        `${pageFile(language, 'reference/configuration.mdx')}: an auto-create row has the store create its schema on `
        + 'first use — a selected store opens, and creates it, at startup.',
      ).toEqual([]);
    });
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

/**
 * What is wrong with how an overview page shows the `plugins` route: it has to
 * show it in exactly one fence, and that fence has to stand in the
 * pluggable-backends section.
 */
function routeProblems(language: Language, text: string): string[] {
  const headings = OVERVIEW_HEADINGS[language];
  const routes = fencesOf(text).filter((fence) => /\bwithPersistence\s*\(/.test(fence.code) && /\bplugins\s*:/.test(fence.code));
  if (routes.length !== 1) return [`the plugins route is shown ${routes.length} times, at lines ${routes.map((fence) => fence.line).join(', ')}`];
  const backends = sectionOf(text, headings.backends);
  const line = routes[0]!.line;
  return line > backends.from && line < backends.to ? [] : [`the plugins route at line ${line} is not under "${headings.backends}"`];
}

/** What is wrong with the startup section of an overview page: it has to link the route rather than repeat it. */
function startupLinkProblems(language: Language, text: string): string[] {
  const headings = OVERVIEW_HEADINGS[language];
  const startup = sectionOf(text, headings.startup);
  const section = text.split('\n').slice(startup.from, startup.to).join('\n');
  return section.includes(headings.backendsAnchor) ? [] : [`"${headings.startup}" does not link "${headings.backendsAnchor}"`];
}

describe('the persistence overview shows the plugins route once (#1473)', () => {
  for (const language of LANGUAGES) {
    const headings = OVERVIEW_HEADINGS[language];

    test(`${language}: one fence wires a plug-in, and it stands under "${headings.backends}"`, () => {
      expect(routeProblems(language, read(language, OVERVIEW)), pageFile(language, OVERVIEW)).toEqual([]);
    });

    test(`${language}: "${headings.startup}" points to the route rather than repeating it`, () => {
      expect(startupLinkProblems(language, read(language, OVERVIEW)), pageFile(language, OVERVIEW)).toEqual([]);
    });
  }
});

/**
 * The scanner against the disguises it was built to see through.  The page
 * tests above pass on today's pages either way; these hold the scanner itself
 * to its word, so a rule that stops matching turns red here rather than going
 * quiet over pages that happen to be clean.
 *
 * Each case pins the whole list of problems, so it is caught by one rule and
 * no other: a case two rules both catch would stay red with either of them
 * gone, which is how six of the sixteen rules could be switched off with the
 * suite green.
 */
describe('the scanner sees through the disguises of a post-create registration (#1473)', () => {
  const route = [
    "import { registerPostgresPlugins } from 'actor-ts/persistence';",
    'const systemOptions = ActorSystemOptions.create().withPersistence({',
    '  plugins: [(persistence) => registerPostgresPlugins(persistence, registerOptions)],',
    '});',
  ].join('\n');
  const fence = (code: string): Fence => ({ line: 1, text: `\`\`\`ts\n${code}\n\`\`\``, code });
  const notInPlugins = (line: number): string =>
    `line ${line}: registerPostgresPlugins(...) is not inside the plugins array of a withPersistence(...) call`;
  const notCalled = (line: number): string => `line ${line}: registerPostgresPlugins is referenced without being called`;

  test('the create-side route passes, and so does an async object-storage plug-in that awaits', () => {
    expect(misplacedHelpers(fence(route))).toEqual([]);
    const objectStorage = [
      "import { registerObjectStoragePlugins } from 'actor-ts/persistence';",
      'const systemOptions = ActorSystemOptions.create().withPersistence({',
      '  plugins: [async (persistence) => {',
      '    handles = await registerObjectStoragePlugins(persistence, pluginOptions);',
      '  }],',
      '});',
    ].join('\n');
    expect(misplacedHelpers(fence(objectStorage))).toEqual([]);
  });

  test.each([
    ['a call after create', 'registerPostgresPlugins(system.extension(PersistenceExtensionId));', [notInPlugins(6)]],
    ['an arrow wrapper after create', 'const wire = (persistence) => registerPostgresPlugins(persistence, registerOptions);', [notInPlugins(6)]],
    ['an alias', 'const register = registerPostgresPlugins;\nregister(extension);', [notCalled(6)]],
    ['an import alias', "import { registerPostgresPlugins as wire } from 'actor-ts/persistence';\nwire(extension);", [notInPlugins(7)]],
    ['a namespace import', 'persistenceModule.registerPostgresPlugins(extension);', [notInPlugins(6)]],
    ['a comment', '// later, on the running system: registerPostgresPlugins(extension);', [notInPlugins(6)]],
    ['a template string', 'console.log(`${registerPostgresPlugins(extension)}`);', [notInPlugins(6)]],
    ['a wrapper function', 'function wire(target) { return registerPostgresPlugins(target); }', [notInPlugins(6)]],
    ['a computed member', "persistenceModule['registerPostgresPlugins'](extension);", [notCalled(6)]],
    ['call()', 'registerPostgresPlugins.call(undefined, extension);', [notCalled(6)]],
    ['a store set on the extension', 'system.extension(PersistenceExtensionId).setJournal(journal);',
      ['line 6: setJournal(...) sets a store on the extension after create instead of in withPersistence(...)']],
  ])('%s is refused', (_disguise, extra, problems) => {
    expect(misplacedHelpers(fence(`${route}\n${extra}`))).toEqual(problems);
  });

  test('a plug-in handed something other than its own parameter is refused', () => {
    const outer = route.replace('registerPostgresPlugins(persistence,', 'registerPostgresPlugins(extension,');
    expect(misplacedHelpers(fence(outer)))
      .toEqual(["line 4: registerPostgresPlugins(extension, ...) is not handed the plug-in's own parameter (persistence)"]);
  });

  test('options built inside the call are refused', () => {
    const inline = route.replace('registerOptions)', 'RegisterPostgresPluginsOptions.create().withUrl(url))');
    expect(misplacedHelpers(fence(inline))).toEqual([
      'line 4: registerPostgresPlugins(..., RegisterPostgresPluginsOptions.create().withUrl(url)) builds its options inside the call instead of in a local',
    ]);
  });

  test('an object-storage promise that never reaches the slot is refused', () => {
    const dropped = [
      "import { registerObjectStoragePlugins } from 'actor-ts/persistence';",
      'const systemOptions = ActorSystemOptions.create().withPersistence({',
      '  plugins: [(persistence) => { registerObjectStoragePlugins(persistence, pluginOptions); }],',
      '});',
    ].join('\n');
    expect(misplacedHelpers(fence(dropped)))
      .toEqual(['line 4: the promise registerObjectStoragePlugins(...) returns never reaches the plugins slot']);
  });

  test('a helper imported and never wired is refused', () => {
    expect(misplacedHelpers(fence("import { registerObjectStoragePlugins } from 'actor-ts/persistence';")))
      .toEqual(['registerObjectStoragePlugins is imported but never wired']);
  });
});

/**
 * Shapes that break the startup, or the protection it gives, though every
 * helper call sits in the plugins array and is handed its plug-in's own
 * parameter.  Plug-ins run inside `ActorSystem.create`, and a factory
 * registered after a plug-in's first `await` — or in a function the plug-in
 * defers — misses the selected stores, which `create` resolves before it
 * returns; options that never reach `create` register nothing at all; and a
 * rejection handled inside the plug-in never reaches the `persistence-start`
 * phase, so a malformed key ring starts up.  Each shape is pinned with its
 * one problem, and a correct plug-in of each kind with none.
 */
describe('a plug-in registers before create returns, and its failure reaches the startup (#1473)', () => {
  const fence = (code: string): Fence => ({ line: 1, text: `\`\`\`ts\n${code}\n\`\`\``, code });
  const sample = (plugin: string, create = "const system = ActorSystem.create('my-app', systemOptions);"): string =>
    ['const systemOptions = ActorSystemOptions.create().withPersistence({', `  plugins: [${plugin}],`, '});', create].join('\n');
  const awaited = (helper: string): string => `line 3: ${helper}(...) runs after an await in its plug-in, so it registers after create returns`;
  const deferred = (helper: string): string => `line 3: ${helper}(...) runs in a function its plug-in defers, so it registers after create returns`;
  const caught = (helper: string): string => `line 3: a failure of ${helper}(...) is caught inside its plug-in and never reaches the startup`;

  test.each([
    ['an arrow plug-in', '(persistence) => registerPostgresPlugins(persistence, registerOptions)'],
    ['a block-bodied one keeping the handle', '(persistence) => { postgres = registerPostgresPlugins(persistence, registerOptions); }'],
    ['an async one awaiting the object-storage helper', 'async (persistence) => { objectStorage = await registerObjectStoragePlugins(persistence, pluginOptions); }'],
    ['an expression-bodied object-storage plug-in', '(persistence) => registerObjectStoragePlugins(persistence, pluginOptions)'],
    ['a function expression', 'function (persistence) { return registerPostgresPlugins(persistence, registerOptions); }'],
    ['a named async function expression', 'async function plugin(persistence) { objectStorage = await registerObjectStoragePlugins(persistence); }'],
    ['a sync helper, then the awaited object-storage one', 'async (persistence) => { registerSqlitePlugins(persistence); objectStorage = await registerObjectStoragePlugins(persistence); }'],
    ['an await in a comment', 'async (persistence) => { /* no await before this */ registerSqlitePlugins(persistence); }'],
    ['a try with finally only, which rethrows', 'async (persistence) => { try { objectStorage = await registerObjectStoragePlugins(persistence); } finally { log(); } }'],
    ['a function the plug-in defines and finishes before registering', '(persistence) => { const log = () => audit(); registerSqlitePlugins(persistence); }'],
    ['an await inside a function it defines and does not await', 'async (persistence) => { const warm = async () => { await cache.warm(); }; registerSqlitePlugins(persistence); }'],
  ])('%s passes', (_shape, plugin) => {
    expect(wiringProblems(fence(sample(plugin)))).toEqual([]);
  });

  test.each([
    ['an await before a synchronous helper', "async (persistence) => { const password = await vault.read('mariadb/password'); registerMariaDbPlugins(persistence, registerOptions); }", [awaited('registerMariaDbPlugins')]],
    ['an await before the object-storage helper', "async (persistence) => { const key = await vault.read('key'); objectStorage = await registerObjectStoragePlugins(persistence, pluginOptions); }", [awaited('registerObjectStoragePlugins')]],
    ['a commented-out registration after an await', 'async (persistence) => { await vault.ready(); /* registerSqlitePlugins(persistence); */ }', [awaited('registerSqlitePlugins')]],
    ['a registration deferred with queueMicrotask', '(persistence) => { queueMicrotask(() => registerMsSqlPlugins(persistence, registerOptions)); }', [deferred('registerMsSqlPlugins')]],
    ['a registration deferred with setTimeout', '(persistence) => { setTimeout(() => registerMsSqlPlugins(persistence, registerOptions), 0); }', [deferred('registerMsSqlPlugins')]],
    ['a registration in a then callback', '(persistence) => loadSecret().then(() => registerPostgresPlugins(persistence, registerOptions))', [deferred('registerPostgresPlugins')]],
    ['a registration in a function expression it defers', '(persistence) => { process.nextTick(function () { registerPostgresPlugins(persistence, registerOptions); }); }', [deferred('registerPostgresPlugins')]],
    ['a rejection caught with catch', '(persistence) => registerObjectStoragePlugins(persistence, options).catch(() => undefined)', [caught('registerObjectStoragePlugins')]],
    ['a rejection handled by then', '(persistence) => registerObjectStoragePlugins(persistence, options).then((handles) => handles, () => undefined)', [caught('registerObjectStoragePlugins')]],
    ['a rejection caught by try', 'async (persistence) => { try { objectStorage = await registerObjectStoragePlugins(persistence, options); } catch { } }', [caught('registerObjectStoragePlugins')]],
    ['a throw caught by try', '(persistence) => { try { registerPostgresPlugins(persistence, registerOptions); } catch (error) { console.warn(error); } }', [caught('registerPostgresPlugins')]],
  ])('%s is refused', (_shape, plugin, problems) => {
    expect(wiringProblems(fence(sample(plugin)))).toEqual(problems);
  });

  const arrow = '(persistence) => registerLibSqlPlugins(persistence, registerOptions)';

  test.each([
    ['handed to create', sample(arrow)],
    ['in a fence that creates no system', sample(arrow, '')],
    ['built inside the create call', `const system = ActorSystem.create('my-app', ActorSystemOptions.create().withPersistence({ plugins: [${arrow}] }));`],
    ['returned for a caller to pass', `function systemOptionsFor(registerOptions) {\n  return ActorSystemOptions.create().withPersistence({ plugins: [${arrow}] });\n}`],
  ])('options with plugins %s pass', (_shape, code) => {
    expect(wiringProblems(fence(code))).toEqual([]);
  });

  test.each([
    ['a create without them', sample(arrow, "const system = ActorSystem.create('my-app');"),
      ['line 2: systemOptions holds the plugins of this withPersistence(...), but no ActorSystem.create(...) is handed it']],
    ['a create handed other options', sample(arrow, "const system = ActorSystem.create('my-app', otherOptions);"),
      ['line 2: systemOptions holds the plugins of this withPersistence(...), but no ActorSystem.create(...) is handed it']],
    ['options built and dropped', `ActorSystemOptions.create().withPersistence({ plugins: [${arrow}] });\nconst system = ActorSystem.create('my-app');`,
      ['line 2: the plugins of this withPersistence(...) are built and dropped, never handed to ActorSystem.create(...)']],
  ])('options with plugins and %s are refused', (_shape, code, problems) => {
    expect(wiringProblems(fence(code))).toEqual(problems);
  });
});

/** The page-level rules, each against a page made to break it and only it. */
describe('the page rules hold on pages made to break them (#1473)', () => {
  const page = (...blocks: ReadonlyArray<string>): string => `${blocks.join('\n\n')}\n`;
  const ts = (code: string): string => `\`\`\`ts\n${code}\n\`\`\``;
  const route = [
    'const systemOptions = ActorSystemOptions.create().withPersistence({',
    '  plugins: [(persistence) => registerPostgresPlugins(persistence, registerOptions)],',
    '});',
  ].join('\n');

  test('a wiring fence that differs between the mirrors is reported, and nothing else', () => {
    const english = page('Prose.', ts(route), 'More prose.', ts('const unrelated = 1;'));
    const german = page('Prosa.', ts(route.replace('registerOptions)', 'otherOptions)')), 'Mehr Prosa.', ts('const unrelated = 2;'));
    expect(wiringFenceDifferences(english, english)).toEqual([]);
    expect(wiringFenceDifferences(english, german)).toEqual(['English :3 / German :3']);
    expect(wiringFenceDifferences(english, page('Prosa.', ts(route)))).toEqual(['the mirrors hold 2 and 1 fences, so they cannot be paired']);
  });

  test('the mirrors share the code of a wiring fence, not its comments', () => {
    const commented = (lineComment: string, blockComment: string): string => page('Prose.', ts([
      `// ${lineComment}`,
      'const systemOptions = ActorSystemOptions.create().withPersistence({',
      `  plugins: [(persistence) => registerSqlitePlugins(persistence)],   /* ${blockComment} */`,
      "  endpoint: 'https://example.com//path',",
      '});',
    ].join('\n')));
    const english = commented('the boot-time open covers it', 'path, tables, retention … from HOCON');
    // Translated comments, the kind AGENTS.md allows.
    expect(wiringFenceDifferences(english, commented('das Öffnen beim Start deckt ihn ab', 'Pfad, Tabellen, Aufbewahrung … aus HOCON'))).toEqual([]);
    // Code is code: a string that holds `//`, and the fence's language.
    expect(wiringFenceDifferences(english, english.replace('//path', '//other'))).toEqual(['English :3 / German :3']);
    expect(wiringFenceDifferences(english, english.replace('```ts', '```js'))).toEqual(['English :3 / German :3']);
  });

  test('a paragraph is read sentence by sentence, so an explained sentence cannot cover the next one', () => {
    const paragraph = 'One store opens on first use when the boot-time open is turned off. Another one opens on first use.';
    expect(lateOpenSentences('english', paragraph)).toEqual(['Another one opens on first use.']);
    expect(lateOpenSentences('german', 'Ein Store öffnet bei Bedarf, wenn das Öffnen beim Start abgeschaltet ist. Ein anderer öffnet bei Bedarf.'))
      .toEqual(['Ein anderer öffnet bei Bedarf.']);
  });

  const headings = OVERVIEW_HEADINGS.english;
  const overview = (backends: ReadonlyArray<string>, startup: ReadonlyArray<string>): string =>
    page('# Persistence', headings.backends, ...backends, headings.startup, ...startup, '## Next');

  test('the overview shows the route once, under the pluggable-backends heading, and its startup section links there', () => {
    const linked = `See [the route]${headings.backendsAnchor}.`;
    expect(routeProblems('english', overview([ts(route)], [linked]))).toEqual([]);
    expect(startupLinkProblems('english', overview([ts(route)], [linked]))).toEqual([]);
    expect(routeProblems('english', overview([ts(route), ts(route)], [linked]))).toEqual(['the plugins route is shown 2 times, at lines 5, 11']);
    expect(routeProblems('english', overview(['Prose.'], [ts(route)]))).toEqual([`the plugins route at line 9 is not under "${headings.backends}"`]);
    expect(startupLinkProblems('english', overview([ts(route)], [ts(route)])))
      .toEqual([`"${headings.startup}" does not link "${headings.backendsAnchor}"`]);
  });

  test('a fence inside a blockquote is a fence like any other, and its code is no prose', () => {
    const quoted = page('> Note:', `> ${ts('registerPostgresPlugins(system.extension(PersistenceExtensionId));').split('\n').join('\n> ')}`);
    expect(fencesOf(quoted).flatMap((fence) => wiringProblems(fence)))
      .toEqual(['line 4: registerPostgresPlugins(...) is not inside the plugins array of a withPersistence(...) call']);
    expect(proseOf('fixture.mdx', page('> Opened at startup.', `> ${ts('// the tables are created on first use').split('\n').join('\n> ')}`)))
      .not.toContain('first use');
  });

  test('the census finds a registering fence on any page, at any depth, in either language, and skips the generated tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'create-side-wiring-'));
    try {
      const pages: ReadonlyArray<readonly [string, string]> = [
        ['registers.mdx', page('Prose.', ts('registerSqlitePlugins(persistence);'))],
        ['de/only-german.mdx', page('Prosa.', ts(route))],
        ['nested/deeper/slot.md', page(ts(route))],
        ['slot-only.mdx', page(ts('const systemOptions = ActorSystemOptions.create().withPersistence({ plugins: [postgresPlugin] });'))],
        ['api/generated.mdx', page(ts(route))],
        ['nested/api/handwritten.mdx', page(ts(route))],
        ['prose-only.mdx', page('It calls `registerPostgresPlugins` once.')],
        ['instances-only.mdx', page(ts('const systemOptions = ActorSystemOptions.create().withPersistence({ journal });'))],
      ];
      for (const [path, text] of pages) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      expect([...pagesRegisteringABackend(root)].sort())
        .toEqual(['nested/api/handwritten.mdx', 'nested/deeper/slot.md', 'only-german.mdx', 'registers.mdx', 'slot-only.mdx']);
    } finally {
      if (root !== '') rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the sentence check sees through the disguises of a store opening late (#1473)', () => {
  test.each([
    ['english', 'The backend runs `CREATE TABLE` when the store opens — at startup, or on first use when the boot-time open is turned off.'],
    ['english', 'A store wired by hand is not a selected one, so it opens on first use rather than with the startup.'],
    ['german', 'Das Backend legt die Tabellen an, wenn der Store öffnet — beim Start, oder bei der ersten Verwendung, wenn das Öffnen beim Start abgeschaltet ist.'],
    ['german', 'Ein von Hand verdrahteter Store ist kein ausgewählter, er öffnet also bei der ersten Verwendung.'],
  ] as const)('%s: an explained late open passes', (language, prose) => {
    expect(lateOpenSentences(language, prose)).toEqual([]);
  });

  test.each([
    ['english', 'The backend runs `CREATE TABLE` on first use.'],
    ['english', 'The backend runs `CREATE TABLE` on first-use.'],
    ['english', 'The framework lazy-imports the driver.'],
    ['english', 'The tables are created on first use, even when the boot-time open is turned off.'],
    ['english', 'The store connects on\nfirst use.'],
    ['german', 'Das Backend legt die Tabellen beim ersten Zugriff an.'],
    ['german', 'Der Store verbindet sich erst bei Bedarf.'],
    ['german', 'Die Tabellen entstehen bei der ersten Verwendung, auch wenn das Öffnen beim Start abgeschaltet ist.'],
  ] as const)('%s: "%s" is refused', (language, prose) => {
    expect(lateOpenSentences(language, prose)).not.toEqual([]);
  });

  test('an MDX comment renders nothing, so a sentence parked in one is not read', () => {
    expect(proseOf('fixture.mdx', 'Opened at startup.\n\n{/* The tables are created on first use. */}\n')).not.toContain('first use');
  });
});
