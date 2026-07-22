#!/usr/bin/env node
/**
 * Guard against documentation drift: fail the build if a doc page references
 * an API name that does not exist in the codebase.  Doc code fences are never
 * type-checked, so renamed/removed APIs silently rot in the docs until a reader
 * copies a broken snippet.  This is a cheap grep-based backstop — not a
 * substitute for compiling fences, but it catches the names that have bitten us.
 *
 * Add a pattern here whenever an API is renamed or removed and the old name
 * must never reappear in the docs.  Run with `npm run check:api-drift` (from
 * docs/) or wire it into the docs CI workflow.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS_ROOT = fileURLToPath(new URL('../src/content/docs/', import.meta.url));

/** { pattern, reason } — `pattern` is matched literally against each line. */
const FORBIDDEN = [
  { pattern: 'new DefaultAdapter', reason: 'removed — use defaultsAdapter({ ... })' },
  { pattern: 'new MigratingAdapter', reason: 'removed — use migratingAdapter(chain)' },
  { pattern: 'wrapLegacy(', reason: 'no such function — use wrapEventAsEnvelope / migrateInMemoryJournal' },
  { pattern: 'MigrationChain.start', reason: 'renamed — use MigrationChain.for(name, v).add(...)' },
  { pattern: 'SqliteOffsetStore', reason: 'no such class — use InMemoryOffsetStore or DurableStateOffsetStore(store)' },
  { pattern: 'new SqliteQuery({', reason: 'SqliteQuery takes a SqliteJournal instance, not an options object' },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.mdx?$/.test(entry)) yield full;
  }
}

const hits = [];
for (const file of walk(DOCS_ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const { pattern, reason } of FORBIDDEN) {
      if (line.includes(pattern)) {
        hits.push({ file: file.replace(DOCS_ROOT, ''), line: i + 1, pattern, reason, text: line.trim() });
      }
    }
  });
}

if (hits.length > 0) {
  console.error(`\n✖ doc API drift: ${hits.length} reference(s) to removed/renamed API names:\n`);
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  "${h.pattern}"  — ${h.reason}`);
    console.error(`      ${h.text}`);
  }
  console.error('\nUpdate the doc snippet to the current API, or adjust docs/scripts/check-api-drift.mjs if the name is now valid.\n');
  process.exit(1);
}

console.log('✓ doc API-drift check passed — no references to removed/renamed API names.');
