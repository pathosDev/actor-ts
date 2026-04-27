import type { ActorPath } from './ActorPath.js';
import type { ActorRef } from './ActorRef.js';
import type { ActorSystem } from './ActorSystem.js';

/**
 * A lookup handle for a logical actor path.  Unlike `ActorRef`, which is a
 * direct handle to a known actor, an `ActorSelection` is a description of
 * where to look — resolving it walks the current actor tree (locally) or
 * issues a remote lookup.
 *
 * For v1 we support exact paths only (no `*` wildcards).  Messages tell()'d
 * to a selection are delivered synchronously to the first matching actor if
 * it resolves immediately; otherwise they land in dead letters.
 */
export class ActorSelection {
  constructor(
    private readonly system: ActorSystem,
    /** Segments after `/user/` or `/system/`, e.g. ['user', 'foo', 'bar']. */
    readonly pathSegments: ReadonlyArray<string>,
    /** Printable form, convenient for logging. */
    readonly pathString: string,
  ) {}

  /**
   * Resolve to a concrete ActorRef.  Retries until `timeoutMs` elapses if
   * the intermediate cell is in the process of starting (so tests that race
   * spawn+selection are stable).  Rejects with an Error on timeout.
   */
  async resolveOne(timeoutMs = 1_000): Promise<ActorRef> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const refOpt = this.system._resolvePath(this.pathSegments);
      if (refOpt.isSome()) return refOpt.value;
      if (Date.now() >= deadline) {
        throw new Error(`ActorSelection timed out after ${timeoutMs}ms: ${this.pathString}`);
      }
      await new Promise(r => setTimeout(r, 10));
    }
  }

  /**
   * Fire-and-forget: resolve immediately; if no match, drop to dead letters.
   * For cases where you want asynchronous retry, use `resolveOne(...).then(r => r.tell(...))`.
   */
  tell(message: unknown, sender: ActorRef | null = null): void {
    const refOpt = this.system._resolvePath(this.pathSegments);
    if (refOpt.isSome()) refOpt.value.tell(message as never, sender);
    else this.system.deadLetters.tell(message as never, sender);
  }

  toString(): string {
    return `ActorSelection(${this.pathString})`;
  }
}

/**
 * Parse an input string into path segments relative to `/`.  Accepts two
 * shapes:
 *   - absolute URI:   "actor-ts://<sys>/user/foo/bar"
 *   - absolute path:  "/user/foo/bar" or "user/foo/bar"
 *
 * The system-name (if present) is verified to match the target system;
 * mismatch returns null to indicate the path is meant for a different one.
 */
export function parseSelectionPath(
  system: ActorSystem,
  path: string | ActorPath,
): string[] | null {
  const text = typeof path === 'string' ? path : path.toString();
  let rest = text;
  if (rest.startsWith('actor-ts://')) {
    const withoutScheme = rest.slice('actor-ts://'.length);
    const firstSlash = withoutScheme.indexOf('/');
    if (firstSlash < 0) return null;
    const sys = withoutScheme.slice(0, firstSlash);
    if (sys !== system.name) return null;
    rest = withoutScheme.slice(firstSlash + 1);
  }
  if (rest.startsWith('/')) rest = rest.slice(1);
  if (rest.length === 0) return [];
  return rest.split('/').filter(s => s.length > 0);
}
