import { detectRuntime } from '../Detect.js';
import type { ProcessSignals } from './ProcessSignals.js';
import { BunProcessSignals } from './BunProcessSignals.js';
import { DenoProcessSignals } from './DenoProcessSignals.js';
import { NodeProcessSignals } from './NodeProcessSignals.js';

export type { ProcessSignals } from './ProcessSignals.js';
export { UNCATCHABLE_SIGNALS, WINDOWS_DELIVERABLE_SIGNALS } from './ProcessSignals.js';
export { BunProcessSignals } from './BunProcessSignals.js';
export { NodeProcessSignals } from './NodeProcessSignals.js';
export { DenoProcessSignals } from './DenoProcessSignals.js';

let cached: ProcessSignals | null = null;
let override: ProcessSignals | null = null;

/**
 * The {@link ProcessSignals} backend for the current runtime, memoised.
 *
 * Synchronous, unlike `getTcpBackend()` and friends: every backend reads a
 * global that is already there, so there is nothing to `import()` and
 * nothing to await.  That is what lets `installProcessHooks()` stay the
 * synchronous call it has always been.
 */
export function getProcessSignals(): ProcessSignals {
  if (override) return override;
  if (cached) return cached;
  cached = createProcessSignals();
  return cached;
}

function createProcessSignals(): ProcessSignals {
  switch (detectRuntime()) {
    case 'bun': return new BunProcessSignals();
    case 'deno': return new DenoProcessSignals();
    case 'node': return new NodeProcessSignals();
  }
}

/**
 * Test-only seam: force a specific backend, or `null` to restore detection.
 * Deliberately not re-exported from `src/index.ts`.
 */
export function setProcessSignalsOverride(backend: ProcessSignals | null): void {
  override = backend;
}

/** Test hook: drop the memoised backend so the next call re-detects. */
export function resetProcessSignalsCache(): void {
  cached = null;
}
