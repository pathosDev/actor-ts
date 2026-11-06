/**
 * Runtime detection for actor-ts.
 *
 * The framework runs on three JS runtimes — Bun, Node.js, and Deno.  Most of
 * the codebase is runtime-neutral TypeScript that uses `node:*` modules or
 * standard Web APIs, but a few capabilities (TCP sockets, HTTP-server-from-
 * fetch-handler, Web Workers, SQLite) need a per-runtime backend.  This
 * module is the shared place where those backends ask "what am I running
 * under?" so the answer is cached, consistent, and overridable in tests.
 *
 * The module has no dependencies and no side effects beyond the memoised
 * cache — it is safe to import from any layer.
 */

export type RuntimeKind = 'bun' | 'node' | 'deno';

type GlobalShape = {
  readonly Bun?: { nanoseconds?: () => number; version?: string } & Record<string, unknown>;
  readonly Deno?: { version?: { deno?: string } } & Record<string, unknown>;
  readonly process?: { versions?: { node?: string; bun?: string; deno?: string } };
  readonly performance?: { now(): number };
};

const globalScope: GlobalShape = globalThis as unknown as GlobalShape;

import { Lazy } from '../util/Lazy.js';

/**
 * The detected runtime.  `Lazy.of(...)` runs the detection once and then
 * memoises.  Test overrides go through `setOverride` (below) which uses
 * `Lazy.setOverride` under the hood — no explicit cache bookkeeping.
 */
const runtimeLazy: Lazy<RuntimeKind> = Lazy.of<RuntimeKind>(() => {
  if (typeof globalScope.Bun !== 'undefined') return 'bun';
  if (typeof globalScope.Deno !== 'undefined') return 'deno';
  return 'node';
});

/** Returns the current runtime.  Cached after first call. */
export function detectRuntime(): RuntimeKind { return runtimeLazy.get(); }

/** True iff `globalThis.Bun` is present. */
export function hasBun(): boolean { return typeof globalScope.Bun !== 'undefined'; }

/** True iff `globalThis.Deno` is present. */
export function hasDeno(): boolean { return typeof globalScope.Deno !== 'undefined'; }

/**
 * High-resolution timestamp in nanoseconds.  Uses `Bun.nanoseconds()` when
 * available (it is truly ns-resolution); otherwise falls back to
 * `performance.now() * 1e6` which is ms-resolution × 1_000_000 — ~µs
 * precision on Node and Deno, still good enough for benchmark harness
 * purposes (individual iteration jitter swamps any sub-µs accuracy).
 */
export function highResNow(): number {
  const bunNs = globalScope.Bun?.nanoseconds;
  if (typeof bunNs === 'function') return bunNs();
  const perf = globalScope.performance;
  if (perf && typeof perf.now === 'function') return perf.now() * 1_000_000;
  // Last-resort: Date.now() has ms resolution.  Any benchmark running in
  // such a degraded environment deserves what it gets.
  return Date.now() * 1_000_000;
}

/**
 * The version of `runtime` this process runs on, as that runtime spells it —
 * or `'0.0.0'` when it is not the runtime actually running.  That case is a
 * test that forced another runtime with {@link setRuntimeOverride}, and the
 * oldest version is the answer that makes every capability gate keyed on it
 * fall back to what the oldest release of that runtime can do.
 */
export function runtimeVersion(runtime: RuntimeKind = detectRuntime()): string {
  const found = runtime === 'bun'
    ? globalScope.Bun?.version
    : runtime === 'deno'
      ? globalScope.Deno?.version?.deno
      : globalScope.Bun === undefined && globalScope.Deno === undefined ? globalScope.process?.versions?.node : undefined;
  return found ?? '0.0.0';
}

/**
 * Whether a `major.minor.patch` version string is at or past `since`.  A
 * pre-release or build suffix after `-` is ignored, and a field that does not
 * parse reads as 0.  It answers capability gates for releases this project
 * measured, which are plain triples.
 */
export function versionAtLeast(version: string, since: string): boolean {
  const parse = (text: string): number[] =>
    text.split('-')[0]!.split('.').slice(0, 3).map((field) => Number.parseInt(field, 10) || 0);
  const [major = 0, minor = 0, patch = 0] = parse(version);
  const [sinceMajor = 0, sinceMinor = 0, sincePatch = 0] = parse(since);
  if (major !== sinceMajor) return major > sinceMajor;
  if (minor !== sinceMinor) return minor > sinceMinor;
  return patch >= sincePatch;
}

/**
 * Test-only hook: force `detectRuntime()` to return a specific value.  Pass
 * `null` to restore real detection.  Intentionally NOT re-exported from
 * `src/index.ts` — it is an internal seam.
 */
export function setRuntimeOverride(r: RuntimeKind | null): void {
  runtimeLazy.setOverride(r);
}
