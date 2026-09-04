import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * A repo-wide invariant over `examples/`: **no example hard-codes a wildcard
 * bind address**.
 *
 * `examples/io/websocket-server.ts` bound `0.0.0.0` and was the sole outlier —
 * every other HTTP example in the tree binds `127.0.0.1` — while also being
 * the file the WebSocket documentation points at as the runnable server demo.
 * So the outlier was simultaneously the template: running it put an
 * unauthenticated broadcast relay on every interface of a developer's laptop
 * or an unpolicied container, and copying it propagated that (#756).  Fixing
 * the one file fixes one file; this is what keeps the next one from arriving.
 *
 * **Deliberately narrow: it looks for a literal, not for a policy.**  Two
 * forms are checked, and they are the only two the tree uses to say "bind
 * here" — `newServerAt('<host>', port)` and the `host: '<host>'` property of
 * `system.http(port, { … })`.  A host that comes from a variable, a command
 * line or an environment variable is not flagged, and neither is
 * `system.http(port)` with no host at all: those are *configuration*, and an
 * example whose whole point is to be reachable from a pod
 * (`examples/management/k8s-probes.ts`) is entitled to them.  What is never
 * entitled is a wildcard baked into a snippet whose readers will paste it.
 *
 * `examples/devtools.ts` is the proof that the narrowness is load-bearing
 * rather than a shortcut: it mentions `0.0.0.0` twice, in a comment and in
 * `if (host === '0.0.0.0')` — a branch that rewrites a wildcard host to
 * loopback for a printed link, i.e. the repository already treating a wildcard
 * as something to correct.  A grep-for-the-string guard would flag both.
 *
 * Sibling repo-file guards: `tests/unit/ci/WorkflowHygiene.test.ts`,
 * `tests/unit/ci/SleepRatchet.test.ts`,
 * `tests/unit/config/NoDeadConfigKeys.test.ts`.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const EXAMPLES_DIRECTORY = join(REPOSITORY_ROOT, 'examples');

/**
 * Addresses that mean "every interface".  The empty string is included
 * because `Bun.serve` and `node:net` both read it that way, and `*` because a
 * reader who wrote it meant the same thing whether or not the runtime agrees.
 */
const WILDCARD_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '::', '[::]', '*', '']);

/** `newServerAt('<host>'` — the extension's own bind entry point. */
const NEW_SERVER_AT = /newServerAt\(\s*(['"])([^'"]*)\1/g;
/** `host: '<host>'` — the options-bag form `system.http(port, { … })` takes. */
const HOST_PROPERTY = /\bhost\s*:\s*(['"])([^'"]*)\1/g;

/**
 * `source` with every comment replaced by spaces, character for character so
 * line numbers still line up.  String literals are tracked but **kept**: the
 * host being looked for is itself a string, and the only reason to know where
 * strings are is so that the `//` in `'http://localhost'` is not mistaken for
 * the start of a comment.
 */
function blankComments(source: string): string {
  const out = source.split('');
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') { out[index] = ' '; index++; }
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] !== '\n') out[index] = ' ';
        index++;
      }
      if (index < source.length) { out[index] = ' '; out[index + 1] = ' '; index += 2; }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      index++;
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index] === quote) break;
        index++;
      }
      index++;
      continue;
    }
    index++;
  }
  return out.join('');
}

/** Every `.ts` / `.tsx` this repository wrote under `examples/`. */
function exampleSources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      // The example frontends carry their own installs; a vendor tree inside
      // the scan root would be neither ours nor bind code.
      const vendored = entry.name === 'node_modules' || entry.name === 'dist';
      if (vendored || entry.name === '.next') continue;
      exampleSources(full, found);
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(full);
  }
  return found;
}

type WildcardBind = { readonly file: string; readonly line: number; readonly host: string };

function findWildcardBinds(file: string, source: string): WildcardBind[] {
  const code = blankComments(source);
  const lineOfOffset = (offset: number): number => code.slice(0, offset).split('\n').length;
  const found: WildcardBind[] = [];
  for (const pattern of [NEW_SERVER_AT, HOST_PROPERTY]) {
    pattern.lastIndex = 0;
    for (const match of code.matchAll(pattern)) {
      const host = match[2] ?? '';
      if (!WILDCARD_HOSTS.has(host.trim())) continue;
      found.push({ file, line: lineOfOffset(match.index), host });
    }
  }
  return found;
}

describe('examples/ bind addresses (#756)', () => {
  const files = exampleSources(EXAMPLES_DIRECTORY);

  test('the scanner reads the example tree it claims to', () => {
    // A guard that quietly stopped matching would satisfy the assertion below
    // by reading nothing at all.  Both halves matter: the tree is there, and
    // the patterns still find the loopback binds that are supposed to be
    // everywhere.
    expect(files.length).toBeGreaterThan(100);
    const loopback = files.flatMap((file) => {
      const code = blankComments(readFileSync(file, 'utf8'));
      NEW_SERVER_AT.lastIndex = 0;
      HOST_PROPERTY.lastIndex = 0;
      return [...code.matchAll(NEW_SERVER_AT), ...code.matchAll(HOST_PROPERTY)]
        .filter((match) => match[2] === '127.0.0.1');
    });
    expect(loopback.length).toBeGreaterThanOrEqual(8);
  });

  test('no example hard-codes a wildcard bind address', () => {
    const violations = files.flatMap((file) => {
      const label = relative(REPOSITORY_ROOT, file).split('\\').join('/');
      return findWildcardBinds(label, readFileSync(file, 'utf8'));
    });
    expect(violations).toEqual([]);
  });

  test('the scanner discriminates a bind from a mention of the same address', () => {
    // `examples/devtools.ts` compares against `'0.0.0.0'` and names it in
    // prose; neither is a bind, and a guard that flagged them would be turned
    // off within a week.
    const mention = [
      '/** A wildcard bind (`0.0.0.0`, `::`) is not an address to link to. */',
      "function browsableUrl(host: string, port: number): string {",
      "  if (host === '0.0.0.0') return `http://127.0.0.1:${port}`;",
      '  return `http://${host}:${port}`;',
      '}',
      "await system.http(8080, { host: '127.0.0.1' }).bind(routes);",
    ].join('\n');
    expect(findWildcardBinds('probe.ts', mention)).toEqual([]);

    const bind = [
      "// This one is the defect #756 was filed for.",
      "const binding = await http.newServerAt('0.0.0.0', 3000).bind(routes);",
      "await system.http(8080, { host: '::' }).bind(routes);",
    ].join('\n');
    expect(findWildcardBinds('probe.ts', bind).map((v) => v.host)).toEqual(['0.0.0.0', '::']);
  });
});
