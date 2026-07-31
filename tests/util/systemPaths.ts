/**
 * Path segments for `ActorSystem._resolvePath`, derived from the production
 * well-known-path helpers.
 *
 * Several suites reach for a framework actor by path — to inspect its instance,
 * or to ask which node currently hosts an entity.  Hand-writing the segments is
 * how they silently rotted the last time the layout moved: `_resolvePath`
 * returns `None` for a stale path, so the lookup answers "not here" instead of
 * failing, and the test dies in a `waitFor` timeout that names nothing.
 * Deriving them means a layout change either keeps working or fails to compile.
 */
import { SystemGroups, shardRegionName, systemActorPath } from '../../src/internal/SystemPaths.js';
import { coordinatorPath } from '../../src/cluster/sharding/ShardRegion.js';

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

/** Segments locating the ShardRegion for `typeName` — the parent of its shards. */
export function regionSegments(systemName: string, typeName: string): string[] {
  return pathSegments(
    systemActorPath(systemName, SystemGroups.clusterSharding, shardRegionName(typeName)),
  );
}
