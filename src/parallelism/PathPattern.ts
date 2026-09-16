/**
 * The path patterns `actor-ts.parallelism.offload` is written in (#1563).
 *
 * A pattern is an actor path with wildcards, segment by segment: `*` stands
 * for any run of characters inside one segment (`/user/*`, `/user/resize-*`),
 * and a segment that is exactly `**` stands for one or more whole segments
 * (`/user/**`).  Matching is against the full path of the actor about to be
 * spawned, so the default `/user/*` names every top-level user actor and
 * nothing else — which is all `system.spawn` can create; children are spawned
 * by their parent and stay where the parent runs.
 *
 * No dependencies, on purpose: the options validator refuses a pattern that
 * could reach `/system`, and it does so with the very matcher placement uses,
 * so the two can never disagree about what a pattern means.
 */

const WILDCARD_SEGMENT = '**';
const SYSTEM_GUARDIAN_SEGMENT = 'system';

/** A compiled pattern: the segments it was written with, and the test. */
export type PathPattern = {
  readonly source: string;
  readonly matches: (path: string) => boolean;
};

/**
 * Compile one pattern.  Throws on a pattern that is not an absolute path,
 * because a relative one has nothing to be relative to.
 */
export function compilePathPattern(source: string): PathPattern {
  if (!source.startsWith('/')) {
    throw new Error(`offload pattern ${JSON.stringify(source)} must start with '/'`);
  }
  const segments = splitSegments(source);
  const matchers = segments.map(compileSegment);
  return {
    source,
    matches: (path) => matchSegments(matchers, splitSegments(path), 0, 0),
  };
}

type SegmentMatcher =
  | { readonly kind: 'any-depth' }
  | { readonly kind: 'one'; readonly test: RegExp };

function compileSegment(segment: string): SegmentMatcher {
  if (segment === WILDCARD_SEGMENT) return { kind: 'any-depth' };
  const escaped = segment
    .split('*')
    .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return { kind: 'one', test: new RegExp(`^${escaped}$`) };
}

/** `/a/b/` → `['a', 'b']`; the root `/` → `[]`. */
function splitSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function matchSegments(
  matchers: ReadonlyArray<SegmentMatcher>,
  segments: ReadonlyArray<string>,
  matcherIndex: number,
  segmentIndex: number,
): boolean {
  if (matcherIndex === matchers.length) return segmentIndex === segments.length;
  const matcher = matchers[matcherIndex]!;
  if (matcher.kind === 'any-depth') {
    // One or more segments: try every non-empty run the rest can follow.
    for (let taken = segmentIndex + 1; taken <= segments.length; taken++) {
      if (matchSegments(matchers, segments, matcherIndex + 1, taken)) return true;
    }
    return false;
  }
  if (segmentIndex >= segments.length) return false;
  if (!matcher.test.test(segments[segmentIndex]!)) return false;
  return matchSegments(matchers, segments, matcherIndex + 1, segmentIndex + 1);
}

/**
 * Whether a pattern could name anything in the `/system` tree — the guardian
 * itself or any actor at any depth below it.  The options validator refuses
 * such a pattern: system actors are created through `_spawnSystemActor`
 * rather than `spawn`, so the entry would be inert, and no peer may address
 * `/system/…` by name across the wire anyway (#877, #964).
 *
 * Decided on the first segment alone, because that is the whole question: a
 * pattern whose first segment can be `system` — the literal, a glob such as
 * `/s*` or `/*`, or `**` — matches only paths under `/system` (or anything at
 * all), whatever its later segments say; one whose first segment cannot be
 * `system` never reaches the tree however it continues.
 */
export function reachesSystemTree(pattern: PathPattern): boolean {
  const first = splitSegments(pattern.source)[0];
  if (first === undefined) return false;
  const matcher = compileSegment(first);
  return matcher.kind === 'any-depth' || matcher.test.test(SYSTEM_GUARDIAN_SEGMENT);
}
