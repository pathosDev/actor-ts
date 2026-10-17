import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative as relativePath, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as namespaceDoorFixture from './__fixtures__/export-surface-namespace-doors.js';
import {
  CircuitBreakerOptionsValidator,
  Config,
  ConfigKeys,
  OptionsError,
  isPlainObject,
  readDeadLetterQueueOptionsFromConfig,
} from '../../src/index.js';
import { expectExactOptions } from '../util/ExactOptions.js';

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
    expectExactOptions(readDeadLetterQueueOptionsFromConfig(config), { maxEntries: 42 });
    expectExactOptions(readDeadLetterQueueOptionsFromConfig(Config.empty()), {});
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
  {
    // The per-path deployment layer (#868) is configured in HOCON only: its
    // one consumer is the cell, and in code the spawn site says the same.
    modulePath: ['internal', 'Deployment.ts'],
    valueExports: ['DeploymentIndex', 'compileDeployment', 'readDeploymentFromConfig'],
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
 * A module namespace object — the one value on a door that is itself a door.
 *
 * `Symbol.toStringTag === 'Module'` is what the spec requires every namespace
 * object to carry and what no ordinary export does, so it is what lets the
 * walk below descend into exactly `export * as` and nothing else.  The
 * alternative — descend into every object-valued export — would turn the
 * reachability question into a search of every object the package publishes;
 * `ConfigKeys` alone is a nested tree of plain objects whose leaves are called
 * `name`, `host` and `port`.
 */
const isModuleNamespace = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<symbol, unknown>)[Symbol.toStringTag] === 'Module';

/** A binding a door hands out, and the property path it is reached by. */
type EmittedBinding = {
  readonly name: string;
  readonly path: string;
  readonly value: unknown;
};

/**
 * Every binding a door hands out, flattened through namespace re-exports.
 *
 * The flattening is the whole of this function and the reason it exists.  A
 * door's own keys are not all it publishes: `export * as compression from
 * './persistence/object-storage/Compression.js'` puts one key on the barrel
 * and all five Compression seams behind it, the `node:zlib` kill switch
 * included, and a compare over `Object.keys` alone reads that as a single
 * unremarkable export.
 *
 * Recursive rather than one level deep, because the shape nests: a barrel that
 * namespace-re-exports a module which itself namespace-re-exports the seam
 * puts it two down, and nobody writes that on purpose — they re-export a
 * module that already had it.  Bounded by the ancestor chain rather than a
 * global visited set, so a namespace reachable by two sibling paths is
 * reported under both while `export * as self from` a module's own path still
 * terminates.  The chain grows by one module per step and the module graph is
 * finite, which is what makes that a termination argument and not a hope.
 */
const emittedBindings = (
  namespace: Record<string, unknown>,
  prefix = '',
  ancestors: readonly unknown[] = [],
): EmittedBinding[] => {
  if (ancestors.includes(namespace)) return [];
  const chain = [...ancestors, namespace];
  return Object.entries(namespace).flatMap(([name, value]) => {
    const here: EmittedBinding = { name, path: `${prefix}${name}`, value };
    return isModuleNamespace(value)
      ? [here, ...emittedBindings(value, `${here.path}.`, chain)]
      : [here];
  });
};

const doorBindings = new Map<string, readonly EmittedBinding[]>(
  [...doorNamespaces].map(([door, namespace]) => [door, emittedBindings(namespace)]),
);

/**
 * The doors `name` can be reached from, by any route a re-export takes.  The
 * name compare catches `export { setRuntimeOverride }`; the identity compare
 * catches `export { setRuntimeOverride as forceRuntime }`, which a name
 * compare reads as absent; `emittedBindings` above is what makes both of them
 * see through `export * as`.  Identity is only asked of reference types — two
 * modules exporting the number 3 are not the same export, and a value compare
 * there would be noise rather than a signal.
 *
 * Where it stops, each half measured in this tree rather than reasoned about,
 * because the previous version of this comment was itself the defect: it
 * claimed "no door re-exports these bindings, under this name or any other"
 * while a namespace re-export on the root barrel published all five
 * Compression seams at 30 pass / 0 fail.  A sentence about a guard is not a
 * guarantee either.
 *
 * Two shapes are still not caught, and both were re-measured here:
 *
 *   - a **function wrapper**
 *     (`export function forceRuntimeKind(kind) { setRuntimeOverride(kind) }`)
 *     publishes the seam's *effect* behind a new function object, so neither
 *     compare has anything to match.  This is the kill switch's blast radius
 *     too, not just the low-stakes runtime example it used to be written with:
 *     a four-line wrapper on the root barrel hands out `node:zlib`
 *     suppression exactly as completely as re-exporting the seam would.
 *   - an **object wrapper** (`export const compression = { ...internals }`)
 *     copies the identical function objects onto a plain object, and the walk
 *     steps over it by design — descending into every object-valued export is
 *     the boundary the block below pins, since `ConfigKeys` alone would turn
 *     the question into a search of the whole published surface.  Measured on
 *     the root barrel: 39 pass / 0 fail with all five seams reachable.
 *
 * Both need a call graph or a taint analysis, not a namespace walk.  So the
 * claim is: no door re-exports these bindings — under any name, through any
 * depth of `export * as`, but as *bindings*, not as effects.
 */
const doorsReaching = (
  doors: ReadonlyMap<string, readonly EmittedBinding[]>,
  name: string,
  binding: unknown,
): string[] => {
  const hasReferenceIdentity =
    typeof binding === 'function' || (typeof binding === 'object' && binding !== null);
  const reaches = (emitted: EmittedBinding): boolean =>
    emitted.name === name || (hasReferenceIdentity && emitted.value === binding);
  return [...doors.entries()].flatMap(([door, bindings]) => {
    const hit = bindings.find(reaches);
    if (hit === undefined) return [];
    return [hit.path === name ? door : `${door} (as ${hit.path})`];
  });
};

const doorsEmitting = (name: string, binding: unknown): string[] =>
  doorsReaching(doorBindings, name, binding);

/**
 * A declaration whose name follows the seam convention, anywhere under `src/`.
 *
 * Deliberately over-approximate, and confirmed against the module namespace
 * below rather than trusted: a line inside a block comment or a template
 * string matches this just as well as a declaration does, and an indented one
 * inside a nested block is a real export this would miss if it were anchored
 * to column zero.  Text finds the candidates; the namespace decides which of
 * them exist.  That split is also what makes the pattern safe to loosen — a
 * false positive costs an import, not a failure.
 */
const seamDeclaration =
  /\bexport\s+(?:async\s+)?(?:function|const|let|var)\s+((?:set|reset|force|_reset)[A-Za-z0-9_]*)/g;

/**
 * The same convention without the declaration around it, and without `g` —
 * `RegExp.test` on a global regex carries `lastIndex` between calls, so one
 * shared object would answer differently depending on what was asked before.
 */
const seamNameConvention = /^(?:set|reset|force|_reset)[A-Z]/;

const sourceFilesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });

/** A seam that exists: the name matched the convention and the module emits it. */
type Seam = {
  readonly relative: string;
  readonly name: string;
  readonly binding: unknown;
};

/** Stage one: every seam-shaped name the text of one file proposes. */
const declaredSeamNames = (fileText: string): Set<string> =>
  new Set([...fileText.matchAll(seamDeclaration)].map((match) => match[1]!));

/**
 * Stage two, and the whole pair: the text proposes, the namespace disposes.
 *
 * Split out of the loop below so the block can hand it a text and a namespace
 * that *disagree*.  Nothing under `src/` disagrees today — measured: dropping
 * the membership filter entirely left the file at 43 pass / 0 fail — so the
 * stage that makes the loose regex safe is bound by construction here or by
 * nothing at all.
 */
const seamsIn = (fileText: string, namespace: Record<string, unknown>, relative: string): Seam[] =>
  [...declaredSeamNames(fileText)]
    .filter((name) => name in namespace)
    .map((name) => ({ relative, name, binding: namespace[name] }));

const seams: Seam[] = [];
for (const file of sourceFilesUnder(sourceRoot)) {
  const fileText = readFileSync(file, 'utf8');
  if (declaredSeamNames(fileText).size === 0) continue;
  const namespace = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  seams.push(...seamsIn(fileText, namespace, relativePath(sourceRoot, file).split(sep).join('/')));
}

const reachableSeams = seams
  .flatMap(({ relative, name, binding }) =>
    doorsEmitting(name, binding).map((door) => `${relative}#${name} via ${door}`),
  )
  .sort();

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

  /**
   * The question above is only as good as `doorsReaching`, and one construct
   * used to walk straight past it.  A namespace re-export —
   * `export * as compression from './persistence/object-storage/Compression.js'`
   * on `src/index.ts` — published all five Compression seams, the `node:zlib`
   * kill switch among them, while this file measured 30 pass / 0 fail at exit
   * 0 and a probe in that same tree read the kill switch back through the root
   * as the identical function object.  Neither compare could see it: the
   * seam's name is a key of the namespace object rather than of the door, and
   * the door's own value is that object rather than the function.
   *
   * So the file's own documented boundary was wrong where it mattered most.
   * "No door re-exports these bindings, under this name or any other" carved
   * out the wrapper case, and a namespace re-export is not a wrapper — it
   * hands back the identical binding.  The tree uses `export * as` in zero
   * places today, which is why nothing had noticed; the premise of this file
   * is that a sentence is not a guarantee, and the sentence about the guard
   * was itself unguarded.
   *
   * The doors here are fixtures because the measurement above needs a tree in
   * which the package publishes a kill switch.  They are asked the guard's own
   * question — the same `doorsReaching` over a map of the same shape — so this
   * block fails when the walk is removed, whatever `src/` looks like.
   */
  describe('a namespace re-export is a door too (#1507)', () => {
    const fixtureDoors = new Map<string, readonly EmittedBinding[]>([
      ['fixture barrel', emittedBindings(namespaceDoorFixture as Record<string, unknown>)],
    ]);

    const killSwitch = 'setNativeZstdDecompressCandidatesOverride';

    test('the fixture door is a real module namespace, not an object shaped like one', () => {
      // A `{ [Symbol.toStringTag]: 'Module' }` literal satisfies the predicate
      // by construction — deliberately asserted below, because it is the way
      // this block could pass while proving nothing.  What separates the two
      // is that the loader's object is sealed and a literal is not, so these
      // doors are the construct under test rather than a model of it.
      //
      // Measured rather than assumed, and the obvious assumption is wrong
      // here: a namespace object is specified to have a null prototype, and
      // under bun 1.4.2 `Object.getPrototypeOf` returns an interop shim
      // carrying `__esModule` instead.  The tag and the sealing are what hold.
      expect(isModuleNamespace(namespaceDoorFixture.compression)).toBe(true);
      expect(Object.isSealed(namespaceDoorFixture.compression)).toBe(true);
      expect(isModuleNamespace({ [Symbol.toStringTag]: 'Module' })).toBe(true);
      expect(Object.isSealed({ [Symbol.toStringTag]: 'Module' })).toBe(false);
    });

    test('the plain shape is reported rather than passed over', () => {
      const namespace = internalNamespaces.get('persistence/object-storage/Compression.ts')!;
      expect(doorsReaching(fixtureDoors, killSwitch, namespace[killSwitch])).toContain(
        `fixture barrel (as compression.${killSwitch})`,
      );
    });

    test('all five Compression seams come back, not just the one that was looked for', () => {
      // The finding is about a *sweep*, and a sweep moves a module rather than
      // a name: whichever seam someone thought about, the other four went with
      // it.  A walk that reported one of them would leave the blast radius
      // exactly as under-read as the prose it replaces.
      const namespace = internalNamespaces.get('persistence/object-storage/Compression.ts')!;
      const unreached = Object.keys(namespace).filter(
        (name) => doorsReaching(fixtureDoors, name, namespace[name]).length === 0,
      );
      expect(unreached).toEqual([]);
    });

    test('the binding name the door chose does not matter', () => {
      // `zlibInternals` is the same module under a name sharing no substring
      // with it, so nothing about catching it may rest on what it is called.
      const namespace = internalNamespaces.get('persistence/object-storage/Compression.ts')!;
      const paths = emittedBindings(namespaceDoorFixture as Record<string, unknown>)
        .filter((emitted) => emitted.value === namespace[killSwitch])
        .map((emitted) => emitted.path)
        .sort();
      expect(paths).toContain(`zlibInternals.${killSwitch}`);
    });

    test('a namespace nested inside a namespace is reached', () => {
      // Two modules deep: the door re-exports a module that itself
      // namespace-re-exports the seam.  Walking one level catches the shape
      // above and stops one short of this one, which is the whole of the
      // difference between a door count and a door graph.
      const namespace = internalNamespaces.get('persistence/object-storage/Compression.ts')!;
      const paths = emittedBindings(namespaceDoorFixture as Record<string, unknown>)
        .filter((emitted) => emitted.value === namespace[killSwitch])
        .map((emitted) => emitted.path);
      expect(paths).toContain(`renamedSeams.compression.${killSwitch}`);
    });

    test('a renamed binding behind a namespace is caught by identity, not by name', () => {
      // `forceZstdCandidates` is the kill switch under another name one level
      // down, where a name compare reads it as absent — the aliasing hole the
      // top-level identity compare already closed, moved behind a namespace.
      const namespace = internalNamespaces.get('persistence/object-storage/Compression.ts')!;
      const emitted = emittedBindings(namespaceDoorFixture as Record<string, unknown>).filter(
        (candidate) => candidate.path === 'renamedSeams.forceZstdCandidates',
      );
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.value).toBe(namespace[killSwitch]);
      expect(emitted[0]!.name).not.toBe(killSwitch);
    });

    test('the other pinned module is reached the same way', () => {
      // One module being caught would be an accident about Compression.ts.
      const namespace = internalNamespaces.get('runtime/Detect.ts')!;
      const unreached = Object.keys(namespace).filter(
        (name) => doorsReaching(fixtureDoors, name, namespace[name]).length === 0,
      );
      expect(unreached).toEqual([]);
    });

    test('a namespace that contains itself terminates', () => {
      // `export * as self from` its own path makes the binding graph cyclic.
      // Reaching this assertion at all is the measurement: a walk without a
      // termination rule never returns, and the guard's silent failure would
      // have moved rather than closed.
      expect(isModuleNamespace(namespaceDoorFixture.self)).toBe(true);
      expect(namespaceDoorFixture.self.self.self.compression).toBe(
        namespaceDoorFixture.compression,
      );
      const paths = emittedBindings(namespaceDoorFixture as Record<string, unknown>).map(
        (emitted) => emitted.path,
      );
      expect(paths.filter((path) => path.startsWith('self.self.'))).toEqual([]);
    });

    test('an ordinary object export is one value, not a tree to search', () => {
      // The other way to get this wrong: descend into every object-valued
      // export rather than only module namespaces.  `ConfigKeys` is a nested
      // tree of plain objects on the root barrel, so that version turns the
      // reachability question into a search of everything the package
      // publishes — and the leaf names down there (`name`, `host`, `port`)
      // are exactly the kind a bare name compare collides with by accident.
      expect(isModuleNamespace(ConfigKeys)).toBe(false);
      expect(emittedBindings({ ConfigKeys }).map((emitted) => emitted.path)).toEqual(['ConfigKeys']);
    });
  });

  /**
   * The same question as the table above, derived from the tree instead of
   * listed by hand — which is what the table should have been, and the header
   * of this file says why: the three area tests it was written to replace each
   * grew by "add the names that had been found", and this file exists so the
   * *next* instance fails a test rather than waiting to be read.  The table
   * pins two modules.  A scan for the seam convention finds 18 such exports
   * across 13 files, so fifteen of them sat outside any question — including
   * `runtime/signals/index.ts`, which was added between #580 and #1422 and is
   * exactly the event the table was filed to catch.  Measured: publishing
   * `resetProcessSignalsCache` from the root barrel left the file at 39 pass /
   * 0 fail before this block, and names it here.
   *
   * It also resolves what the table's shape could not express.  `InternalModule`
   * pins a module's *whole* export set and asserts none of it is reachable, so
   * a partially published module cannot be added at all: `DynamoDbClient.ts`
   * emits 11 names of which 9 are deliberately on `./persistence` and one is a
   * seam.  Asking the question per *name* has no such limit, which is why
   * growing the table is not the follow-up — this is.
   *
   * The two are not redundant.  The table pins **membership** (a sixth export
   * on `Compression.ts` is a decision someone makes on purpose); this pins
   * **reachability** for every seam wherever it lives.  The population test
   * below holds them together, so the table cannot drift out of the census.
   *
   * What it cannot see: a seam that does not follow the naming convention.
   * `overrideZstdCandidates` would be invisible here, and that is the honest
   * limit of deriving a question from names — narrower than the table's limit,
   * which was being a list, but not nothing.
   */
  describe('no seam-shaped export anywhere in src/ is reachable (#1507)', () => {
    test('the census is asking about a population, not an empty set', () => {
      // The failure this refuses is the doors block's failure turned on the
      // scan: a regex that stops matching leaves `seams` empty and every
      // assertion here vacuously green.  The floor is well under the 18
      // measured today on purpose — it is a liveness check, not a ratchet,
      // and deleting a seam is ordinary work.
      expect(seams.length).toBeGreaterThanOrEqual(10);

      // And the derived question provably contains the hand-written one, so
      // the table is a subset of this census rather than a second list beside
      // it.  If the scan ever stops seeing the modules the table names, this
      // fails on the names rather than on a count.
      const found = new Set(seams.map((seam) => `${seam.relative}#${seam.name}`));
      const pinnedSeams = internalModules.flatMap(({ modulePath, valueExports }) =>
        valueExports
          .filter((name) => seamNameConvention.test(name))
          .map((name) => `${modulePath.join('/')}#${name}`),
      );
      expect(pinnedSeams.length).toBeGreaterThan(0);
      expect(pinnedSeams.filter((seam) => !found.has(seam))).toEqual([]);
    });

    test('no door reaches any of them', () => {
      // Empty, with nothing exempted.  A seam that has to be published is a
      // decision, and it belongs here as an entry with its reason — the shape
      // `SECURITY.md` uses for audit suppressions, for the same reason: a
      // list that is allowed to be empty says something when it is not.
      expect(reachableSeams).toEqual([]);
    });

    test('a partially published module is covered by name, not skipped', async () => {
      // The case the table's shape could not hold.  `DynamoDbClient.ts` is
      // published almost entirely and keeps one seam back, so a whole-module
      // pin would fail on the nine names that are *supposed* to be reachable.
      // Asserted in both directions, because only the pair says "partially":
      // the seam is unreachable and something else in the same module is not.
      const seam = seams.find((candidate) => candidate.name === 'resetDynamoDbSdkCache');
      expect(seam?.relative).toBe('persistence/journals/DynamoDbClient.ts');
      expect(doorsEmitting(seam!.name, seam!.binding)).toEqual([]);

      const module = (await import(
        pathToFileURL(join(sourceRoot, 'persistence', 'journals', 'DynamoDbClient.ts')).href
      )) as Record<string, unknown>;
      const published = Object.keys(module).filter(
        (name) => doorsEmitting(name, module[name]).length > 0,
      );
      expect(published.length).toBeGreaterThan(0);
      expect(published).not.toContain('resetDynamoDbSdkCache');
    });

    test('the scan proposes and the module namespace disposes', () => {
      // Both stages, against a text and a namespace that disagree — the only
      // way either is bound, because nothing in `src/` disagrees today.
      // Measured: dropping the membership filter left the whole file at
      // 43 pass / 0 fail, so a census that trusted the regex would have been
      // indistinguishable from this one on this tree and wrong on the next.
      //
      // Line 1 is the loose half earning its keep: an indented declaration is
      // a real export, and anchoring the scan to column zero drops it.
      // Line 2 is the strict half: a seam-shaped name inside a comment (or a
      // template string, or this very paragraph) matches the regex exactly as
      // well as a declaration does, and must contribute nothing.
      const fileText = [
        '  export const resetIndentedThing = () => {};',
        '// export function setSomethingNobodyDeclared(): void {}',
        'export function resetDeclaredThing(): void {}',
      ].join('\n');
      const namespace: Record<string, unknown> = {
        resetIndentedThing: () => {},
        resetDeclaredThing: () => {},
      };

      expect([...declaredSeamNames(fileText)].sort()).toEqual([
        'resetDeclaredThing',
        'resetIndentedThing',
        'setSomethingNobodyDeclared',
      ]);
      expect(seamsIn(fileText, namespace, 'probe.ts').map((seam) => seam.name).sort()).toEqual([
        'resetDeclaredThing',
        'resetIndentedThing',
      ]);
    });

    test('a CRLF checkout is scanned like any other', () => {
      // `core.autocrlf=true` means every line in a Windows working copy ends
      // `\r\n`, and this repo has been bitten by a parse that assumed `\n`.
      // The 18 seams found above are already the proof on this machine; the
      // assertion states it so a future anchor or line-split cannot quietly
      // reintroduce the assumption on a platform CI does not run on.
      const crlf = 'export function resetCarriageThing(): void {}\r\nexport const x = 1;\r\n';
      expect([...declaredSeamNames(crlf)]).toEqual(['resetCarriageThing']);
    });
  });

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
