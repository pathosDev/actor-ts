import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **One Node story: `@types/node` tracks the `engines` floor in every
 * manifest that declares it, and Dependabot is told not to move it.**
 *
 * The root has pinned `@types/node` to the support floor since `ac552d5b`,
 * for a reason nothing else enforces: with a newer major installed, both
 * `typecheck` and the whole suite stay green while a newer-Node API becomes
 * representable in `src/` — the pin's entire job is to make such an API a
 * compile error.  The Dependabot `ignore` beside it is what keeps the same
 * major-bump PR from returning every day (#334, #336, #340, #374, #481).
 *
 * `/docs` used to be exempt, on the argument that TypeDoc compiles `../src`
 * with the root tsconfig and the docs copy only types the site's own files.
 * True — and the first day of the `/docs` entry took that copy to 26 (#1601,
 * merged green) on a toolchain where every workflow sets up Node 24: types
 * for a runtime the docs never run on.  The maintainer's answer was one
 * story rather than two (#1616): every manifest Dependabot watches that
 * declares `@types/node` declares the floor's major, every such Dependabot
 * entry carries the rule, and the workflows' `node-version` is that major.
 * This file is where that decision lives, because nothing under `tests/`
 * had pinned any of it — the root pin was a manifest string and a YAML
 * comment.
 *
 * The npm-installed frontends under `examples/` are in the same story: the
 * two Next ones declare the package, sat on 22 and went to 26 the same day
 * (#1611), and are on the floor since #1616 too.  An npm entry names its
 * directories as a list, so the entry parser reads both spellings.
 *
 * Regex over YAML, like the other CI guards: no YAML dependency, parsers
 * that fail loudly, and a guards-the-guard assertion on each population.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

type Manifest = {
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};

function manifestAt(directory: string): Manifest {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, directory, 'package.json'), 'utf8')) as Manifest;
}

/** `>=24.0.0` → 24.  Anything else in `engines.node` is a change to this file. */
function floorMajorOf(manifest: Manifest): number {
  const range = manifest.engines?.['node'] ?? '';
  const match = /^>=(\d+)\.\d+\.\d+$/.exec(range);
  if (match === null) throw new Error(`package.json engines.node is ${JSON.stringify(range)}, expected the form ">=N.0.0"`);
  return Number(match[1]);
}

const dependabotLines: readonly string[] = readFileSync(
  join(REPOSITORY_ROOT, '.github', 'dependabot.yml'),
  'utf8',
).split(/\r?\n/);

type ManifestEntry = {
  /** `bun` or `npm` — the two ecosystems that read a `package.json`. */
  readonly ecosystem: string;
  /** `/`, `/docs`, `/examples/chat/frontend-next`, … — one of the entry's directories. */
  readonly directory: string;
  /** The entry's lines, from `- package-ecosystem:` to the line before the next one. */
  readonly lines: readonly string[];
};

/**
 * Every `package.json`-reading entry, once per directory it names: the Bun
 * entries carry a single `directory:` (one per directory on purpose — the
 * file says why), the npm entry a `directories:` list.  A list item counts
 * as a directory only while `directories:` is the nearest preceding key, so
 * the `labels:` and `update-types:` lists of the same entry are not mistaken
 * for one — the same trade-off `WorkflowHygiene.test.ts` makes.
 */
function manifestEntries(): ManifestEntry[] {
  const starts = dependabotLines
    .map((line, index) => (/^\s*-\s*package-ecosystem:/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  const entries: ManifestEntry[] = [];
  starts.forEach((start, position) => {
    const end = starts[position + 1] ?? dependabotLines.length;
    const lines = dependabotLines.slice(start, end);
    const ecosystem = /^\s*-\s*package-ecosystem:\s*"([^"]+)"\s*$/.exec(lines[0]!)?.[1];
    if (ecosystem !== 'bun' && ecosystem !== 'npm') return;
    const directories: string[] = [];
    let inDirectories = false;
    for (const line of lines.slice(1)) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      const single = /^\s*directory:\s*"([^"]+)"\s*$/.exec(line);
      if (single !== null) { directories.push(single[1]!); inDirectories = false; continue; }
      if (/^\s*directories:\s*$/.test(line)) { inDirectories = true; continue; }
      const item = /^\s*-\s*"([^"]+)"\s*$/.exec(line);
      if (inDirectories && item !== null) { directories.push(item[1]!); continue; }
      inDirectories = false;
    }
    if (directories.length === 0) throw new Error(`dependabot.yml line ${start + 1}: a ${ecosystem} entry that names no directory`);
    for (const directory of directories) entries.push({ ecosystem, directory, lines });
  });
  return entries;
}

/**
 * Whether the entry ignores `@types/node` majors: a `- dependency-name:
 * "@types/node"` item whose own lines — up to the next list item at the same
 * indentation — name `version-update:semver-major`.
 */
function ignoresTypesNodeMajors(entry: ManifestEntry): boolean {
  const item = entry.lines.findIndex((line) => /^\s*-\s*dependency-name:\s*"@types\/node"\s*$/.test(line));
  if (item < 0) return false;
  const indentation = /^(\s*)-/.exec(entry.lines[item]!)![1]!.length;
  for (const line of entry.lines.slice(item + 1)) {
    const listItem = /^(\s*)-\s*dependency-name:/.exec(line);
    if (listItem !== null && listItem[1]!.length <= indentation) break;
    if (/^\s*-\s*"version-update:semver-major"\s*$/.test(line)) return true;
  }
  return false;
}

/** Every quoted or bare `node-version:` value in the workflows; expressions are skipped. */
function workflowNodeVersions(): ReadonlyArray<{ file: string; value: string }> {
  const directory = join(REPOSITORY_ROOT, '.github', 'workflows');
  const found: Array<{ file: string; value: string }> = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.yml'))) {
    for (const line of readFileSync(join(directory, file), 'utf8').split(/\r?\n/)) {
      const match = /^\s*node-version:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
      if (match !== null && !match[1]!.startsWith('$')) found.push({ file, value: match[1]! });
    }
  }
  return found;
}

const root = manifestAt('.');
const floor = floorMajorOf(root);
const entries = manifestEntries();
const declaring = entries
  .map((entry) => {
    const manifest = manifestAt(entry.directory === '/' ? '.' : entry.directory.slice(1));
    const range = manifest.devDependencies?.['@types/node'] ?? manifest.dependencies?.['@types/node'];
    return { entry, range };
  })
  .filter((candidate): candidate is { entry: ManifestEntry; range: string } => candidate.range !== undefined);

describe('@types/node tracks the engines floor in every manifest Dependabot watches', () => {
  test('the populations are what they are meant to be', () => {
    // Guards the guard: an entry parser that found nothing, one that missed
    // the npm entry's `directories:` list, or a manifest reader that missed
    // `devDependencies`, would pass every assertion below.
    expect(floor).toBeGreaterThanOrEqual(24);
    expect(entries.map((entry) => entry.directory)).toEqual(
      expect.arrayContaining(['/', '/docs', '/examples/chat/frontend-next', '/examples/voice/frontend-next']),
    );
    expect(entries.filter((entry) => entry.ecosystem === 'npm').length).toBeGreaterThanOrEqual(8);
    expect(declaring.map((candidate) => candidate.entry.directory)).toEqual(
      expect.arrayContaining(['/', '/docs', '/examples/chat/frontend-next', '/examples/voice/frontend-next']),
    );
  });

  test('every manifest that declares @types/node declares the floor major, as a caret range', () => {
    for (const { entry, range } of declaring) {
      const major = /^\^(\d+)\./.exec(range)?.[1];
      expect(
        major === undefined ? null : Number(major),
        `${entry.directory} declares @types/node ${JSON.stringify(range)}; the floor is Node ${floor} `
        + '(package.json engines.node), and types for a newer Node than the toolchain runs on make '
        + 'newer-Node APIs representable at compile time. Raise the floor and the pins together, or revert the bump.',
      ).toBe(floor);
    }
  });

  test('every such Dependabot entry ignores @types/node majors, so the pin does not return as a daily PR', () => {
    for (const { entry } of declaring) {
      expect(
        ignoresTypesNodeMajors(entry),
        `the Dependabot entry for ${entry.directory} declares @types/node but carries no `
        + '`ignore: - dependency-name: "@types/node" / version-update:semver-major` rule — '
        + 'the next major bump arrives tomorrow, merges green and moves the types off the floor (#1601).',
      ).toBe(true);
    }
  });

  test('the workflows set up the floor major of Node', () => {
    const versions = workflowNodeVersions();
    // Guards the guard: the multi-runtime Node leg, the docs and the examples
    // each set one up, so a parser that found fewer is not reading the files.
    expect(versions.length).toBeGreaterThanOrEqual(4);
    for (const { file, value } of versions) {
      expect(
        Number(value.split('.')[0]),
        `${file} sets up node-version ${value}; the engines floor is ${floor}, and every leg runs the floor `
        + 'so that what the types describe is what the runtime is.',
      ).toBe(floor);
    }
  });
});
