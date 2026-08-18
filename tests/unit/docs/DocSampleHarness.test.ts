import { describe, expect, test } from 'bun:test';
import {
  actorTsVocabulary,
  bindingsOf,
  carriedDeclarations,
  carriedNames,
  classify,
  classifyDiagnostics,
  continuityPrologue,
  exportsPaths,
  fencesOfSource,
  importStatementFor,
  importsOf,
  isSyntaxError,
  isUnresolvedName,
  namesFromImportClause,
  namesFromPattern,
  pageLineOf,
  parseArguments,
  parseDiagnostics,
  unresolvedNameOf,
  verdictOf,
  PROLOGUE_LINES,
  type CompiledFence,
  type Diagnostic,
  type Fence,
} from '../../../scripts/check-doc-samples.mjs';

/**
 * The doc-sample harness is a classifier, and it had no test (#470).
 *
 * `scripts/check-doc-samples.mjs` decides three things that all look the same
 * from outside — which fences are programs, what a fence is allowed to assume
 * from the page around it, and which of its diagnostics are worth a reader's
 * time — and every one of them can be wrong in a way indistinguishable from a
 * clean run:
 *
 *  - miss that a grammar error suppresses TypeScript's whole semantic pass and
 *    the script reports four syntax errors while hiding two hundred real ones,
 *    which is exactly the state it shipped in;
 *  - get the prologue's line count wrong and every diagnostic points one line
 *    off, at a line the author did not write;
 *  - leak the continuity declarations across files and page B's fence passes on
 *    page A's names;
 *  - call a missing import a prose placeholder and the one category worth
 *    fixing disappears into the one that is tolerated.
 *
 * This file covers the pure half. The compile half is covered end-to-end by
 * `tests/unit/docs/DocSampleHarnessEndToEnd.test.ts`, which drives the real
 * script over a fixture tree — a stubbed `tsc` would let a broken two-pass
 * compile pass its own test.
 */

const fenceOf = (body: string, info = 'ts', file = 'page.mdx', bodyStart = 1): Fence => ({
  file,
  info,
  language: info.split(/[\s{]/)[0]?.toLowerCase() ?? '',
  bodyStart,
  body: body.split('\n'),
});

describe('fence extraction', () => {
  test('a shorter fence nested in a longer one closes with the longer marker', () => {
    const page = [
      '````mdx',
      '```ts',
      "import { ActorSystem } from 'actor-ts';",
      '```',
      '````',
      '```ts',
      "import { Actor } from 'actor-ts';",
      '```',
    ].join('\n');
    const fences = fencesOfSource(page, 'page.mdx');
    expect(fences.map((fence) => fence.language)).toEqual(['mdx', 'ts']);
    expect(fences[1]?.bodyStart).toBe(7);
  });

  test('bodyStart is the 1-based page line of the first body line', () => {
    const fences = fencesOfSource(['intro', '', '```ts', 'const x = 1;', '```'].join('\n'), 'page.mdx');
    expect(fences[0]?.bodyStart).toBe(4);
  });
});

describe('fence classification', () => {
  test('no import is a fragment, whatever else it contains', () => {
    const { fragments, compiled } = classify([fenceOf('const x = 1;\nx.toFixed(2);')]);
    expect(fragments).toHaveLength(1);
    expect(compiled).toHaveLength(0);
  });

  test('a class-member body is a fragment even with an import', () => {
    const source = ["import { Actor } from 'actor-ts';", 'private readonly buffered: number[] = [];'].join('\n');
    expect(classify([fenceOf(source)]).fragments).toHaveLength(1);
  });

  test('an elision inside a type argument list is caught', () => {
    const source = ["import { Actor } from 'actor-ts';", 'class Worker extends Actor<...> {}'].join('\n');
    expect(classify([fenceOf(source)]).elided).toHaveLength(1);
  });

  test('a spread is not an elision', () => {
    const source = ["import { Actor } from 'actor-ts';", 'const merged = { ...base, kind: 1 };'].join('\n');
    expect(classify([fenceOf(source)]).compiled).toHaveLength(1);
  });

  test('a comment standing in for an arrow body is an elision', () => {
    // Never anything else: a comment is not an expression, so this cannot parse
    // under any reading — and unmarked it used to take the whole program's
    // semantic pass down with it.
    const source = [
      "import { get } from 'actor-ts/http';",
      'const routes = get(async (request) => /* expensive lookup */);',
    ].join('\n');
    expect(classify([fenceOf(source)]).elided).toHaveLength(1);
  });

  test('a comment that is not an arrow body leaves the fence compilable', () => {
    const source = [
      "import { Actor } from 'actor-ts';",
      'const handler = async (request) => /* not the body */ request.url;',
    ].join('\n');
    expect(classify([fenceOf(source)]).compiled).toHaveLength(1);
  });

  test('no-compile exempts the fence and keeps its reason', () => {
    const source = "import { Actor } from 'actor-ts';\nconst a = 1;";
    const { exempt } = classify([fenceOf(source, 'ts no-compile — needs @opentelemetry/api')]);
    expect(exempt).toHaveLength(1);
    expect(exempt[0]?.reason).toBe('needs @opentelemetry/api');
  });

  test('a no-compile fence with no reason is still exempt', () => {
    const { exempt } = classify([fenceOf("import { Actor } from 'actor-ts';", 'ts no-compile')]);
    expect(exempt[0]?.reason).toBe('');
  });
});

describe('binding extraction', () => {
  test('every import form contributes the name it actually binds', () => {
    const bindings = bindingsOf([
      "import Fastify from 'fastify';",
      "import * as path from 'node:path';",
      "import { ActorSystem, Actor as Base } from 'actor-ts';",
      "import type { ActorRef } from 'actor-ts';",
      "import { type Command, jsonCodec as codec } from 'actor-ts/http';",
    ].join('\n'));
    expect([...bindings].sort()).toEqual(
      ['ActorRef', 'ActorSystem', 'Base', 'Command', 'Fastify', 'codec', 'path'],
    );
  });

  test('an aliased import binds the alias, never the original', () => {
    // A prologue that re-declared the original would collide with nothing and
    // still leave the name the fence actually uses unresolved.
    const bindings = bindingsOf("import { jsonCodec as codec } from 'actor-ts/http';");
    expect(bindings.has('codec')).toBe(true);
    expect(bindings.has('jsonCodec')).toBe(false);
  });

  test('a multi-line import clause is one statement', () => {
    const bindings = bindingsOf(['import {', '  ActorSystem,', '  Actor,', "} from 'actor-ts';"].join('\n'));
    expect([...bindings].sort()).toEqual(['Actor', 'ActorSystem']);
  });

  test('declaration keywords bind their name', () => {
    const bindings = bindingsOf([
      'const system = 1;',
      'let counter = 0;',
      'var legacy = 0;',
      'function handle() {}',
      'async function start() {}',
      'class Worker {}',
      'abstract class Base {}',
      'interface Greeting {}',
      'type Command = string;',
      'enum Colour {}',
      'const enum Flag {}',
      'export const exported = 1;',
      'export default class Shipped {}',
    ].join('\n'));
    expect([...bindings].sort()).toEqual([
      'Base', 'Colour', 'Command', 'Flag', 'Greeting', 'Shipped', 'Worker',
      'counter', 'exported', 'handle', 'legacy', 'start', 'system',
    ]);
  });

  test('an indented declaration is not a top-level binding', () => {
    // It belongs to a block, so a later fence has no claim on it.
    expect([...bindingsOf('function main() {\n  const inner = 1;\n}')]).toEqual(['main']);
  });

  test('a destructuring pattern binds the local, not the key', () => {
    expect(namesFromPattern('{ store, maxEntries: cap, retentionMs = 0 }').sort())
      .toEqual(['cap', 'retentionMs', 'store']);
    expect([...bindingsOf('const { store, maxEntries: cap } = options;')].sort()).toEqual(['cap', 'store']);
    expect([...bindingsOf('const [first, second] = pair;')].sort()).toEqual(['first', 'second']);
  });

  test('namesFromImportClause tolerates a bare clause with no braces', () => {
    expect(namesFromImportClause('Fastify')).toEqual(['Fastify']);
    expect(namesFromImportClause('Fastify, { fastifyStatic }').sort()).toEqual(['Fastify', 'fastifyStatic']);
  });
});

describe('page continuity', () => {
  const page = [
    fenceOf("import { InMemoryCache } from 'actor-ts/cache';\nconst cache = new InMemoryCache();", 'ts', 'p.mdx', 10),
    fenceOf('cache.set("k", 1);', 'ts', 'p.mdx', 20),
    fenceOf("import { CacheExtensionId } from 'actor-ts/cache';\nconst other = cache;", 'ts', 'p.mdx', 30),
  ];

  test('a later fence carries the earlier fences names, in order', () => {
    const carried = carriedNames(page);
    expect(carried.get(page[0]!)).toEqual([]);
    expect(carried.get(page[1]!)).toEqual(['InMemoryCache', 'cache']);
    expect(carried.get(page[2]!)).toEqual(['InMemoryCache', 'cache']);
  });

  test('a fence never carries a name it binds itself', () => {
    // Otherwise the prologue and the fence declare the same identifier and the
    // fence fails on a duplicate the author never wrote.
    const own = [
      fenceOf("import { InMemoryCache } from 'actor-ts/cache';\nconst cache = new InMemoryCache();", 'ts', 'p.mdx', 10),
      fenceOf("import { InMemoryCache } from 'actor-ts/cache';\nconst cache = new InMemoryCache();", 'ts', 'p.mdx', 20),
    ];
    expect(carriedNames(own).get(own[1]!)).toEqual([]);
  });

  test('an earlier fence cannot carry a later fence name', () => {
    expect(carriedNames(page).get(page[0]!)).not.toContain('other');
  });

  test('an opaque carried name is declared as both a value and a type', () => {
    // A carried name is used in both positions across the corpus — `cache.set(…)`
    // and `const greeting: Greeting` — and one declaration has to satisfy either.
    const prologue = continuityPrologue(['cache']);
    expect(prologue).toContain('declare var cache: any;');
    expect(prologue).toContain('type cache = any;');
  });

  test('the prologue is exactly one line whether or not anything is carried', () => {
    // The whole re-basing arithmetic rests on this being constant.
    expect(continuityPrologue([]).split('\n')).toHaveLength(PROLOGUE_LINES);
    expect(continuityPrologue(['a', 'b', 'c']).split('\n')).toHaveLength(PROLOGUE_LINES);
    expect(PROLOGUE_LINES).toBe(1);
  });

  test('the empty prologue declares nothing', () => {
    expect(continuityPrologue([])).not.toContain('declare');
    expect(continuityPrologue({ imports: [], opaque: [] })).not.toContain('declare');
  });
});

describe('carried imports keep their real type', () => {
  test('only specifiers this program can resolve are recorded', () => {
    // Re-emitting an `ioredis` import would put a TS2307 on the prologue line,
    // which is an error on a line no author wrote.
    const imports = importsOf([
      "import { ActorSystem } from 'actor-ts';",
      "import { readFileSync } from 'node:fs';",
      "import Redis from 'ioredis';",
      "import Fastify from 'fastify';",
    ].join('\n'));
    expect([...imports.keys()].sort()).toEqual(['ActorSystem', 'readFileSync']);
  });

  test('each specifier is recorded with the shape needed to rebuild it alone', () => {
    const imports = importsOf([
      "import { ActorSystem, Actor as Base } from 'actor-ts';",
      "import type { ActorRef } from 'actor-ts';",
      "import * as path from 'node:path';",
      "import { type Command } from 'actor-ts/http';",
    ].join('\n'));
    expect(importStatementFor(imports.get('ActorSystem')!)).toBe("import { ActorSystem } from 'actor-ts';");
    expect(importStatementFor(imports.get('Base')!)).toBe("import { Actor as Base } from 'actor-ts';");
    expect(importStatementFor(imports.get('ActorRef')!)).toBe("import type { ActorRef } from 'actor-ts';");
    expect(importStatementFor(imports.get('path')!)).toBe("import * as path from 'node:path';");
    expect(importStatementFor(imports.get('Command')!)).toBe("import type { Command } from 'actor-ts/http';");
  });

  test('one specifier is rebuilt at a time, not the whole statement', () => {
    // A fence carrying `A` from `import { A, B }` while binding its own `B`
    // would collide on `B` if the statement were re-emitted verbatim.
    const page = [
      fenceOf("import { ActorSystem, Actor } from 'actor-ts';\nconst first = 1;", 'ts', 'p.mdx', 10),
      fenceOf("import { Actor } from 'actor-ts';\nclass Own extends Actor {}", 'ts', 'p.mdx', 20),
    ];
    const carried = carriedDeclarations(page).get(page[1]!)!;
    expect(carried.imports.map((binding) => binding.local)).toEqual(['ActorSystem']);
    expect(continuityPrologue(carried)).not.toContain('Actor }');
  });

  test('an imported name is re-imported and a computed one is not', () => {
    const page = [
      fenceOf("import { InMemoryCache } from 'actor-ts/cache';\nconst cache = new InMemoryCache();", 'ts', 'p.mdx', 10),
      fenceOf("import { CacheExtensionId } from 'actor-ts/cache';\ncache.set('k', 1);", 'ts', 'p.mdx', 20),
    ];
    const carried = carriedDeclarations(page).get(page[1]!)!;
    expect(carried.imports.map((binding) => binding.local)).toEqual(['InMemoryCache']);
    expect(carried.opaque).toEqual(['cache']);
    const prologue = continuityPrologue(carried);
    expect(prologue).toContain("import { InMemoryCache } from 'actor-ts/cache';");
    expect(prologue).toContain('declare var cache: any;');
  });

  test('a name carried from a specifier nothing can resolve stays opaque', () => {
    const page = [
      fenceOf("import Redis from 'ioredis';\nconst client = new Redis();", 'ts', 'p.mdx', 10),
      fenceOf("import { InMemoryCache } from 'actor-ts/cache';\nclient.get('k');", 'ts', 'p.mdx', 20),
    ];
    const carried = carriedDeclarations(page).get(page[1]!)!;
    expect(carried.imports).toEqual([]);
    expect([...carried.opaque].sort()).toEqual(['Redis', 'client']);
  });

  test('a name is never both re-imported and declared', () => {
    // It was a computed `const` on one fence and an import on the next; carrying
    // both would declare the same identifier twice.
    const page = [
      fenceOf("import { InMemoryCache } from 'actor-ts/cache';\nconst codec = build();", 'ts', 'p.mdx', 10),
      fenceOf("import { jsonCodec as codec } from 'actor-ts/http';\ncodec.decode('{}');", 'ts', 'p.mdx', 20),
      fenceOf("import { InMemoryCache } from 'actor-ts/cache';\ncodec.decode('{}');", 'ts', 'p.mdx', 30),
    ];
    const carried = carriedDeclarations(page).get(page[2]!)!;
    expect(carried.imports.map((binding) => binding.local)).toEqual(['codec']);
    expect(carried.opaque).not.toContain('codec');
  });
});

describe('line re-basing', () => {
  test('generated line 2 is the fence first body line', () => {
    expect(pageLineOf({ bodyStart: 11 }, 2)).toBe(11);
    expect(pageLineOf({ bodyStart: 11 }, 5)).toBe(14);
  });

  test('a diagnostic in the prologue is not re-based onto a page line', () => {
    const fence = { file: 'p.mdx', info: 'ts', language: 'ts', bodyStart: 11, body: [], source: '' };
    const emitted = new Map<string, CompiledFence>([['a--L11.ts', fence]]);
    const [diagnostic] = parseDiagnostics(
      "a--L11.ts(1,9): error TS2300: Duplicate identifier 'cache'.",
      emitted,
      () => 'page.mdx',
    );
    expect(diagnostic?.line).toBeNull();
    expect(diagnostic?.where).toContain('continuity prologue');
  });

  test('a body diagnostic reports the real page line and column', () => {
    const fence = { file: 'p.mdx', info: 'ts', language: 'ts', bodyStart: 11, body: [], source: '' };
    const emitted = new Map<string, CompiledFence>([['a--L11.ts', fence]]);
    const [diagnostic] = parseDiagnostics(
      "a--L11.ts(4,17): error TS2339: Property 'spwan' does not exist.",
      emitted,
      () => 'docs/page.mdx',
    );
    expect(diagnostic?.line).toBe(13);
    expect(diagnostic?.where).toBe('docs/page.mdx:13:17');
    expect(diagnostic?.code).toBe('TS2339');
  });

  test('a diagnostic for a file the harness did not emit is kept, not dropped', () => {
    const [diagnostic] = parseDiagnostics(
      'tsconfig.json(3,5): error TS5102: Option baseUrl has been removed.',
      new Map(),
      () => '',
    );
    expect(diagnostic?.code).toBe('TS5102');
    expect(diagnostic?.fence).toBeUndefined();
  });
});

describe('diagnostic banding', () => {
  test('every TS1xxx is a grammar error and nothing else is', () => {
    // This is what decides whether the second compile pass happens at all, and
    // a wrong answer here is what let four fences hide two hundred. TS1108 is in
    // the band on purpose even though it suppresses nothing — see isSyntaxError.
    for (const code of ['TS1005', 'TS1109', 'TS1128', 'TS1108', 'TS1435']) {
      expect(isSyntaxError(code)).toBe(true);
    }
    for (const code of ['TS2304', 'TS2307', 'TS2345', 'TS7006', 'TS18046']) expect(isSyntaxError(code)).toBe(false);
  });

  test('only the two cannot-find-name codes count as unresolved', () => {
    expect(isUnresolvedName('TS2304')).toBe(true);
    expect(isUnresolvedName('TS2552')).toBe(true);
    expect(isUnresolvedName('TS2305')).toBe(false);
    expect(isUnresolvedName('TS2339')).toBe(false);
  });

  test('the unresolved identifier is read out of the message', () => {
    expect(unresolvedNameOf("Cannot find name 'system'.")).toBe('system');
    expect(unresolvedNameOf("Cannot find name 'jsonCodec'. Did you mean 'jsonCodecs'?")).toBe('jsonCodec');
    expect(unresolvedNameOf("Property 'spwan' does not exist.")).toBeNull();
  });
});

describe('the vocabulary discriminator', () => {
  const vocabulary = actorTsVocabulary([
    fenceOf("import { BoundedMailbox } from 'actor-ts';\nconst m = new BoundedMailbox(1);"),
    fenceOf("import Fastify from 'fastify';\nconst app = Fastify();"),
    fenceOf("import { readFileSync } from 'node:fs';\nconst text = readFileSync('a');"),
  ]);

  test('only names imported from an actor-ts subpath are in it', () => {
    expect(vocabulary.has('BoundedMailbox')).toBe(true);
    expect(vocabulary.has('Fastify')).toBe(false);
    expect(vocabulary.has('readFileSync')).toBe(false);
  });

  test('a fence with no diagnostics is clean', () => {
    expect(verdictOf([], vocabulary)).toBe('clean');
  });

  test('unresolved names the corpus never imports read as prose', () => {
    const diagnostics = [
      { code: 'TS2304', message: "Cannot find name 'system'." },
      { code: 'TS2304', message: "Cannot find name 'appRoutes'." },
    ];
    expect(verdictOf(diagnostics, vocabulary)).toBe('prose');
  });

  test('one unresolved name the corpus does import makes it a missing import', () => {
    // The distinction the whole tolerate-TS2304 question turned on: a reader
    // copying this fence gets the same error, so it is a defect, not prose.
    const diagnostics = [
      { code: 'TS2304', message: "Cannot find name 'system'." },
      { code: 'TS2304', message: "Cannot find name 'BoundedMailbox'." },
    ];
    expect(verdictOf(diagnostics, vocabulary)).toBe('missing-import');
  });

  test('anything that is not a cannot-find-name is a real error', () => {
    expect(verdictOf([{ code: 'TS2345', message: 'Argument of type…' }], vocabulary)).toBe('real-error');
    expect(verdictOf(
      [{ code: 'TS2304', message: "Cannot find name 'system'." }, { code: 'TS2339', message: 'Property…' }],
      vocabulary,
    )).toBe('real-error');
  });
});

describe('the report', () => {
  const fence = (page: string): CompiledFence => ({
    file: page, info: 'ts', language: 'ts', bodyStart: 1, body: [], source: '', page,
  });
  const emitted = new Map<string, CompiledFence>([
    ['clean.ts', fence('clean.mdx')],
    ['prose.ts', fence('prose.mdx')],
    ['missing.ts', fence('missing.mdx')],
    ['real.ts', fence('real.mdx')],
    ['broken.ts', fence('broken.mdx')],
  ]);
  const diagnostic = (file: string, code: string, message: string): Diagnostic =>
    ({ file, code, message, generatedLine: 2, where: `${file}:2:1` });
  const syntax = [diagnostic('broken.ts', 'TS1005', "';' expected.")];
  const semantic = [
    diagnostic('prose.ts', 'TS2304', "Cannot find name 'system'."),
    diagnostic('missing.ts', 'TS2304', "Cannot find name 'ActorRef'."),
    diagnostic('real.ts', 'TS2339', "Property 'spwan' does not exist."),
    diagnostic('real.ts', 'TS2345', 'Argument of type…'),
  ];
  const report = classifyDiagnostics(emitted, syntax, semantic, new Set(['ActorRef']));

  test('each fence lands in exactly one bucket', () => {
    expect(report.clean.map((f) => f.page)).toEqual(['clean.mdx']);
    expect(report.prose.map((f) => f.page)).toEqual(['prose.mdx']);
    expect(report.missingImport.map((f) => f.page)).toEqual(['missing.mdx']);
    expect(report.realError.map((f) => f.page)).toEqual(['real.mdx']);
  });

  test('a fence excluded for a syntax error is in no semantic bucket', () => {
    // It was dropped from the program, so it has no semantic verdict to give —
    // counting it as clean is how a broken fence reads as a passing one.
    const buckets = [...report.clean, ...report.prose, ...report.missingImport, ...report.realError];
    expect(buckets.map((f) => f.page)).not.toContain('broken.mdx');
    expect(report.syntaxFiles.has('broken.ts')).toBe(true);
  });

  test('only missing imports and real errors are reported as failures', () => {
    expect(report.reported.map((d) => d.file).sort()).toEqual(['missing.ts', 'real.ts', 'real.ts']);
  });

  test('codes count fences, not diagnostics', () => {
    // Two TS2339 on one page is one fence to fix, and a per-diagnostic count
    // would make a chatty page look like a wide problem.
    expect(report.codes.get('TS2339')).toBe(1);
    expect(report.codes.get('TS2345')).toBe(1);
    expect(report.codes.get('TS2304')).toBe(1);
  });

  test('prose placeholders are tallied so a missing import cannot hide among them', () => {
    expect(report.placeholders.get('system')).toBe(1);
    expect(report.placeholders.has('ActorRef')).toBe(false);
  });
});

describe('the exports-derived paths map', () => {
  const manifest = {
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './cache': { types: './dist/cache/index.d.ts' },
      './package.json': './package.json',
      './no-types': { import: './dist/x.js' },
    },
  };

  test('each published subpath maps to the src file its types condition names', () => {
    // Derived, never hand-written: a hand-written map would drift from the
    // export surface exactly the way the docs did, and then certify the drift.
    expect(exportsPaths(manifest)).toEqual({
      'actor-ts': ['../src/index.ts'],
      'actor-ts/cache': ['../src/cache/index.ts'],
    });
  });

  test('the hop back to the root is a parameter, not a hardcoded one level', () => {
    // Getting it wrong turns every specifier into TS2307 at once, which reads
    // as "the whole public API is missing" rather than as a bad output path.
    expect(exportsPaths(manifest, '../..')['actor-ts/cache']).toEqual(['../../src/cache/index.ts']);
  });
});

describe('argument parsing', () => {
  test('the tree under test and the output directory are both overridable', () => {
    const options = parseArguments(['--docs=tests/fixtures/docs', '--out=.doc-samples-fixture', '--report']);
    expect(options.docs).toBe('tests/fixtures/docs');
    expect(options.out).toBe('.doc-samples-fixture');
    expect(options.reportOnly).toBe(true);
    expect(options.measureOnly).toBe(false);
  });

  test('the defaults are the real documentation tree', () => {
    const options = parseArguments([]);
    expect(options.docs).toContain('docs');
    expect(options.out).toBe('.doc-samples');
    expect(options.keepOutput).toBe(false);
  });
});
