/**
 * Run the full benchmark suite, one file per sub-process.  Each suite
 * owns its own ActorSystem, so running them isolated avoids memory
 * pressure bleeding into the next suite's measurements.
 *
 *   bun run benchmarks/run-all.ts
 *   bun run benchmarks/run-all.ts --group=single-node
 *   bun run benchmarks/run-all.ts --exclude=worker
 *
 * CLI flags:
 *   --group=<name>            — only run suites under benchmarks/<name>/
 *   --exclude=<name>[,<name>] — skip these groups (applied after --group)
 *   --list                    — list all discovered suites and exit
 *
 * Exits non-zero if any suite failed, so `bun run bench` / `bench:smoke`
 * can gate CI.  Every suite still runs — one broken benchmark must not
 * hide the state of the other twenty-three.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ansi } from './lib/stats.js';

type Suite = {
  readonly group: string;
  readonly file: string;
};

const root = resolve(import.meta.dirname ?? '.', '.');

function discover(): Suite[] {
  const out: Suite[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    // `comparison/` is skipped by name rather than by the `_` convention:
    // it is a whole tree with its own manifest, its own lockfile and its
    // own driver (#27).  Its arms import the frameworks they measure
    // against, which the root install deliberately does not carry — so
    // discovering them here would break `bun run bench` on every clean
    // clone and every CI run, for suites this driver cannot run anyway.
    if (entry === 'lib' || entry === 'comparison' || entry === 'run-all.ts' || entry.endsWith('.md')) continue;
    if (!statSync(full).isDirectory()) continue;
    for (const f of readdirSync(full)) {
      // Skip helpers (prefix `_`) and non-TS files.  Helpers are referenced
      // by benchmarks (e.g. worker bootstraps) but are not benchmarks themselves.
      if (!f.endsWith('.ts') || f.startsWith('_')) continue;
      out.push({ group: entry, file: join(full, f) });
    }
  }
  return out.sort((a, b) =>
    a.group === b.group ? a.file.localeCompare(b.file) : a.group.localeCompare(b.group),
  );
}

function run(): void {
  const args = process.argv.slice(2);
  const groupFlag = args.find((a) => a.startsWith('--group='))?.slice('--group='.length);
  const excludeFlag = args.find((a) => a.startsWith('--exclude='))?.slice('--exclude='.length);
  const listOnly = args.includes('--list');

  const excluded = new Set(
    (excludeFlag ?? '').split(',').map((g) => g.trim()).filter((g) => g.length > 0),
  );

  const suites = discover();
  const filtered = (groupFlag ? suites.filter((s) => s.group === groupFlag) : suites)
    .filter((s) => !excluded.has(s.group));
  if (filtered.length === 0) {
    console.error(
      groupFlag
        ? `No benchmarks found under group "${groupFlag}".  Known: ${[...new Set(suites.map((s) => s.group))].join(', ')}`
        : 'No benchmarks found.',
    );
    process.exit(1);
  }
  // Name what was skipped — a silent exclusion reads as "everything ran".
  if (excluded.size > 0) {
    console.log(ansi.gray(`  (skipping group(s): ${[...excluded].join(', ')})`));
  }
  if (listOnly) {
    for (const s of filtered) console.log(`${s.group}  ${s.file}`);
    return;
  }

  const title = `actor-ts · benchmark suite (${filtered.length} files)`;
  const border = '─'.repeat(title.length + 4);
  console.log();
  console.log(ansi.gray('╭' + border + '╮'));
  console.log(ansi.gray('│  ') + ansi.bold(ansi.cyan(title)) + ansi.gray('  │'));
  console.log(ansi.gray('╰' + border + '╯'));

  const start = Date.now();

  const failed: string[] = [];
  for (const s of filtered) {
    const rel = s.file.slice(root.length + 1).replace(/\\/g, '/');
    console.log('\n' + ansi.cyan('▸ ') + ansi.bold(s.group) + ansi.gray(' / ') + rel);
    const result = spawnSync('bun', ['run', s.file], { stdio: 'inherit' });
    if (result.status !== 0) {
      console.error(ansi.red(`  [exit=${result.status}] ${s.file}`));
      failed.push(rel);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('\n' + ansi.gray('─'.repeat(60)));

  // Every suite runs even when an earlier one dies (one broken benchmark
  // should not hide the state of the other twenty), but the driver still
  // has to REPORT that failure in its exit code — otherwise `bun run
  // bench` is green while the suite is on fire, which is exactly how #506
  // survived: ten suites failing to import, exit status 0.
  if (failed.length > 0) {
    console.log(
      `  ${ansi.red('✗')} ${failed.length} of ${filtered.length} suites failed `
      + `— total wall time ${ansi.bold(elapsed + 's')}`,
    );
    for (const f of failed) console.log(ansi.red(`      ${f}`));
    process.exit(1);
  }

  console.log(`  ${ansi.green('✓')} done — total wall time ${ansi.bold(elapsed + 's')}`);
}

run();
