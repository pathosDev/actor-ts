import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { DEFAULT_HTTP_BIND_HOST } from '../../../src/http/Constants.js';

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
 * line or an environment variable is not flagged: that is *configuration*, and
 * an example whose whole point is to be reachable from a pod
 * (`examples/management/k8s-probes.ts`) is entitled to it.  What is never
 * entitled is a wildcard baked into a snippet whose readers will paste it.
 *
 * **`system.http(port)` with no host used to be a third form worth flagging,
 * and is not any more.**  This header once called it configuration, which it
 * was not — `ActorSystem.http` resolved a missing host to `0.0.0.0`, so the
 * bare call published the server on every interface and only hid that from
 * the reader.  #1408 changed the default to loopback, so the bare form is now
 * the safe one and flagging it would be a false positive.
 *
 * What replaces the check is the fact it was standing in for: this suite
 * asserts {@link DEFAULT_HTTP_BIND_HOST} is not a wildcard.  A guard over
 * call shapes could only ever police `examples/`; the default is what decides
 * for every caller, and pinning it here is what keeps the two from drifting
 * apart again.
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
 * `.http('<host>'` — a wildcard passed positionally.
 *
 * Found by widening this guard rather than reasoned about in advance:
 * `HttpServerOptions.ts` carried `system.http('0.0.0.0', 8080)` in a JSDoc
 * snippet, which slipped past both original patterns because it is neither
 * `newServerAt(` nor a `host:` property — and which does not compile either,
 * since the port is the first parameter.  Unlike {@link BARE_HTTP_CALL} this
 * one applies to documentation too: an explicit wildcard is a wildcard
 * wherever it is written.
 */
const HTTP_POSITIONAL_HOST = /\.http\(\s*(['"])([^'"]*)\1/g;

/**
 * Files allowed to bind a wildcard, each for a reason about that file.
 *
 * A named list rather than a rule: "an example that has to be reachable from
 * outside the pod" is not something a regular expression can recognise, and
 * the previous attempt to express it as one — exempting a whole call form —
 * exempted every future example along with it.
 */
const ENTITLED_TO_A_WILDCARD: ReadonlyMap<string, string> = new Map([
  [
    'examples/management/k8s-probes.ts',
    'liveness and readiness probes are dialled by the kubelet from outside the '
    + "pod's network namespace, so a loopback bind would make the example not work",
  ],
]);

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

/**
 * The inverse of {@link blankComments}: `source` reduced to the text of its
 * **block comments**, everything else blanked, character for character so
 * line numbers still line up.
 *
 * The `*` characters inside a block go too, which is what turns the gutter of
 * a JSDoc snippet (` *     await http.newServerAt('…', 8080)`) back into the
 * code line it is meant to be read as.  Neither bind pattern contains a `*`,
 * so losing them from prose costs nothing.
 *
 * This is the scan a doc comment needs and the example scan cannot give it:
 * `blankComments` exists because in an example the comments are commentary,
 * whereas in `src/` a `@example`-style snippet is the copy-paste surface —
 * the text an editor shows on hover, which is to say guidance at the point of
 * decision, the same reasoning `TlsVerificationGuidance.test.ts` is built on.
 */
function documentationText(source: string): string {
  const out: string[] = source.split('').map((character) => (character === '\n' ? '\n' : ' '));
  for (const match of source.matchAll(/\/\*[\s\S]*?\*\//g)) {
    const block = match[0];
    for (let offset = 0; offset < block.length; offset += 1) {
      const character = block[offset]!;
      out[match.index + offset] = character === '*' ? ' ' : character;
    }
  }
  return out.join('');
}

type WildcardBind = { readonly file: string; readonly line: number; readonly host: string };

function findWildcardBindsIn(file: string, code: string): WildcardBind[] {
  const lineOfOffset = (offset: number): number => code.slice(0, offset).split('\n').length;
  const found: WildcardBind[] = [];
  for (const pattern of [NEW_SERVER_AT, HOST_PROPERTY, HTTP_POSITIONAL_HOST]) {
    pattern.lastIndex = 0;
    for (const match of code.matchAll(pattern)) {
      const host = match[2] ?? '';
      if (!WILDCARD_HOSTS.has(host.trim())) continue;
      found.push({ file, line: lineOfOffset(match.index), host });
    }
  }
  return found;
}

const findWildcardBinds = (file: string, source: string): WildcardBind[] =>
  findWildcardBindsIn(file, blankComments(source));

const findDocumentedWildcardBinds = (file: string, source: string): WildcardBind[] =>
  findWildcardBindsIn(file, documentationText(source));

/** Every `.ts` the library itself ships. */
function librarySources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      librarySources(full, found);
      continue;
    }
    if (entry.name.endsWith('.ts')) found.push(full);
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

  test('no example binds a wildcard address, by literal or by default', () => {
    const violations = files.flatMap((file) => {
      const label = relative(REPOSITORY_ROOT, file).split('\\').join('/');
      if (ENTITLED_TO_A_WILDCARD.has(label)) return [];
      return findWildcardBinds(label, readFileSync(file, 'utf8'));
    });
    expect(violations).toEqual([]);
  });

  test('every entitled file still exists and still binds a wildcard', () => {
    // An allow-list nobody prunes turns into a list of files that moved away.
    // Both directions are checked: the path resolves, and the entry is still
    // earning its place rather than quietly covering a file that stopped
    // needing it.
    for (const [label, reason] of ENTITLED_TO_A_WILDCARD) {
      const full = join(REPOSITORY_ROOT, label);
      expect(existsSync(full), `${label} is allow-listed and does not exist`).toBe(true);
      expect(reason.length, `${label} is allow-listed without a reason`).toBeGreaterThan(40);
      expect(
        findWildcardBinds(label, readFileSync(full, 'utf8')).length,
        `${label} no longer binds a wildcard — remove it from the allow-list`,
      ).toBeGreaterThan(0);
    }
  });

  test('the default the bare call inherits is not a wildcard', () => {
    // The assertion the removed call-shape check was a proxy for.  `system
    // .http(8080)` is safe exactly while this constant is, and this is the
    // only place the two are stated together.
    expect(WILDCARD_HOSTS.has(DEFAULT_HTTP_BIND_HOST)).toBe(false);
    expect(findWildcardBinds('probe.ts', 'await system.http(8080).bind(routes);')).toEqual([]);
  });

  test('a positional wildcard is caught on both surfaces', () => {
    // Each surface gets the shape it actually scans: the example scan blanks
    // comments and reads code, the documentation scan does the reverse.
    const asCode = "await system.http('0.0.0.0', 8080).bind(r);";
    const asDoc = "/** await system.http('0.0.0.0', 8080).bind(r); */";
    expect(findWildcardBinds('probe.ts', asCode).length).toBeGreaterThan(0);
    expect(findDocumentedWildcardBinds('probe.ts', asDoc).length).toBeGreaterThan(0);

    // A host that is actually given stays clean — including the loopback form
    // the rest of the tree uses, which must not become a finding.
    expect(findWildcardBinds('probe.ts', "await system.http(8080, { host: '127.0.0.1' }).bind(r);"))
      .toEqual([]);
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

/**
 * The same invariant one scan root over: **no doc-comment snippet in `src/`
 * hard-codes a wildcard bind either**.
 *
 * `websocket()`'s JSDoc is the case that made this necessary.  It carries the
 * one-line usage snippet a developer reads before any example — it is what an
 * editor puts on the screen the moment the directive is typed — and it bound
 * `0.0.0.0` until #756.  The guard written in the same commit could not see
 * it twice over: it scanned `examples/` only, and it blanks comments before
 * matching, so widening the root alone would still have read past it.
 *
 * Comments are commentary in an example and a **surface** in the library, and
 * that is the whole of why the two halves scan opposite halves of a file.
 * `blankComments` keeps `examples/devtools.ts`'s prose mention of `0.0.0.0`
 * from being flagged; {@link documentationText} exists so that a snippet in a
 * doc comment is read as the code a reader will paste.
 *
 * The narrowness carries over unchanged: this looks for the same two
 * literals, so a documented host that comes from a variable or an expression
 * is not flagged.  `ActorSystem.http`'s JSDoc is the live example — it
 * documents `newServerAt(host ?? '0.0.0.0', port)`, which is the framework's
 * own resolved default rather than a value a reader would paste, and is not a
 * match for either pattern.
 */
describe('src/ documented bind addresses (#756)', () => {
  const files = librarySources(join(REPOSITORY_ROOT, 'src'));

  test('the scanner reads the library tree it claims to', () => {
    expect(files.length).toBeGreaterThan(400);
    // A guard that quietly stopped extracting documentation would satisfy the
    // invariant below by reading nothing.  Deliberately independent of the
    // host in any snippet: the assertion is that doc comments are reached and
    // that a bind call inside one is matched at all, so it does not become a
    // second copy of the invariant it is guarding.
    const documented = files.flatMap((file) => {
      NEW_SERVER_AT.lastIndex = 0;
      return [...documentationText(readFileSync(file, 'utf8')).matchAll(NEW_SERVER_AT)];
    });
    expect(documented.length).toBeGreaterThanOrEqual(1);
  });

  test('no doc comment hard-codes a wildcard bind address', () => {
    const violations = files.flatMap((file) => {
      const label = relative(REPOSITORY_ROOT, file).split('\\').join('/');
      return findDocumentedWildcardBinds(label, readFileSync(file, 'utf8'));
    });
    expect(violations).toEqual([]);
  });

  test('the documentation scanner reads the comment and skips the code, which is the other half', () => {
    // A snippet in a doc comment is what this half is for.
    const snippet = [
      '/**',
      ' * Turns a server actor into an endpoint.',
      ' *',
      " *     await http.newServerAt('0.0.0.0', 8080).bind(websocket('/ws', server));",
      ' */',
      'export function websocket(): Route { return route; }',
    ].join('\n');
    expect(findDocumentedWildcardBinds('probe.ts', snippet).map((bind) => bind.host)).toEqual(['0.0.0.0']);
    expect(findDocumentedWildcardBinds('probe.ts', snippet)[0]!.line).toBe(4);
    // Executable code is the examples half's subject, not this one's — the
    // two scans partition a file rather than overlapping on it.
    const code = "await http.newServerAt('0.0.0.0', 8080).bind(routes);";
    expect(findDocumentedWildcardBinds('probe.ts', code)).toEqual([]);
    // A line comment is not a snippet surface: an editor shows a JSDoc block
    // on hover and shows a `//` note to nobody.
    expect(findDocumentedWildcardBinds('probe.ts', "// newServerAt('0.0.0.0', 8080)")).toEqual([]);
    // And a documented loopback bind is what the tree is supposed to contain.
    const safe = ["/**", " *     await http.newServerAt('127.0.0.1', 8080).bind(routes);", ' */'].join('\n');
    expect(findDocumentedWildcardBinds('probe.ts', safe)).toEqual([]);
  });
});
