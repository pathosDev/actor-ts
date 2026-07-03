import { detectRuntime, type RuntimeKind } from '../detect.js';
import type { HonoServerRunner } from './HonoServerRunner.js';

export type {
  FetchHandler,
  HonoServerHandle,
  HonoServerRunner,
  HonoWebSocketBridge,
  UpgradeWebSocketFn,
  WSContextLike,
  WSEventsLike,
} from './HonoServerRunner.js';
export { BunHonoRunner } from './BunHonoRunner.js';
export { NodeHonoRunner } from './NodeHonoRunner.js';
export { DenoHonoRunner } from './DenoHonoRunner.js';

let cached: HonoServerRunner | null = null;
let cachedFor: RuntimeKind | null = null;

/**
 * Get the appropriate `HonoServerRunner` for the current runtime.  Cached
 * across calls.  On Node the `@hono/node-server` peer is lazy-imported on
 * first `serve()` call, not here.
 */
export async function getHonoRunner(): Promise<HonoServerRunner> {
  const runtime = detectRuntime();
  if (cached && cachedFor === runtime) return cached;
  switch (runtime) {
    case 'bun': {
      const { BunHonoRunner } = await import('./BunHonoRunner.js');
      cached = new BunHonoRunner();
      break;
    }
    case 'node': {
      const { NodeHonoRunner } = await import('./NodeHonoRunner.js');
      cached = new NodeHonoRunner();
      break;
    }
    case 'deno': {
      const { DenoHonoRunner } = await import('./DenoHonoRunner.js');
      cached = new DenoHonoRunner();
      break;
    }
  }
  cachedFor = runtime;
  return cached!;
}

export function resetHonoRunnerCache(): void {
  cached = null;
  cachedFor = null;
}
