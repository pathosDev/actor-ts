/**
 * How many threads this machine can actually run at once — what an `'auto'`
 * worker count resolves to (#1562, #1440).
 *
 * `navigator.hardwareConcurrency` is what the worker count read before, and
 * it is the wrong number inside a container: it reports the *host's* cores,
 * not the cgroup CPU quota the process is actually allowed, so an `'auto'`
 * pool on a 2-CPU pod of a 64-core node came up with 64 workers.
 * `os.availableParallelism()` (Node ≥ 18.14, Bun, Deno's Node compatibility
 * layer) is quota-aware on Linux, which is where containers run.  So: that
 * first, the navigator second, and the same conservative `2` the framework
 * always fell back to.
 *
 * Async because `node:os` is reached through a dynamic import, the same way
 * every other runtime seam here loads its runtime-specific module — a static
 * import would fail on a target with no `node:os` at all.  The answer is
 * memoised: the machine does not change mid-process.
 */

import { Lazy } from '../util/Lazy.js';

const FALLBACK_PARALLELISM = 2;

let resolved: Promise<number> | null = null;

/** The memoised probe — see the module note. */
export function availableParallelism(): Promise<number> {
  if (resolved === null) resolved = probe();
  return resolved;
}

/**
 * Drop the memoised answer so the next call probes again.  Only a test that
 * stubs the runtime has a reason to; the machine itself does not change.
 */
export function resetAvailableParallelismCache(): void {
  resolved = null;
}

async function probe(): Promise<number> {
  const fromOs = await fromOperatingSystem();
  if (fromOs !== null) return fromOs;
  const fromNavigator = navigatorConcurrency.get();
  return fromNavigator ?? FALLBACK_PARALLELISM;
}

/**
 * `os.availableParallelism()`, or `null` where the module or the function is
 * missing — an older Node, a browser bundle, a runtime that does not polyfill
 * it.  The import specifier is a variable so a bundler that inlines this
 * package does not try to resolve `node:os` for a browser target.
 */
async function fromOperatingSystem(): Promise<number | null> {
  try {
    const moduleName = 'node:os';
    const os = (await import(moduleName)) as { availableParallelism?: () => number };
    const count = os.availableParallelism?.();
    return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : null;
  } catch {
    return null;
  }
}

const navigatorConcurrency: Lazy<number | null> = Lazy.of<number | null>(() => {
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
  const count = nav?.hardwareConcurrency;
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : null;
});
