import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * The runbook quotes log lines the framework writes (#992 follow-up).
 *
 * The troubleshooting page told an operator to grep for
 * `"discovered N seeds: ..."` and for `"coordinator: allocating shard X to
 * node-Y"`, and showed `[INFO ] cluster — node-X marked unreachable` as what a
 * flapping cluster logs.  None of those strings exists anywhere in `src/`, so
 * the grep a reader ran came back empty and read as "this is not the
 * problem".
 *
 * A log excerpt on the page is now a fence titled `log`
 * (```` ```text title="log" ````), and every line in one has to match a single
 * source line under `src/`: the line's literal text in order, with each
 * placeholder (`<n>`, `<address>`, `…`) standing for anything on that same
 * source line — which is where a template literal's `${…}` sits.  Matching
 * literal fragments one by one was tried first and was not enough:
 * `discovered <n> seeds: …` passed, because "discovered" and "seeds:" each
 * occur somewhere in `src/`.  String concatenation is undone first
 * (`'a ' + 'b'` across a line break reads as `'a b'`), so a message built
 * with `+` still matches; the excerpt then has to stop where a source line
 * does or continue across a join.
 *
 * What this cannot see: a log line quoted outside such a fence, or a source
 * line that matches in a comment rather than in a message.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const DOCUMENTATION_ROOT = join(REPOSITORY_ROOT, 'docs', 'src', 'content', 'docs');

const PAGES = ['operations/troubleshooting.mdx', 'de/operations/troubleshooting.mdx'] as const;

function readNormalised(path: string): string {
  return readFileSync(path, 'utf8').split(/\r?\n/).join('\n');
}

function sourceTextUnder(directory: string): string {
  let out = '';
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out += sourceTextUnder(path);
    else if (entry.name.endsWith('.ts')) out += `${readNormalised(path)}\n`;
  }
  // Undo `'…' + '…'` / `` `…` + `…` `` joins, the way a message is built
  // across lines, so the two halves read as one line.
  return out.replace(/['`"]\s*\n?\s*\+\s*\n?\s*['`"]/g, '');
}

function logFences(text: string): string[] {
  return [...text.matchAll(/^```text title="log"\n([\s\S]*?)^```/gm)].map((m) => m[1]!);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The excerpt line as a pattern over one source line. */
function patternOf(line: string): RegExp {
  const literal = line.split(/<[^>]*>|…/).map(escapeRegExp).join('[^\\n]*?');
  return new RegExp(literal);
}

/**
 * No message the framework logs is anywhere near this long; a line past it is
 * generated, and the one that exists is `src/devtools/generated/UiAssets.ts`'s
 * embedded bundle, a single line of about 258 000 characters.
 *
 * The matching is per line for the same reason.  Run over the whole of `src/`
 * as one string, an unanchored pattern with several `[^\n]*?` gaps scans from
 * every occurrence of its first literal to the end of that line, and on the
 * bundle line that is quadratic: one second on a fast development machine,
 * 42–70 s per test on a CI runner, against bun's 5 s cap.
 */
const MAX_SOURCE_LINE_LENGTH = 2_000;

function sourceLinesUnder(directory: string): string[] {
  return sourceTextUnder(directory)
    .split('\n')
    .filter((line) => line.length <= MAX_SOURCE_LINE_LENGTH);
}

describe('troubleshooting log excerpts', () => {
  const sourceLines = sourceLinesUnder(join(REPOSITORY_ROOT, 'src'));

  for (const page of PAGES) {
    const text = readNormalised(join(DOCUMENTATION_ROOT, page));

    test(`${page}: the excerpts exist`, () => {
      // Not vacuous: the cluster-formation and flapping excerpts.
      expect(logFences(text).length).toBeGreaterThanOrEqual(2);
    });

    test(`${page}: every excerpt line matches a line src/ writes`, () => {
      const lines = logFences(text).flatMap((fence) => fence.split('\n')).filter((line) => line.trim() !== '');
      const unmatched = lines.filter((line) => {
        const pattern = patternOf(line);
        return !sourceLines.some((sourceLine) => pattern.test(sourceLine));
      });
      expect(unmatched).toEqual([]);
    });
  }
});
