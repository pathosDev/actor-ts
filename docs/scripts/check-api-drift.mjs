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

/**
 * Pages that legitimately spell an old name because they are *about* another
 * framework's API.  The migration guides contrast Akka's own `Props`,
 * `entityProps` and friends against the actor-ts equivalent, inside `scala` /
 * `csharp` fences — renaming those would make the comparison nonsense.
 *
 * Matched as a path suffix, so one entry covers a page and its translations.
 */
const ALLOWED_IN = {
  'Props.create': ['migration/from-akka-jvm.mdx', 'migration/from-akka-net.mdx'],
  entityProps: ['migration/from-akka-jvm.mdx', 'migration/from-akka-net.mdx'],
  singletonProps: ['migration/from-akka-jvm.mdx', 'migration/from-akka-net.mdx'],
  childProps: ['migration/from-akka-jvm.mdx', 'migration/from-akka-net.mdx'],
};

/** { pattern, reason } — `pattern` is matched literally against each line. */
const FORBIDDEN = [
  { pattern: 'new DefaultAdapter', reason: 'removed — use defaultsAdapter({ ... })' },
  { pattern: 'new MigratingAdapter', reason: 'removed — use migratingAdapter(chain)' },
  { pattern: 'wrapLegacy(', reason: 'no such function — use wrapEventAsEnvelope / migrateInMemoryJournal' },
  { pattern: 'MigrationChain.start', reason: 'renamed — use MigrationChain.for(name, v).add(...)' },
  { pattern: 'SqliteOffsetStore', reason: 'no such class — use InMemoryOffsetStore or DurableStateOffsetStore(store)' },
  { pattern: 'new SqliteQuery({', reason: 'SqliteQuery takes a SqliteJournal instance, not an options object' },
  // The Props removal (#547) is the largest API removal the project has made,
  // and it shipped without a single entry here — which is exactly how four
  // pages went on showing `spawn(props, name)` until a human read them (#907).
  { pattern: 'Props.create', reason: 'removed — pass the actor class: spawn(MyActor, name)' },
  { pattern: 'Props.empty', reason: 'removed — pass the actor class: spawn(MyActor, name)' },
  { pattern: 'spawn(props', reason: 'Props is gone — spawn(MyActor, name), or spawn(() => new MyActor(dep), name)' },
  { pattern: 'entityProps', reason: 'renamed — withEntityActor(...) / the entityActor field' },
  { pattern: 'singletonProps', reason: 'renamed — withSingletonActor(...) / the singletonActor field' },
  { pattern: 'childProps', reason: 'renamed — the child field (+ childOptions)' },
  { pattern: 'routeeProps', reason: 'renamed — the routee field (+ routeeOptions)' },
  { pattern: 'typedProps', reason: 'renamed — typedActor' },
  { pattern: 'behaviorFor', reason: 'renamed — actorFor' },
  { pattern: 'asInternal(', reason: 'renamed — ActorOptions.withInternal()' },
  { pattern: 'BackoffSupervisor.props', reason: 'renamed — BackoffSupervisor.factory' },
  { pattern: 'ClusterRouter.props', reason: 'renamed — ClusterRouter.factory' },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.mdx?$/.test(entry)) yield full;
  }
}

/** Is `pattern` allowed to appear in `relative` (a doc-root-relative path)? */
function isAllowed(pattern, relative) {
  const normalised = relative.replace(/\\/g, '/');
  return (ALLOWED_IN[pattern] ?? []).some((suffix) => normalised.endsWith(suffix));
}

const hits = [];
for (const file of walk(DOCS_ROOT)) {
  const relative = file.replace(DOCS_ROOT, '');
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const { pattern, reason } of FORBIDDEN) {
      if (!line.includes(pattern)) continue;
      if (isAllowed(pattern, relative)) continue;
      hits.push({ file: relative, line: i + 1, pattern, reason, text: line.trim() });
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
