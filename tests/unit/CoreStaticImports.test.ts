import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * `import { ActorSystem } from 'actor-ts'` must not pay for Fastify (#1005).
 *
 * ActorSystem reaches HttpExtension statically (the `newServerAt` sugar
 * needs the extension id and its factory synchronously), so the guarded
 * boundary is one hop further down: HttpExtension resolves the *default
 * backend* lazily in `backendFromConfig`, exactly like the express and
 * hono arms.  Bundlers see the same graph tsc emits, so the invariant is
 * checked where it lives — on the static import graph of the sources.
 * Type-only imports are skipped: they are erased at compile time and load
 * nothing.
 */

const repoRoot = join(import.meta.dir, '..', '..');

/** Static (runtime-loading) relative specifiers of one module. */
function staticRelativeImports(source: string): string[] {
  const specifiers: string[] = [];
  // `import … from 'x'` / `export … from 'x'` — statement-anchored, so the
  // lazy `await import('x')` calls never match (they have no `from`).
  const fromRe = /(?:^|\n)\s*(import|export)\s+([^;]*?)from\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(fromRe)) {
    const clause = m[2]!;
    if (/^type[\s{]/.test(clause.trim())) continue; // erased at compile time
    specifiers.push(m[3]!);
  }
  // bare side-effect imports: `import './x.js';`
  const bareRe = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(bareRe)) specifiers.push(m[1]!);
  return specifiers.filter((s) => s.startsWith('./') || s.startsWith('../'));
}

/** All source files statically reachable from `entry`, plus bare imports seen. */
function staticClosure(entry: string): { files: Set<string>; bareModules: Set<string> } {
  const files = new Set<string>();
  const bareModules = new Set<string>();
  const queue = [resolve(repoRoot, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, 'utf8');
    // Collect non-relative statics too — 'fastify' itself would show up here.
    const externalRe = /(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?from\s*)?['"]([^'".][^'"]*)['"]/g;
    for (const m of source.matchAll(externalRe)) bareModules.add(m[1]!);
    for (const spec of staticRelativeImports(source)) {
      const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
      queue.push(target);
    }
  }
  return { files, bareModules };
}

describe('core static import closure (#1005)', () => {
  test('ActorSystem never statically reaches fastify', () => {
    const { files, bareModules } = staticClosure('src/ActorSystem.ts');
    const fastifyFiles = [...files].filter((f) => f.endsWith('FastifyBackend.ts'));
    expect(fastifyFiles).toEqual([]);
    expect(bareModules.has('fastify')).toBe(false);
  });

  test('the canary is a real one — FastifyBackend itself does import fastify', () => {
    // Without this, the assertion above could pass because the walker went
    // blind, and it would keep passing if the static edge came back.
    const { bareModules } = staticClosure('src/http/backend/FastifyBackend.ts');
    expect(bareModules.has('fastify')).toBe(true);
  });
});
