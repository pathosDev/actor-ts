import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * The option types an actor declares its persistence preferences with live in
 * `src/persistence/PersistenceOptions.ts`, under one name each.
 *
 * The module used to end in `export type PersistenceWriteOptions =
 * PersistenceOptions`, marked `@deprecated` and "kept as an alias so the older
 * name doesn't break downstream typings" — while the persistence barrel never
 * re-exported it.  The package's `exports` map publishes barrels only, so no
 * downstream typing could ever have named it: the alias protected nobody, and
 * it is the shape the pre-1.0 rule forbids outright (a hard cut, no alias for
 * an old name).  `PluginConfig.ts` meanwhile told its reader the types were
 * re-exported from a `PersistenceWriteOptions` module that no longer existed.
 * Both found while #1430.
 *
 * Asserted against the source text, because a type export leaves nothing
 * behind at runtime to observe.  The readers are deliberately small, and what
 * they cannot see is written down beside them rather than implied away.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

const OPTIONS_MODULE = 'src/persistence/PersistenceOptions.ts';
const OPTIONS_SPECIFIER_FROM_BARREL = './PersistenceOptions.js';
const PERSISTENCE_BARREL = 'src/persistence/index.ts';
const PLUGIN_CONFIG = 'src/persistence/object-storage/PluginConfig.ts';

/** Every type the module is known to declare — the reader below must find at least these. */
const KNOWN_OPTION_TYPES = [
  'CompressionAlgo',
  'CompressionConfig',
  'EncryptionConfig',
  'IntegrityConfig',
  'MasterKeyRing',
  'MasterKeyRingEntry',
  'PersistenceOptions',
] as const;

function read(path: string): string {
  return readFileSync(join(REPOSITORY_ROOT, path), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * The source with its comments removed, so a commented-out export is not read
 * as one.  Good for the three files read here, which carry no `//` or `/*`
 * inside a string literal; it is not a general TypeScript lexer.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

type DeclaredType = {
  readonly name: string;
  /** The one identifier the declaration repeats under a new name, if that is all it does. */
  readonly repeats: string | undefined;
};

/**
 * Every type the module declares and exports: `export type X = …` and
 * `export interface X …`.  A type alias whose whole right-hand side is one
 * identifier, and an interface that only extends one other and adds nothing,
 * report the name they repeat.
 *
 * Blind spots, on purpose: an alias dressed up as a new type —
 * `Readonly<PersistenceOptions>`, `PersistenceOptions & {}` — reads as a
 * declaration of its own, and so does a name renamed on the way in
 * (`import type { A as B }`) and exported unchanged.  Those are a review
 * question, not a pattern.
 */
function declaredTypes(source: string): DeclaredType[] {
  const code = withoutComments(source);
  const declared: DeclaredType[] = [];
  for (const [, name = '', rightHandSide = ''] of code.matchAll(
    /\bexport\s+(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^;]*?>)?\s*=\s*([^;]*);/g,
  )) {
    declared.push({ name, repeats: /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(rightHandSide)?.[1] });
  }
  for (const [, name = '', heritage = '', body = ''] of code.matchAll(
    /\bexport\s+(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)\s*(?:<[^{]*>)?\s*(?:extends\s+([^{]*))?\{([^}]*)\}/g,
  )) {
    const single = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(heritage)?.[1];
    declared.push({ name, repeats: single !== undefined && body.trim() === '' ? single : undefined });
  }
  return declared;
}

type ExportSpecifier = { readonly local: string; readonly exported: string; readonly from: string | undefined };

/**
 * Every name an `export { … }` / `export type { … }` list carries, with the
 * name it is exported under and the module it is re-exported from.  `export *`
 * is reported as the specifier `*`, which publishes every name of its source.
 */
function exportSpecifiers(source: string): ExportSpecifier[] {
  const code = withoutComments(source);
  const found: ExportSpecifier[] = [];
  for (const [, list = '', from] of code.matchAll(
    /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/g,
  )) {
    for (const item of list.split(',')) {
      const specifier = item.trim().replace(/^type\s+/, '');
      if (specifier === '') continue;
      const [, local = specifier, exported = local] = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(specifier) ?? [];
      found.push({ local, exported, from });
    }
  }
  for (const [, from] of code.matchAll(/\bexport\s+(?:type\s+)?\*\s*from\s*['"]([^'"]+)['"]/g)) {
    found.push({ local: '*', exported: '*', from });
  }
  return found;
}

/** Backticked relative module paths (`` `../X.js` ``) a source's comments name. */
function modulePathsNamedInComments(source: string): string[] {
  const comments = [...source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)].map(([comment]) => comment).join('\n');
  return [...comments.matchAll(/`(\.{1,2}\/[\w./-]+\.js)`/g)].map(([, path = '']) => path);
}

describe('the persistence option types carry one name each (found while #1430)', () => {
  test('every type PersistenceOptions.ts declares is published by the persistence barrel', () => {
    const declared = declaredTypes(read(OPTIONS_MODULE)).map(({ name }) => name);
    // Guards the guard: a reader that stopped seeing the declarations would
    // compare an empty list against the barrel and pass.
    expect(declared).toEqual(expect.arrayContaining([...KNOWN_OPTION_TYPES]));
    const published = exportSpecifiers(read(PERSISTENCE_BARREL))
      .filter(({ from }) => from === OPTIONS_SPECIFIER_FROM_BARREL)
      .map(({ exported }) => exported);
    expect(
      published.includes('*') ? [] : declared.filter((name) => !published.includes(name)),
      `${OPTIONS_MODULE} exports types the persistence barrel does not publish. The package's \`exports\` `
      + 'map publishes barrels only, so no consumer can import such a name: it is dead, and one that '
      + 'repeats another name is the compatibility alias a pre-1.0 hard cut does not keep.',
    ).toEqual([]);
  });

  test('no type in PersistenceOptions.ts is a second name for another', () => {
    const aliases = declaredTypes(read(OPTIONS_MODULE))
      .filter(({ repeats }) => repeats !== undefined)
      .map(({ name, repeats }) => `${name} = ${repeats}`);
    expect(
      aliases,
      `${OPTIONS_MODULE} declares a type that only repeats another under a new name. An old name is `
      + 'removed, not aliased: callers are updated in the same change, and nothing is deprecated first.',
    ).toEqual([]);
  });

  test('nothing re-exports an option type under a second name', () => {
    // The same alias, spelled as a rename in an export list — the barrel and
    // PluginConfig.ts both re-export these types, and so could the module.
    const renames = [PERSISTENCE_BARREL, PLUGIN_CONFIG, OPTIONS_MODULE].flatMap((path) =>
      exportSpecifiers(read(path))
        .filter(({ local, exported }) => local !== exported)
        .filter(({ local, from }) => from?.endsWith('/PersistenceOptions.js') === true
          || KNOWN_OPTION_TYPES.some((name) => name === local))
        .map(({ local, exported }) => `${path}: ${local} as ${exported}`));
    expect(renames).toEqual([]);
  });

  test('PluginConfig.ts names the module it re-exports the option types from, and that module exists', () => {
    const source = read(PLUGIN_CONFIG);
    const reExportedFrom = exportSpecifiers(source)
      .filter(({ local }) => KNOWN_OPTION_TYPES.some((name) => name === local))
      .map(({ from }) => from);
    // Guards the guard: the re-export is what the comment is about.
    expect(new Set(reExportedFrom)).toEqual(new Set(['../PersistenceOptions.js']));
    const named = modulePathsNamedInComments(source);
    expect(
      named.filter((path) => !existsSync(join(REPOSITORY_ROOT, dirname(PLUGIN_CONFIG), path.replace(/\.js$/, '.ts')))),
      `${PLUGIN_CONFIG} tells its reader about a module that does not exist.`,
    ).toEqual([]);
    expect(
      named,
      `${PLUGIN_CONFIG}'s comment no longer names the module the option types are re-exported from.`,
    ).toContain('../PersistenceOptions.js');
  });
});

/**
 * The readers above, pointed at fixtures: a reader that silently misses a
 * shape passes the way an empty list passes.
 */
describe('the alias readers — what they see', () => {
  test('a type alias, an empty extending interface and a rename are all seen; a real declaration is not an alias', () => {
    const fixture = [
      'export type Kept = { readonly a: number; readonly b: string };',
      'export type Old = Kept;',
      'export type Spaced =',
      '  Kept ;',
      'export interface Hollow extends Kept {}',
      'export interface Shaped extends Kept { readonly c: boolean }',
      'export type Union = | { readonly mode: \'none\' } | Kept;',
    ].join('\n');
    expect(declaredTypes(fixture)).toEqual([
      { name: 'Kept', repeats: undefined },
      { name: 'Old', repeats: 'Kept' },
      { name: 'Spaced', repeats: 'Kept' },
      { name: 'Union', repeats: undefined },
      { name: 'Hollow', repeats: 'Kept' },
      { name: 'Shaped', repeats: undefined },
    ]);
  });

  test('a generic or declared alias is seen too', () => {
    const fixture = [
      'export type Kept = { readonly a: number };',
      'export type Generic<T = never> = Kept;',
      'export declare type Declared = Kept;',
      'export type Wrapped = Readonly<Kept>;',
    ].join('\n');
    expect(declaredTypes(fixture)).toEqual([
      { name: 'Kept', repeats: undefined },
      { name: 'Generic', repeats: 'Kept' },
      { name: 'Declared', repeats: 'Kept' },
      // The documented blind spot: a wrapped alias reads as a type of its own.
      { name: 'Wrapped', repeats: undefined },
    ]);
  });

  test('a commented-out alias is not an export, and CRLF reads like LF', () => {
    const lineFeed = [
      '/** export type Older = Kept; */',
      '// export type Old = Kept;',
      'export type Kept = { readonly a: number };',
      'export type Alias =',
      '  Kept;',
    ].join('\n');
    const expected = [{ name: 'Kept', repeats: undefined }, { name: 'Alias', repeats: 'Kept' }];
    expect(declaredTypes(lineFeed)).toEqual(expected);
    expect(declaredTypes(lineFeed.replaceAll('\n', '\r\n'))).toEqual(expected);
  });

  test('export lists are read with their renames and sources', () => {
    const fixture = [
      'export type {',
      '  CompressionConfig,',
      '  type PersistenceOptions as PersistenceWriteOptions,',
      "} from './PersistenceOptions.js';",
      'export { Local as Renamed };',
      "export type * from './Other.js';",
    ].join('\n');
    expect(exportSpecifiers(fixture)).toEqual([
      { local: 'CompressionConfig', exported: 'CompressionConfig', from: './PersistenceOptions.js' },
      { local: 'PersistenceOptions', exported: 'PersistenceWriteOptions', from: './PersistenceOptions.js' },
      { local: 'Local', exported: 'Renamed', from: undefined },
      { local: '*', exported: '*', from: './Other.js' },
    ]);
  });

  test('module paths are read from comments only', () => {
    const fixture = [
      '/** Re-exported from `../Named.js`. */',
      "import { x } from '../Imported.js';",
      '// see `./Line.js`',
      "const s = '`../InAString.js`';",
    ].join('\n');
    expect(modulePathsNamedInComments(fixture)).toEqual(['../Named.js', './Line.js']);
  });
});
