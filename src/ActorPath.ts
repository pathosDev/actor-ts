/** Whole-segment values that would carry traversal meaning in a path. */
const TRAVERSAL_SEGMENTS: ReadonlySet<string> = new Set(['.', '..']);

/**
 * Prefix the framework keeps for the names it picks itself — today
 * `$anonymous-<n>-<random>` from `spawnAnonymous`.
 */
export const RESERVED_NAME_PREFIX = '$';

/**
 * True when `name` contains a C0 control character or DEL.
 *
 * Deliberately a codepoint scan rather than a regex: a character class for
 * these would either embed literal control bytes — which makes this source
 * file read as binary to git — or depend on escape sequences surviving every
 * tool that rewrites the file. Comparing numbers avoids both.
 */
function hasControlCharacter(name: string): boolean {
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Reject an actor name that would corrupt the path it becomes part of.
 *
 * A path is rendered as `actor-ts://<system>/<segment>/<segment>…` and taken
 * apart again by splitting on `/` ({@link parsePathSegments}).  A name
 * containing a separator therefore does not merely look wrong — it changes the
 * *structure*: `spawn(actor, 'a/b')` yields a path indistinguishable from a
 * child `b` of an actor `a`, so it collides with, or impersonates, a different
 * actor — including across the cluster wire, where the remote side re-splits
 * the string.  `.` and `..` carry the same risk through traversal meaning
 * rather than through a separator.
 *
 * Control characters are rejected because paths are written to logs and trace
 * spans, where a newline in a name lets a caller forge log lines.
 *
 * An empty name is legal *only* for a root, which several synthetic refs
 * (`deadLetters`, `nobody`, a test probe's parent) rely on.  Below a parent it
 * would produce an empty segment, and since `parsePathSegments` filters those
 * out, the local and remote renderings of one actor would disagree.
 */
function assertValidName(name: string, parent: ActorPath | null): void {
  const reject = (reason: string): never => {
    const where = parent === null ? 'actor path root' : `child of ${parent.toString()}`;
    throw new Error(`Invalid actor name ${JSON.stringify(name)} (${where}): ${reason}`);
  };

  if (name === '') {
    if (parent === null) return; // a synthetic root — allowed, and relied upon
    reject('must not be empty');
  }
  if (name.includes('/') || name.includes('\\')) {
    reject('must not contain a path separator ("/" or "\\")');
  }
  if (TRAVERSAL_SEGMENTS.has(name)) {
    reject('must not be "." or ".."');
  }
  if (hasControlCharacter(name)) {
    reject('must not contain control characters');
  }
}

/**
 * Reject a caller-chosen actor name that trespasses on the framework's own
 * namespace.
 *
 * {@link RESERVED_NAME_PREFIX} marks a name the framework handed out rather
 * than one the application asked for.  While anyone could claim it, a
 * `spawn(actor, '$anonymous-1-…')` could collide with — or stand in for — a
 * name `spawnAnonymous` is entitled to generate, and which of the two got
 * there first depended on spawn order.
 *
 * Deliberately **not** folded into {@link assertValidName}, even though both
 * are "rules about names".  That one runs on every `ActorPath` ever
 * constructed, and paths are rebuilt from strings on the receiving side of the
 * cluster wire — `RemoteActorRef` walks `.child(segment)` across a parsed path
 * — so enforcing this there would make every remote reference to an anonymous
 * actor throw on arrival.  The distinction is real and worth keeping:
 * `assertValidName` says what a path may *contain*, this says who may *choose*
 * it, and only the second one has a spawn call to attach to.
 */
export function assertUserAssignableName(name: string, parent: ActorPath): void {
  if (!name.startsWith(RESERVED_NAME_PREFIX)) return;
  throw new Error(
    `Invalid actor name ${JSON.stringify(name)} (child of ${parent.toString()}): `
    + `names starting with "${RESERVED_NAME_PREFIX}" are reserved for framework-generated `
    + 'names — use spawnAnonymous() if you want the framework to name it',
  );
}

/**
 * Hierarchical, unique path identifying an actor inside an ActorSystem.
 * Format: actor-ts://<system>/<segment>/<segment>...
 */
export class ActorPath {
  constructor(
    public readonly name: string,
    public readonly parent: ActorPath | null = null,
    public readonly systemName: string = 'default',
    public readonly uid: number = 0,
  ) {
    assertValidName(name, parent);
  }

  /**
   * Create a child path under this one.  Inherits the constructor's name
   * validation, which is what makes an empty segment impossible here while
   * still allowing one for a root.
   */
  child(name: string, uid: number = 0): ActorPath {
    return new ActorPath(name, this, this.systemName, uid);
  }

  /** All path segments from root to this path (including root). */
  elements(): string[] {
    const out: string[] = [];
    let current: ActorPath | null = this;
    while (current) {
      out.unshift(current.name);
      current = current.parent;
    }
    return out;
  }

  /** Full depth of the path (root has depth 0). */
  depth(): number {
    return this.parent ? this.parent.depth() + 1 : 0;
  }

  /** True if this path is an ancestor of other. */
  isAncestorOf(other: ActorPath): boolean {
    let ancestor: ActorPath | null = other.parent;
    while (ancestor) {
      if (ancestor.equals(this)) return true;
      ancestor = ancestor.parent;
    }
    return false;
  }

  equals(other: ActorPath): boolean {
    return this.toString() === other.toString();
  }

  /**
   * Canonical URI form: `actor-ts://system/user/foo/bar`.
   *
   * Memoized, because this is a hot read on an immutable value.  Every field is
   * `readonly` and the parent chain is fixed at construction, so the rendering
   * cannot change once computed.  It is called far more often than it looks:
   * `equals` renders *both* sides, ref comparison goes through `equals`, and
   * dead-letter routing, the receptionist and the DevTools taps all key on the
   * string — so a deep path was re-walking its ancestors and re-joining an array
   * on each one.
   */
  toString(): string {
    return this.rendered ??= this.render();
  }

  /**
   * Not `readonly`, and set through `??=` rather than in the constructor: paths
   * are created on every spawn, including for actors whose path is never
   * rendered, so the walk is deferred until something asks.
   */
  private rendered: string | undefined;

  private render(): string {
    const segments = this.elements();
    // First element is the system root name; render as actor-ts://<sys>/remainder
    if (segments.length <= 1) return `actor-ts://${this.systemName}/`;
    return `actor-ts://${this.systemName}/${segments.slice(1).join('/')}`;
  }
}

/**
 * Extract the `user/foo/bar` segments from `actor-ts://system/user/foo/bar` —
 * the inverse of {@link ActorPath.toString}.
 *
 * Lives here rather than next to its callers because it is the counterpart of
 * `render`, and because `ActorPath.ts` imports nothing: anything that needs to
 * take a path string apart can reach it without risking a module cycle.  The
 * cluster's `RefCodec` both consumes this and constructs `RemoteActorRef`s,
 * which in turn have to rebuild a path from a string — importing it from there
 * would close that loop.
 *
 * Empty segments are dropped, so a doubled or trailing separator collapses; a
 * string that isn't a path at all yields `[]`.
 *
 * **A segment is returned verbatim — nothing here unescapes it, and nothing
 * should start.** Sharding builds entity child names by escaping the
 * user-supplied entity id (`entityName` in `cluster/sharding/Shard.ts`), and
 * that escape is only injective as long as the name stays escaped everywhere.
 * Decoding a segment on the way back in would make two distinct entity ids
 * resolve to one path again — the collision #568 was filed for. A path is an
 * opaque address; the id is carried in the message and on the entity context.
 */
export function parsePathSegments(path: string): string[] {
  const match = /^actor-ts:\/\/[^/]+\/?(.*)$/.exec(path);
  if (!match) return [];
  const rest = match[1] ?? '';
  return rest.split('/').filter((s) => s.length > 0);
}
