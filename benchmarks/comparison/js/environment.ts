/**
 * What the machine was, when the run happened, and which actor-ts it was.
 *
 * A comparison table without this block is unreadable six months later: every
 * row is a ratio against hardware nobody recorded, taken on a tree nobody can
 * identify.  Worse, it is unfalsifiable — a stale arm and a fresh one look
 * identical once the numbers are in a table together.
 *
 * So every result file carries its own environment, and `report.ts` prints
 * them side by side.  A row measured on different hardware, or three months
 * earlier, or against a different commit, is then visible as exactly that
 * rather than silently averaged in.
 */
import { execFileSync } from 'node:child_process';
import { cpus, totalmem, platform, release, arch } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Hardware, operating system and tree identity for one measurement run. */
export type EnvironmentBlock = {
  readonly cpuModel: string;
  readonly logicalCores: number;
  readonly memoryBytes: number;
  readonly os: string;
  /** ISO date (YYYY-MM-DD) the run was taken. */
  readonly date: string;
  readonly actorTsVersion: string;
  /**
   * Short commit of the tree under measurement, suffixed `-dirty` when the
   * working tree had uncommitted changes.  A dirty measurement is not
   * reproducible, and saying so is cheaper than discovering it later.
   */
  readonly actorTsCommit: string;
};

const REPOSITORY_ROOT = join(import.meta.dirname ?? '.', '..', '..', '..');

/**
 * Run a git command against the repository root, returning `null` rather than
 * throwing — a tarball export or a shallow copy is a legitimate place to run
 * a benchmark, it just cannot say which commit it was.
 */
function git(...args: ReadonlyArray<string>): string | null {
  try {
    return execFileSync('git', [...args], { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function commitIdentity(): string {
  const head = git('rev-parse', '--short', 'HEAD');
  if (head === null) return 'unknown';
  // The run's own output is excluded from the dirtiness check. `results/` is
  // tracked, so a re-measurement that clears it first — or simply writes into
  // it — would otherwise mark every measurement `-dirty`, and a marker that is
  // always on says nothing. What matters here is whether the *code* under
  // measurement matches the commit.
  const status = git('status', '--porcelain', '--', ':!benchmarks/comparison/results');
  return status === null || status.length === 0 ? head : `${head}-dirty`;
}

/** The version of actor-ts under measurement, from the root manifest. */
export function actorTsVersion(): string {
  try {
    const manifest = readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8');
    return (JSON.parse(manifest) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Capture the environment of the process taking the measurement. */
export function captureEnvironment(): EnvironmentBlock {
  const processors = cpus();
  return {
    cpuModel: processors[0]?.model.trim() ?? 'unknown',
    logicalCores: processors.length,
    memoryBytes: totalmem(),
    os: `${platform()} ${release()} (${arch()})`,
    date: new Date().toISOString().slice(0, 10),
    actorTsVersion: actorTsVersion(),
    actorTsCommit: commitIdentity(),
  };
}

/** Which JavaScript runtime is executing this arm, and at which version. */
export type RuntimeIdentity = {
  readonly name: string;
  readonly version: string;
};

/**
 * Identify the runtime.
 *
 * This is published next to every JavaScript row, because "nact on Node 26"
 * and "nact on Bun 1.3" are two different measurements and a table that
 * conflates them is telling the reader something untrue.
 */
export function detectRuntime(): RuntimeIdentity {
  const bunVersion = (globalThis as { Bun?: { version: string } }).Bun?.version;
  if (bunVersion !== undefined) return { name: 'bun', version: bunVersion };

  const denoVersion = (globalThis as { Deno?: { version: { deno: string } } }).Deno?.version.deno;
  if (denoVersion !== undefined) return { name: 'deno', version: denoVersion };

  return { name: 'node', version: process.versions.node };
}
