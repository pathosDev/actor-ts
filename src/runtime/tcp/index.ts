import { detectRuntime, type RuntimeKind } from '../detect.js';
import type { TcpBackend } from './TcpBackend.js';

export type {
  TcpBackend, TcpListener, TcpSocketLike, TcpSocketHandlers, TlsTransportSettings,
} from './TcpBackend.js';
export { BunTcpBackend } from './BunTcpBackend.js';
export { NodeTcpBackend } from './NodeTcpBackend.js';
export { DenoTcpBackend } from './DenoTcpBackend.js';

let cached: TcpBackend | null = null;
let cachedFor: RuntimeKind | null = null;

/**
 * Get the appropriate `TcpBackend` for the current runtime.  Cached across
 * calls.  On Node the first call lazy-imports `node:net` / `node:tls`.
 */
export async function getTcpBackend(): Promise<TcpBackend> {
  const runtime = detectRuntime();
  if (cached && cachedFor === runtime) return cached;
  switch (runtime) {
    case 'bun': {
      const { BunTcpBackend } = await import('./BunTcpBackend.js');
      cached = new BunTcpBackend();
      break;
    }
    case 'node': {
      const { NodeTcpBackend } = await import('./NodeTcpBackend.js');
      cached = new NodeTcpBackend();
      break;
    }
    case 'deno': {
      const { DenoTcpBackend } = await import('./DenoTcpBackend.js');
      cached = new DenoTcpBackend();
      break;
    }
  }
  cachedFor = runtime;
  return cached!;
}

/** Test hook: reset the cached backend. */
export function resetTcpBackendCache(): void {
  cached = null;
  cachedFor = null;
}
