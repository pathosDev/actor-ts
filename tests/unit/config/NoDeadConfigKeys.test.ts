import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { REFERENCE_CONF } from '../../../src/config/reference.js';
import { parseHocon, isPlainObject } from '../../../src/config/HoconParser.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';

/**
 * The guard #653 asked for: **no key in `reference.conf` may be dead.**
 *
 * The framework shipped ~25 documented keys that nothing ever read, so an
 * operator's `application.conf` could be entirely inert and neither fail nor
 * warn.  Wiring them was the fix; this is what stops the next one.
 *
 * Two properties, both cheap and both blunt on purpose:
 *
 *   1. every leaf in `REFERENCE_CONF` is reachable from `ConfigKeys` — the
 *      file that calls itself the single source of truth, and had entries for
 *      barely half the keys;
 *   2. the `ConfigKeys` entry that covers it is referenced from somewhere in
 *      `src/` other than the two config files themselves.
 *
 * (2) proves a *reference*, not a correct read — a key mentioned in dead code
 * would still pass.  That is the deliberate ceiling: the failure mode worth
 * catching is "declared and never wired up", and a stricter check would have
 * to model config flow through the options mergers, which is a lot of
 * machinery to catch a mistake this one already catches.
 */

const SOURCE_ROOT = join(import.meta.dir, '..', '..', '..', 'src');

/**
 * Keys that ship in `reference.conf` and are knowingly not read yet.  Every
 * entry carries the issue that will remove it: this list exists so a
 * deliberate gap stays visible, not so the next one can be waved through.
 *
 * **Empty, and meant to stay that way.**  Its one entry was
 * `actor-ts.remote.tls.enabled`, and #591 took it out by giving the key a
 * reader: the node now warns at startup when it is `true`, which is a read,
 * so both properties the guard checks hold again.  "Read" is the bar here,
 * not "honoured" — encrypting the wire is still #941 — because a key nothing
 * looks at is the failure mode #653 was filed for, and a key that is looked
 * at and answered with a WARN is not that failure mode.
 */
const KNOWN_DEAD_KEYS: ReadonlyMap<string, string> = new Map<string, string>();

/** Every dotted leaf path in a parsed HOCON tree, in declaration order. */
function leafPaths(tree: ConfigObject, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) out.push(...leafPaths(value, path));
    else out.push(path);
  }
  return out;
}

/** Every `actor-ts.*` path in the ConfigKeys tree, mapped to its accessor. */
function configKeyPaths(
  tree: Record<string, unknown>,
  accessor: string[] = [],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, value] of Object.entries(tree)) {
    const trail = [...accessor, key];
    if (typeof value === 'string') {
      // The worker IPC sentinels live in this tree too and are message-kind
      // strings, not paths — the `actor-ts.` prefix is what tells them apart.
      if (value.startsWith('actor-ts.')) out.set(value, trail);
    } else if (value && typeof value === 'object') {
      for (const [path, nested] of configKeyPaths(value as Record<string, unknown>, trail)) {
        out.set(path, nested);
      }
    }
  }
  return out;
}

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const referenceLeaves = leafPaths(parseHocon(REFERENCE_CONF));
const keyPathsToAccessor = configKeyPaths(ConfigKeys);

/** The ConfigKeys entry covering `leaf` — an exact match, or a config root above it. */
function coveringAccessor(leaf: string): string[] | null {
  const exact = keyPathsToAccessor.get(leaf);
  if (exact) return exact;
  // A plugin root (`actor-ts.cache.in-memory`, `actor-ts.http.websocket`) is
  // read as a block, with its own leaves appended by the reader.
  for (const [path, accessor] of keyPathsToAccessor) {
    if (leaf.startsWith(`${path}.`)) return accessor;
  }
  return null;
}

/** Files that could plausibly be the reader — everything but the two config files. */
const readerSources = sourceFiles(SOURCE_ROOT)
  .filter((file) => !file.endsWith(join('config', 'ConfigKeys.ts')))
  .filter((file) => !file.endsWith(join('config', 'reference.ts')))
  .map((file) => ({ file, text: readFileSync(file, 'utf8') }));

/**
 * A reference is either the literal path (`'actor-ts.persistence.journal.plugin'`)
 * or the `ConfigKeys` accessor.  The accessor half checks the group and the
 * leaf in the *same file* rather than the whole chain, because readers
 * routinely bind the group first (`const keys = ConfigKeys.sharding`) and the
 * full expression never appears in the source.
 */
function isReferencedInSource(path: string, accessor: string[]): boolean {
  const group = `ConfigKeys.${accessor[0]}`;
  const leafProperty = `.${accessor[accessor.length - 1]}`;
  return readerSources.some(({ text }) =>
    text.includes(`'${path}'`)
    || text.includes(`"${path}"`)
    || (text.includes(group) && text.includes(leafProperty)));
}

describe('reference.conf has no dead keys', () => {
  test('the reference config actually parses into leaves', () => {
    // Guards the guard: a parser change that yielded nothing would make
    // every assertion below vacuously pass.
    expect(referenceLeaves.length).toBeGreaterThan(20);
    expect(referenceLeaves).toContain('actor-ts.sharding.passivation-idle');
  });

  test.each(referenceLeaves)('%s is reachable from ConfigKeys', (leaf) => {
    if (KNOWN_DEAD_KEYS.has(leaf)) return;
    const accessor = coveringAccessor(leaf);

    expect(
      accessor,
      `${leaf} ships in reference.conf but no ConfigKeys entry covers it. `
      + 'Add one, delete the key, or — if it is knowingly unimplemented — '
      + 'list it in KNOWN_DEAD_KEYS with the issue that will remove it.',
    ).not.toBeNull();
  });

  test.each(referenceLeaves)('%s is read somewhere in src/', (leaf) => {
    if (KNOWN_DEAD_KEYS.has(leaf)) return;
    const accessor = coveringAccessor(leaf);
    if (!accessor) return; // reported by the test above

    expect(
      isReferencedInSource(coveringPath(leaf), accessor),
      `${leaf} is declared in reference.conf and in ConfigKeys, but nothing `
      + 'under src/ references it. A documented key that no code reads is '
      + 'the exact defect #653 was filed for.',
    ).toBe(true);
  });

  test('every KNOWN_DEAD_KEYS entry is still a real reference.conf key', () => {
    // Otherwise the exception outlives the key and quietly excuses nothing.
    for (const [key, reason] of KNOWN_DEAD_KEYS) {
      expect(referenceLeaves, `${key} is excused (${reason}) but no longer in reference.conf`)
        .toContain(key);
    }
  });

  test('every KNOWN_DEAD_KEYS entry names the issue that will remove it', () => {
    for (const [key, reason] of KNOWN_DEAD_KEYS) {
      expect(reason, `${key} needs an issue reference, not just a note`).toMatch(/#\d+/);
    }
  });
});

/** The path the covering accessor actually points at — the root for a block key. */
function coveringPath(leaf: string): string {
  if (keyPathsToAccessor.has(leaf)) return leaf;
  for (const path of keyPathsToAccessor.keys()) {
    if (leaf.startsWith(`${path}.`)) return path;
  }
  return leaf;
}
