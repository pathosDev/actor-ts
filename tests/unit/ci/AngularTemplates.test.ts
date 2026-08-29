import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

/**
 * Angular templates live in their own file, never in a decorator (AGENTS.md
 * → Code style → Angular components).
 *
 * A convention that lives only in prose drifts, and this repository has the
 * receipts: the `.ng-spec.ts` suffix and the coverage floors both had to be
 * pinned by a test after the fact.  So this one is pinned from the start.
 *
 * It runs under the ROOT `bun test` and reads the filesystem, so it needs
 * neither the nested Angular install nor a DOM — a fresh clone enforces the
 * rule on its first test run.
 */

const repositoryRoot = resolve(import.meta.dir, '..', '..', '..');
const uiSource = join(repositoryRoot, 'devtools-ui', 'src');

/** Every `.ts` under `devtools-ui/src`, excluding the Angular specs. */
function componentSources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...componentSources(path));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.ng-spec.ts')) {
      found.push(path);
    }
  }
  return found;
}

type Decorated = {
  readonly path: string;
  readonly relativePath: string;
  readonly source: string;
};

const decorated: Decorated[] = componentSources(uiSource)
  .map((path) => ({
    path,
    relativePath: relative(repositoryRoot, path).replaceAll('\\', '/'),
    source: readFileSync(path, 'utf8'),
  }))
  .filter((file) => /^@Component\(\{/m.test(file.source));

describe('Angular components keep their template in a file', () => {
  test('the scan actually finds the components', () => {
    // Without this the rest of the suite passes vacuously the day someone
    // moves the UI or renames the directory.
    expect(decorated.length).toBeGreaterThanOrEqual(13);
  });

  test('no component declares an inline template', () => {
    // Matches `template:` but not `templateUrl:`, so both the backtick form
    // and an empty `template: ''` are caught.
    const offenders = decorated
      .filter((file) => /^\s*template\s*:/m.test(file.source))
      .map((file) => file.relativePath);

    expect(
      offenders,
      'inline templates found; move the markup to a sibling .html file and'
      + " point `templateUrl` at it (AGENTS.md → Code style → Angular components)",
    ).toEqual([]);
  });

  test('every component declares a templateUrl', () => {
    const missing = decorated
      .filter((file) => !/^\s*templateUrl\s*:/m.test(file.source))
      .map((file) => file.relativePath);

    expect(missing, 'component with no templateUrl').toEqual([]);
  });

  test('the template sits beside the component and shares its name', () => {
    // A free-floating name would let two components share a template, or
    // leave one pointing at a file nobody associates with it.
    const wrong: string[] = [];
    for (const file of decorated) {
      const declared = /^\s*templateUrl\s*:\s*'([^']+)'/m.exec(file.source)?.[1];
      const expected = `./${basename(file.path, '.ts')}.html`;
      if (declared !== expected) wrong.push(`${file.relativePath}: ${declared} != ${expected}`);
    }
    expect(wrong).toEqual([]);
  });

  test('every declared template file exists', () => {
    const dangling: string[] = [];
    for (const file of decorated) {
      const declared = /^\s*templateUrl\s*:\s*'([^']+)'/m.exec(file.source)?.[1];
      if (declared === undefined) continue;
      if (!existsSync(join(dirname(file.path), declared))) {
        dangling.push(`${file.relativePath} -> ${declared}`);
      }
    }
    // `tsc` never resolves a templateUrl, so a dangling one is invisible
    // until `ng build` runs — which a fresh clone without the nested install
    // cannot do at all.
    expect(dangling).toEqual([]);
  });

  test('no template file is orphaned', () => {
    const referenced = new Set(decorated.map((file) =>
      join(dirname(file.path), `${basename(file.path, '.ts')}.html`)));

    const orphans: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { walk(path); continue; }
        if (entry.name.endsWith('.html') && !referenced.has(path)) {
          orphans.push(relative(repositoryRoot, path).replaceAll('\\', '/'));
        }
      }
    };
    walk(uiSource);

    // A template left behind after its component was deleted is dead markup
    // the bundle never loads and nothing else would notice.
    expect(orphans).toEqual([]);
  });
});
