/**
 * The path patterns two blocks are written in: `actor-ts.parallelism.offload`
 * (#1563) and the keys of `actor-ts.deployment` (#868).
 *
 * A pattern is an actor path with wildcards, segment by segment: `*` stands
 * for any run of characters inside one segment (`/user/*`, `/user/resize-*`),
 * and a segment that is exactly `**` stands for one or more whole segments
 * (`/user/**`).  Matching is against the full address-less path of an actor.
 * For offload that is the actor about to be spawned, so the default `/user/*`
 * names every top-level user actor and nothing else — which is all
 * `system.spawn` can create; children are spawned by their parent and stay
 * where the parent runs.  A deployment key matches an actor at any depth,
 * which is what lets it name the routees, connections and entities no spawn
 * site of the operator's creates.
 *
 * No dependencies, on purpose: the offload validator refuses a pattern that
 * could reach `/system`, and it does so with the very matcher placement uses,
 * so the two can never disagree about what a pattern means.  The deployment
 * block does not refuse `/system` — an entry reaches entities and singletons
 * there, by who wrote the class rather than by path — and uses the same
 * matcher for the same reason.
 */

const WILDCARD_SEGMENT = '**';
const SYSTEM_GUARDIAN_SEGMENT = 'system';

/** A compiled pattern: the source it was written as, and the two tests. */
export interface PathPattern {
  readonly source: string;
  /** Whether the pattern matches an absolute path such as `/user/a`. */
  matches(path: string): boolean;
  /**
   * The same test over a path already split into its segments, the root
   * excluded — `['user', 'a']` for `/user/a`.  For a caller that holds an
   * actor's segments and tests them against every pattern of a block: going
   * through {@link matches} would split the path again for each one.
   */
  matchesSegments(segments: ReadonlyArray<string>): boolean;
}

/**
 * Compile one pattern.  Throws on a pattern that is not an absolute path,
 * because a relative one has nothing to be relative to.  The message names a
 * path pattern and nothing more: each block that uses the grammar wraps it in
 * an error naming its own key.
 */
export function compilePathPattern(source: string): PathPattern {
  if (!source.startsWith('/')) {
    throw new Error(`path pattern ${JSON.stringify(source)} must start with '/'`);
  }
  return new CompiledPathPattern(source, splitSegments(source).map(compileSegment));
}

/**
 * The compiled form.  A class, so that a caller testing many patterns in a
 * row — the deployment block, once per spawn (#868) — calls one prototype
 * method throughout instead of a different closure per pattern: measured on
 * eleven patterns behind one call site, closures cost ~690 ns where the same
 * eleven tested one by one summed to ~440 ns.
 *
 * Segment counts settle most non-matches before any segment is compared: a
 * pattern without `**` takes exactly one path segment per matcher, and one
 * with it at least that many, since `**` takes one or more.
 */
class CompiledPathPattern implements PathPattern {
  /** The matchers when no segment is `**` — then segment `i` of a path meets matcher `i`. */
  private readonly oneToOne: ReadonlyArray<OneSegmentMatcher> | null;

  constructor(readonly source: string, private readonly matchers: ReadonlyArray<SegmentMatcher>) {
    this.oneToOne = matchers.every(isOneSegmentMatcher) ? matchers : null;
  }

  matches(path: string): boolean {
    return this.matchesSegments(splitSegments(path));
  }

  matchesSegments(segments: ReadonlyArray<string>): boolean {
    const oneToOne = this.oneToOne;
    if (oneToOne !== null) {
      if (segments.length !== oneToOne.length) return false;
      for (let index = 0; index < oneToOne.length; index++) {
        if (!matchesOneSegment(oneToOne[index]!, segments[index]!)) return false;
      }
      return true;
    }
    if (segments.length < this.matchers.length) return false;
    return matchSegments(this.matchers, segments, 0, 0);
  }
}

/** A segment that is exactly `**`: one or more whole segments. */
type AnyDepthSegmentMatcher = { readonly kind: 'any-depth' };

/**
 * A segment without a `*`: that one name, compared by equality.  Its own
 * variant rather than a regular expression without wildcards, because it is
 * the common segment and the one that decides most non-matches — `user`
 * against `system`, `pool` against `chat` — and an equality test is several
 * times cheaper than a regular expression test, which a deployment block pays
 * once per key and spawn (#868).
 */
type LiteralSegmentMatcher = { readonly kind: 'literal'; readonly name: string };

/** A segment with a `*` inside it: a glob over that one segment. */
type GlobSegmentMatcher = { readonly kind: 'glob'; readonly test: RegExp };

type OneSegmentMatcher = LiteralSegmentMatcher | GlobSegmentMatcher;

type SegmentMatcher = AnyDepthSegmentMatcher | OneSegmentMatcher;

function isOneSegmentMatcher(matcher: SegmentMatcher): matcher is OneSegmentMatcher {
  return matcher.kind !== 'any-depth';
}

function compileSegment(segment: string): SegmentMatcher {
  if (segment === WILDCARD_SEGMENT) return { kind: 'any-depth' };
  if (!segment.includes('*')) return { kind: 'literal', name: segment };
  const escaped = segment
    .split('*')
    .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return { kind: 'glob', test: new RegExp(`^${escaped}$`) };
}

/** Whether a one-segment matcher takes `segment`. */
function matchesOneSegment(matcher: OneSegmentMatcher, segment: string): boolean {
  return matcher.kind === 'literal' ? matcher.name === segment : matcher.test.test(segment);
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
  if (!matchesOneSegment(matcher, segments[segmentIndex]!)) return false;
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
  return matcher.kind === 'any-depth' || matchesOneSegment(matcher, SYSTEM_GUARDIAN_SEGMENT);
}
