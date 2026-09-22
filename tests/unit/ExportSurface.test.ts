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

  test('the folded barrels are pinned, so folding an eighth is a decision', () => {
    // Not a statement of what *should* be folded — a snapshot of what is.  A
    // new subsystem barrel without a subpath lands here first, which is where
    // the choice between "publish it" and "fold it into the root" gets made
    // rather than defaulted.  `diagnostics` was made here (#1000): it carries
    // one options family and no runtime object — `ActorSystem` resolves the
    // settings itself — so a subpath would be a second door onto seven names
    // a consumer meets while configuring the system, which is what the root
    // barrel is for.  `parallelism` (#1563) was made the same way: an options
    // family named by `ActorSystemOptions.withParallelism`, an extension id
    // and the ref `spawn` hands back — met while configuring the system, so
    // the root barrel is the door; the threads underneath stay on the
    // published `worker` subpath.
    expect(foldedBarrels).toEqual([
      'config',
      'deadletters',
      'diagnostics',
      'mailbox',
      'parallelism',
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

/**
 * Every door a name can be reached through: the root barrel, all published
 * subpaths, and the folded barrels.  The folded ones are redundant while the
 * block above holds them to the root's contents — they are read anyway, so
 * this guard does not rest on another test passing.
 *
 * Loading all of them costs ~230 ms of the file's ~410 ms, measured.  It
 * happens once at module scope for the reason the `barrelNamespace` comment
 * gives: bun's per-test cap is 5 000 ms, and the question below is not
 * answerable from a subset of the doors.
 */
const doorNamespaces = new Map<string, Record<string, unknown>>([['.', rootNamespace]]);
for (const name of publishedSubpaths) doorNamespaces.set(`./${name}`, await barrelNamespace(name));
for (const [name, namespace] of foldedNamespaces) doorNamespaces.set(`src/${name}/`, namespace);

/**
 * A module under `src/` that no barrel re-exports, pinned with every value
 * name it emits.
 *
 * Four of these are internal *seams*, and each says so in its own doc comment:
 * `setNativeZstdDecompressCandidatesOverride` suppresses `node:zlib`
 * process-wide, giving up the allocation-time bound #580 exists to buy;
 * `resetCompressionCache` clears that override; `zstdDecompressorRung` reports
 * which rung of the ladder decoded (#1422); `setRuntimeOverride` forces
 * `detectRuntime()`.  Those four sentences were the whole guarantee — nothing
 * under `tests/` read them, so a barrel-widening sweep could have published a
 * production kill-switch with every gate green.
 *
 * The other exports are pinned alongside rather than exempted, because
 * reachability is the same question for all of them and the *set* is what a
 * sweep widens.  Publishing a new name stays free — it simply leaves the
 * unreachable set; keeping a new one internal costs a line here, which is
 * where that choice gets made instead of defaulted.  It is the shape the util
 * block above already has with the direction reversed: there the barrel must
 * cover the whole directory, here no barrel may reach the module at all.
 */
type InternalModule = {
  readonly modulePath: readonly string[];
  readonly valueExports: readonly string[];
};

const internalModules: readonly InternalModule[] = [
  {
    modulePath: ['persistence', 'object-storage', 'Compression.ts'],
    valueExports: [
      'compressorFor',
      'probeCompressionAvailability',
      'resetCompressionCache',
      'setNativeZstdDecompressCandidatesOverride',
      'zstdDecompressorRung',
    ],
  },
  {
    modulePath: ['runtime', 'Detect.ts'],
    valueExports: ['detectRuntime', 'hasBun', 'hasDeno', 'highResNow', 'setRuntimeOverride'],
  },
];

const internalNamespaces = new Map<string, Record<string, unknown>>();
for (const { modulePath } of internalModules) {
  internalNamespaces.set(
    modulePath.join('/'),
    (await import(pathToFileURL(join(sourceRoot, ...modulePath)).href)) as Record<string, unknown>,
  );
}

/**
 * The doors `name` can be reached from, by either route a re-export takes.
 * The name compare catches `export { setRuntimeOverride }`; the identity
 * compare catches `export { setRuntimeOverride as forceRuntime }`, which a
 * name compare reads as absent.  Identity is only asked of reference types —
 * two modules exporting the number 3 are not the same export, and a value
 * compare there would be noise rather than a signal.
 *
 * Where it stops, measured rather than assumed: a barrel that exports a
 * *wrapper* (`export function forceRuntimeKind(kind) { setRuntimeOverride(kind) }`)
 * publishes the seam's effect behind a new function object, and both compares
 * miss it — the whole file stays green.  Catching that needs a call graph, not
 * a namespace.  The guard's claim is therefore the narrow one: no door
 * re-exports these bindings, under this name or any other.
 */
const doorsEmitting = (name: string, binding: unknown): string[] => {
  const hasReferenceIdentity =
    typeof binding === 'function' || (typeof binding === 'object' && binding !== null);
  return [...doorNamespaces.entries()]
    .filter(
      ([, namespace]) =>
        name in namespace ||
        (hasReferenceIdentity && Object.values(namespace).some((value) => value === binding)),
    )
    .map(([door]) => door);
};

describe('the internal seams no barrel publishes stay unreachable (#1507)', () => {
  test('every door is loaded, so the tests below are not asking an empty set', () => {
    // A reachability test is only as good as the set it searches, and both
    // ways of losing that set are silent: a door dropped from the map, or one
    // whose namespace came back empty.  Either would leave every test in this
    // block green while covering nothing — the failure this whole file exists
    // to refuse, turned on the file itself.
    expect(doorNamespaces.size).toBe(1 + publishedSubpaths.size + foldedBarrels.length);
    const empty = [...doorNamespaces.entries()]
      .filter(([, namespace]) => Object.keys(namespace).length === 0)
      .map(([door]) => door);
    expect(empty).toEqual([]);
  });

  for (const { modulePath, valueExports } of internalModules) {
    const relative = modulePath.join('/');

    test(`src/${relative} emits exactly the names pinned here`, () => {
      // Both directions at once.  A renamed or deleted seam drops off the
      // left — which is what stops the reachability test below from passing
      // over a name that no longer exists — and a sixth export lands on the
      // right, while the choice between publishing it and keeping it internal
      // is still open.
      const namespace = internalNamespaces.get(relative)!;
      expect(Object.keys(namespace).sort()).toEqual([...valueExports].sort());
    });

    test(`no door reaches anything src/${relative} exports`, () => {
      const namespace = internalNamespaces.get(relative)!;
      const reachable = Object.keys(namespace)
        .flatMap((name) =>
          doorsEmitting(name, namespace[name]).map((door) => `${name} via ${door}`),
        )
        .sort();
      expect(reachable).toEqual([]);
    });
  }

  test('no pinned module is one the util barrel has to cover (#1404)', () => {
    // The two blocks state opposite contracts, so no module may be under both.
    // `src/util/` owes the subpath a re-export for every value it emits —
    // which is how `DEFAULT_DROP_REPORT_INTERVAL_MS` was caught missing one —
    // and a name withheld there is declared in `testOnlyExports` above, with
    // the underscore that marks it.  Declaring a util module internal here
    // would read as a second, quieter way to be exempt from that.
    const overlapping = internalModules
      .map(({ modulePath }) => modulePath.join('/'))
      .filter((relative) => relative.startsWith('util/'));
    expect(overlapping).toEqual([]);
  });
});
