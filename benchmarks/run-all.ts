/**
 * Run the full benchmark suite, one file per sub-process.  Each suite
 * owns its own ActorSystem, so running them isolated avoids memory
 * pressure bleeding into the next suite's measurements.
 *
 *   bun run benchmarks/run-all.ts
 *   bun run benchmarks/run-all.ts --group=single-node
 *
 * CLI flags:
 *   --group=<name>   — only run suites under benchmarks/<name>/
 *   --list           — list all discovered suites and exit
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ansi } from './lib/stats.js';

interface Suite {
  readonly group: string;
  readonly file: string;
}

const root = resolve(import.meta.dirname ?? '.', '.');

function discover(): Suite[] {
  const out: Suite[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (entry === 'lib' || entry === 'run-all.ts' || entry.endsWith('.md')) continue;
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
  const listOnly = args.includes('--list');

  const suites = discover();
  const filtered = groupFlag ? suites.filter((s) => s.group === groupFlag) : suites;
  if (filtered.length === 0) {
    console.error(
      groupFlag
        ? `No benchmarks found under group "${groupFlag}".  Known: ${[...new Set(suites.map((s) => s.group))].join(', ')}`
        : 'No benchmarks found.',
    );
    process.exit(1);
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

  for (const s of filtered) {
    const rel = s.file.slice(root.length + 1).replace(/\\/g, '/');
    console.log('\n' + ansi.cyan('▸ ') + ansi.bold(s.group) + ansi.gray(' / ') + rel);
    const result = spawnSync('bun', ['run', s.file], { stdio: 'inherit' });
    if (result.status !== 0) console.error(ansi.red(`  [exit=${result.status}] ${s.file}`));
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('\n' + ansi.gray('─'.repeat(60)));
  console.log(`  ${ansi.green('✓')} done — total wall time ${ansi.bold(elapsed + 's')}`);
}

run();
