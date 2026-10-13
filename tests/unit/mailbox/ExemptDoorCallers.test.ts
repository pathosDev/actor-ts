/**
 * The exempt door's callers are named where its rule is written (#1431).
 *
 * `Mailbox.enqueueSignal` states the rule for every envelope that reaches it
 * through `ActorCell.postSignalEnvelope` — exempt from the bound, never early —
 * and the rule is only as good as its list of who relies on it.  That list went
 * stale once already: #918 gave the door a fourth caller, the `Terminated` of a
 * death another node reports, while every description of the door went on
 * counting three.  So this reads the callers out of `src/` and holds the
 * JSDoc to them, the shape `tests/unit/docs/SystemQueueProducers.test.ts`
 * gives the system queue's producers: a caller added without being named fails
 * here, and so does a name whose caller is gone.
 *
 * A caller is any member access `.postSignalEnvelope` outside a comment — a
 * call, but also a `.bind` or a reference handed elsewhere — named by its file
 * and the declaration that encloses it.  It is a ratchet, not an adversary: a
 * computed `['postSignalEnvelope']` gets past it.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const SOURCE_ROOT = join(REPOSITORY_ROOT, 'src');
const MAILBOX_SOURCE = join(SOURCE_ROOT, 'internal', 'Mailbox.ts');
const ACTOR_OPTIONS_SOURCE = join(SOURCE_ROOT, 'ActorOptions.ts');
const ACTOR_CELL_SOURCE = join(SOURCE_ROOT, 'internal', 'ActorCell.ts');

/** The door itself, which the record names without being one of its callers. */
const DOOR = 'ActorCell.postSignalEnvelope';

/** The bold lead of the paragraph in `enqueueSignal`'s JSDoc that lists the callers. */
const RULE_LEAD = '**The door decides undroppability, never position (#1431).**';

const COUNT_WORDS: ReadonlyMap<string, number> = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
]);

/** Words that open a block without declaring anything a caller could be named after. */
const KEYWORDS: ReadonlySet<string> = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'throw', 'new',
  'typeof', 'void', 'do', 'else', 'try', 'finally', 'case', 'super', 'this',
]);

/** A method, a function, or an arrow bound to a name — the line that opens one. */
const DECLARATION =
  /^(?:export\s+)?(?:(?:private|protected|public|static|async|override|readonly)\s+)*(?:function\s*\*?\s*)?(?:(?:get|set)\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\(/;
const ARROW_DECLARATION =
  /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:<[^()]*>)?\(/;

/** A use of the door: a member access, which its own declaration is not. */
const USE = /\.postSignalEnvelope\b/;

const typeScriptFilesUnder = (directory: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...typeScriptFilesUnder(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
};

/** The code on a line — nothing for a comment line, and no trailing `//` comment. */
const codeOf = (line: string): string => {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return '';
  return line.replace(/\s\/\/.*$/, '');
};

const indentationOf = (line: string): number => line.length - line.trimStart().length;

/**
 * The declaration that encloses line `index`.
 *
 * Walking up, only a line indented *less* than everything seen so far can open
 * an enclosing scope — a sibling statement at the same depth never does —
 * and the first such line that declares something names the caller.  A line
 * that starts with `)` closes a multi-line signature rather than opening a
 * scope, so it does not lower the bar the declaration above it has to pass.
 */
const enclosingDeclaration = (lines: ReadonlyArray<string>, index: number): string => {
  let bar = indentationOf(lines[index]!);
  for (let at = index - 1; at >= 0; at--) {
    const code = codeOf(lines[at]!);
    if (code.trim() === '') continue;
    const indentation = indentationOf(code);
    if (indentation >= bar) continue;
    const text = code.trim();
    if (text.startsWith(')')) continue;
    bar = indentation;
    const declared = DECLARATION.exec(text)?.[1] ?? ARROW_DECLARATION.exec(text)?.[1];
    if (declared !== undefined && !KEYWORDS.has(declared)) return declared;
  }
  return '<module>';
};

/** Every place in `src/` that reaches the door, as `File.declaration`, sorted. */
const callersInSource = (): string[] => {
  const callers: string[] = [];
  for (const file of typeScriptFilesUnder(SOURCE_ROOT)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('postSignalEnvelope')) continue;
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (USE.test(codeOf(lines[index]!))) {
        callers.push(`${basename(file, '.ts')}.${enclosingDeclaration(lines, index)}`);
      }
    }
  }
  return callers.sort();
};

/** The JSDoc block immediately above a declaration, without its delimiters. */
const jsDocAbove = (source: string, declaration: string): string => {
  const at = source.indexOf(declaration);
  expect(at).toBeGreaterThan(-1);
  const open = source.lastIndexOf('/**', at);
  expect(open).toBeGreaterThan(-1);
  return source.slice(open, source.indexOf('*/', open));
};

/** One JSDoc paragraph, from the bold lead that opens it to the next blank JSDoc line, as prose. */
const paragraphFrom = (jsDoc: string, lead: string): string => {
  const start = jsDoc.indexOf(lead);
  expect(start).toBeGreaterThan(-1);
  const lines = jsDoc.slice(start).split(/\r?\n/);
  const end = lines.findIndex((line) => line.trim() === '*');
  return (end === -1 ? lines : lines.slice(0, end))
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
};

/** Backticked `File.declaration` names in a passage, the door itself excepted. */
const callersNamedIn = (passage: string): string[] =>
  [...new Set([...passage.matchAll(/`([A-Z][\w$]*\.[A-Za-z_$][\w$]*)`/g)].map((match) => match[1]!))]
    .filter((name) => name !== DOOR)
    .sort();

/** The number in "<count> call sites", spelled out. */
const callSiteCountIn = (passage: string): number | undefined => {
  const counted = /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+call sites\b/i.exec(passage);
  return counted === null ? undefined : COUNT_WORDS.get(counted[1]!.toLowerCase());
};

describe('the exempt door names its real callers — #1431', () => {
  test('the scan finds the door\'s callers where they are', () => {
    // Pinned so a broken scan cannot pass the comparisons below by finding
    // nothing on both sides.  Update it together with the JSDoc.
    expect(callersInSource()).toEqual([
      'ActorCell._notifyWatcher',
      'ActorCell.onWatchNotify',
      'ConnectionWiring.postAcceptCommand',
      'WebsocketConnection.close',
    ]);
  });

  test("Mailbox.enqueueSignal's JSDoc names exactly the callers in src/", () => {
    const jsDoc = jsDocAbove(readFileSync(MAILBOX_SOURCE, 'utf8'), 'enqueueSignal(env: Envelope<T>): void {');
    const paragraph = paragraphFrom(jsDoc, RULE_LEAD);
    const callers = callersInSource();

    expect(callersNamedIn(paragraph)).toEqual(callers);
    expect(callSiteCountIn(paragraph)).toBe(callers.length);
    // Where overtaking lives instead, so the rule cannot be read as a refusal
    // to offer it at all.
    expect(jsDoc).toContain('ControlAwareMailbox');
  });

  test('ActorOptions.mailboxCapacity counts the same call sites', () => {
    const jsDoc = jsDocAbove(readFileSync(ACTOR_OPTIONS_SOURCE, 'utf8'), 'readonly mailboxCapacity?: number;');
    const prose = jsDoc.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');

    expect(callSiteCountIn(prose)).toBe(callersInSource().length);
    expect(prose).toContain('#1431');
  });

  test("ActorCell._createMailbox's account of the door names the same callers", () => {
    const jsDoc = jsDocAbove(readFileSync(ACTOR_CELL_SOURCE, 'utf8'), 'private _createMailbox(');
    const paragraph = paragraphFrom(jsDoc, 'One class of envelope is out of every policy');
    // From the sentence that lists them on: before it the paragraph names the
    // door's own target, `Mailbox.enqueueSignal`, which calls nothing.
    const listed = paragraph.indexOf('senders use that door');
    expect(listed).toBeGreaterThan(-1);
    const passage = paragraph.slice(listed);
    const callers = callersInSource();

    expect(callersNamedIn(passage)).toEqual(callers);
    expect(callSiteCountIn(passage)).toBe(callers.length);
  });
});
