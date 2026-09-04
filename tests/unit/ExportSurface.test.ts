import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CircuitBreakerOptionsValidator,
  Config,
  ConfigKeys,
  OptionsError,
  isPlainObject,
  readDeadLetterQueueOptionsFromConfig,
} from '../../src/index.js';

/**
 * `package.json` ships only `dist/` and its `exports` map has no wildcard, so
 * a name no barrel emits is a name that left the package.  Three tests state
 * that invariant for one area each — `MailboxExports.test.ts` (#661, #1002),
 * `UtilExports.test.ts` (#1034) and `logging/PublicSurface.test.ts` — and each
 * time the fix was to add the names that had been found by hand.  This file
 * derives the question from the tree instead, so the *next* instance fails a
 * test rather than waiting to be read.
 *
 * The mechanism.  A subsystem barrel is reachable one of two ways: it has its
 * own subpath in the `exports` map, or the core-only root cut (#414) folds it
 * into `src/index.ts`.  For a published barrel reachability is automatic — the
 * subpath *is* the entry point.  For a folded one the root barrel is the only
 * door, so every name the folded barrel emits and the root does not is
 * unreachable.  That is exactly how `ConfigKeys`,
 * `CircuitBreakerOptionsValidator`, `isPlainObject` and
 * `readDeadLetterQueueOptionsFromConfig` were lost (#1403).
 *
 * What this cannot see: type-only exports.  A module namespace object holds
 * values, so `export type { X }` is invisible here and a dropped type would
 * still pass.  Covering that needs the emitted declarations — #819's `.d.ts`
 * rollup, which supersedes this file's structural half when it lands.  The
 * type halves of the five folded barrels are complete as of #1403, verified by
 * source inspection; the explicit `import type` annotations in the three
 * area tests above are what keeps the compiler checking the ones they name.
 */

const repoRoot = join(import.meta.dir, '..', '..');
const sourceRoot = join(repoRoot, 'src');

const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  exports: Record<string, unknown>;
};

/** `'./cache'` → `'cache'`.  The root and `./package.json` name no subsystem. */
const publishedSubpaths = new Set(
  Object.keys(packageJson.exports)
    .filter((key) => key.startsWith('./') && key !== './package.json')
    .map((key) => key.slice(2)),
);

/** Every directory under `src/` that has a barrel to be reached through. */
const barrels = readdirSync(sourceRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(sourceRoot, entry.name, 'index.ts')))
  .map((entry) => entry.name)
  .sort();

const foldedBarrels = barrels.filter((name) => !publishedSubpaths.has(name));

/**
 * Imported at module scope rather than inside the tests that read them, for
 * the reason `TreeShaking.test.ts` spells out (#1394): bun's per-test timeout
 * is 5 000 ms and nothing in `bunfig.toml` raises it, so bounded setup work
 * belongs outside a `test()` body.  The specifier is a `file:` URL to the real
 * `.ts` file, which needs no extension rewriting and no import assertion.
 */
const barrelNamespace = async (...segments: string[]): Promise<Record<string, unknown>> =>
  (await import(pathToFileURL(join(sourceRoot, ...segments, 'index.ts')).href)) as Record<
    string,
    unknown
  >;

const rootNamespace = await barrelNamespace();
const foldedNamespaces = new Map<string, Record<string, unknown>>();
for (const name of foldedBarrels) foldedNamespaces.set(name, await barrelNamespace(name));

/**
 * `src/util/` is the one published subsystem that is a flat directory of
 * unrelated helpers rather than a feature with a shape, so "is the barrel
 * complete?" is a question worth asking mechanically.  Importing each module
 * and unioning the namespace keys asks it without parsing anything, and covers
 * a module added later without an edit here (#1404).
 */
const utilDirectory = join(sourceRoot, 'util');
const utilModuleExports = new Set<string>();
for (const file of readdirSync(utilDirectory)) {
  if (!file.endsWith('.ts') || file === 'index.ts') continue;
  const namespace = (await import(pathToFileURL(join(utilDirectory, file)).href)) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(namespace)) utilModuleExports.add(key);
}

describe('the exports map and the barrels under src/ agree (#1403)', () => {
  test('every published subpath points at a barrel that exists', () => {
    const dangling = [...publishedSubpaths].filter(
      (subpath) => !existsSync(join(sourceRoot, subpath, 'index.ts')),
    );
    expect(dangling).toEqual([]);
  });

  test('the folded barrels are pinned, so folding a seventh is a decision', () => {
    // Not a statement of what *should* be folded — a snapshot of what is.  A
    // new subsystem barrel without a subpath lands here first, which is where
    // the choice between "publish it" and "fold it into the root" gets made
    // rather than defaulted.  `diagnostics` was made here (#1000): it carries
    // one options family and no runtime object — `ActorSystem` resolves the
    // settings itself — so a subpath would be a second door onto seven names
    // a consumer meets while configuring the system, which is what the root
    // barrel is for.
    expect(foldedBarrels).toEqual([
      'config',
      'deadletters',
      'diagnostics',
      'mailbox',
      'pattern',
      'typed',
    ]);
  });

  test('util is published rather than folded (#1404)', () => {
    // The directory the root barrel used to reach one hand-picked name at a
    // time.  Asserted by name because the pin above would also be satisfied by
    // `util` having no barrel at all.
    expect(publishedSubpaths.has('util')).toBe(true);
    expect(barrels).toContain('util');
  });
});

describe('a folded barrel emits nothing the root barrel drops (#1403)', () => {
  for (const name of foldedBarrels) {
    test(`src/${name}/index.ts is fully reachable from the root`, () => {
      const namespace = foldedNamespaces.get(name)!;
      const dropped = Object.keys(namespace).filter((key) => !(key in rootNamespace));
      expect(dropped).toEqual([]);
    });

    test(`src/${name}/index.ts and the root agree on what each name is`, () => {
      // Name equality alone would pass a re-export wired to the wrong module.
      // `Success` / `Failure` are the only names both barrels carry —
      // `pattern/Status.ts` re-exports them from `util/Try.ts`, which is where
      // the root gets them too, so identity holds and a divergence here means
      // one of the two doors leads somewhere else.
      const namespace = foldedNamespaces.get(name)!;
      const divergent = Object.keys(namespace).filter(
        (key) => key in rootNamespace && namespace[key] !== rootNamespace[key],
      );
      expect(divergent).toEqual([]);
    });
  }
});

describe('the util barrel covers the whole directory (#1404)', () => {
  /**
   * The one name the barrel withholds on purpose.  Its own doc comment says
   * there is no production reason to drop entropy and that it exists for a
   * test substituting `crypto.getRandomValues`; the underscore is the
   * convention, and publishing it would make a test hook part of the API.
   */
  const testOnlyExports = new Set(['_resetEntropyPool']);

  test('every value any util module exports is on the subpath', async () => {
    const barrel = await barrelNamespace('util');
    const missing = [...utilModuleExports]
      .filter((key) => !testOnlyExports.has(key))
      .filter((key) => !(key in barrel))
      .sort();
    expect(missing).toEqual([]);
  });

  test('the barrel adds nothing the directory does not have', async () => {
    // The other direction: a re-export of a name that has moved elsewhere in
    // `src/` would compile and would put a subsystem behind the one directory
    // that must keep no outward import at all.
    const barrel = await barrelNamespace('util');
    const foreign = Object.keys(barrel)
      .filter((key) => !utilModuleExports.has(key))
      .sort();
    expect(foreign).toEqual([]);
  });

  test('the test-only hook stays off the subpath', async () => {
    const barrel = await barrelNamespace('util');
    for (const name of testOnlyExports) {
      expect(utilModuleExports.has(name)).toBe(true); // still exists, still not published
      expect(name in barrel).toBe(false);
    }
  });
});

describe('the four names the folded barrels dropped (#1403)', () => {
  test('ConfigKeys resolves to paths Config actually reads', () => {
    // Behavioural rather than a string compare: the tree is only worth
    // exporting if a key taken from it addresses the same value a literal
    // would, so it is used on both sides of the round-trip.
    const config = Config.parseString(`${ConfigKeys.system.name} = "from-config-keys"`);
    expect(config.getString(ConfigKeys.system.name)).toBe('from-config-keys');
  });

  test('isPlainObject rejects the two shapes typeof cannot tell apart', () => {
    expect(isPlainObject({ retries: 3 })).toBe(true);
    expect(isPlainObject([1, 2, 3])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });

  test('readDeadLetterQueueOptionsFromConfig reads the block and nothing else', () => {
    const config = Config.parseString(`${ConfigKeys.deadLetters.maxEntries} = 42`);
    // A `Partial`: only the keys the config actually set, so an unset field
    // falls through to the built-in default instead of shadowing it.
    expect(readDeadLetterQueueOptionsFromConfig(config)).toEqual({ maxEntries: 42 });
    expect(readDeadLetterQueueOptionsFromConfig(Config.empty())).toEqual({});
  });

  test('CircuitBreakerOptionsValidator enforces its two required fields', () => {
    const validator = new CircuitBreakerOptionsValidator();
    expect(() => validator.validate({ maxFailures: 3, resetTimeoutMs: 1_000 })).not.toThrow();
    expect(() => validator.validate({ resetTimeoutMs: 1_000 })).toThrow(OptionsError);
    expect(() => validator.validate({ maxFailures: 0, resetTimeoutMs: 1_000 })).toThrow(
      OptionsError,
    );
  });
});
