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
  ) {}

  /** Create a child path under this one. */
  child(name: string, uid: number = 0): ActorPath {
    return new ActorPath(name, this, this.systemName, uid);
  }

  /** All path segments from root to this path (including root). */
  elements(): string[] {
    const out: string[] = [];
    let p: ActorPath | null = this;
    while (p) {
      out.unshift(p.name);
      p = p.parent;
    }
    return out;
  }

  /** Full depth of the path (root has depth 0). */
  depth(): number {
    return this.parent ? this.parent.depth() + 1 : 0;
  }

  /** True if this path is an ancestor of other. */
  isAncestorOf(other: ActorPath): boolean {
    let p: ActorPath | null = other.parent;
    while (p) {
      if (p.equals(this)) return true;
      p = p.parent;
    }
    return false;
  }

  equals(other: ActorPath): boolean {
    return this.toString() === other.toString();
  }

  /** Canonical URI form: actor-ts://system/user/foo/bar */
  toString(): string {
    const segments = this.elements();
    // First element is the system root name; render as actor-ts://<sys>/remainder
    if (segments.length <= 1) return `actor-ts://${this.systemName}/`;
    return `actor-ts://${this.systemName}/${segments.slice(1).join('/')}`;
  }
}
