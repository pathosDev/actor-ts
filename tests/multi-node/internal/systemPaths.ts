/**
 * Path segments for `ActorSystem._resolvePath`, derived from the production
 * well-known-path helpers.
 *
 * These suites reach for a framework actor by path to inspect its instance.
 * Hand-writing the segments is how they silently rotted the last time the
 * layout moved: `_resolvePath` returns `None` for a stale path, the finder
 * returns `null`, and the assertion fails on a count rather than on anything
 * that names the real cause.  Deriving them means a layout change either
 * keeps working or fails to compile.
 */
import { coordinatorPath } from '../../../src/cluster/sharding/ShardRegion.js';

/** Strip `actor-ts://<systemName>/` and split — `_resolvePath` walks from root. */
function pathSegments(fullPath: string): string[] {
  return fullPath
    .replace(/^actor-ts:\/\/[^/]+\//, '')
    .split('/')
    .filter((segment) => segment.length > 0);
}

/** Segments locating the ShardCoordinator for `typeName`. */
export function coordinatorSegments(systemName: string, typeName: string): string[] {
  return pathSegments(coordinatorPath(systemName, typeName));
}
