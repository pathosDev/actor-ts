/**
 * The actor-tree model: apply deltas, produce a rendered ordering.
 *
 * Pure logic, deliberately separated from the DOM.  Reconciling a live
 * tree from a snapshot plus deltas has the failure modes worth testing
 * (an orphan whose parent is gone, a stop that must take a subtree with
 * it, a delta that arrives before its snapshot); the row markup does
 * not.
 */
import type { ActorNode } from '../../../../src/devtools/protocol/index.js';

/** One row of the flattened tree. */
export interface TreeRow {
  readonly node: ActorNode;
  /** Nesting level; the root guardian is 0. */
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  /** When this actor stopped, or `null` while it is alive. */
  readonly stoppedAtMs: number | null;
}

/**
 * Live actor tree.
 *
 * Keyed by path, which is what makes the delta protocol safe: a
 * duplicate `actor-started` is an overwrite rather than a second entry,
 * so a delta that races the snapshot cannot corrupt the view.
 */
export class ActorTreeModel {
  private nodes = new Map<string, ActorNode>();
  private readonly collapsed = new Set<string>();
  /** Path → when it stopped.  A tombstone the sweeper will collect. */
  private readonly stopped = new Map<string, number>();

  /** Replace everything — a fresh snapshot. */
  reset(actors: ReadonlyArray<ActorNode>): void {
    this.nodes = new Map(actors.map((actor) => [actor.path, actor]));
    // A snapshot describes only living actors, so tombstones from the
    // previous connection have nothing left to point at.
    this.stopped.clear();
  }

  /** Insert or update one actor. */
  upsert(actor: ActorNode): void {
    this.nodes.set(actor.path, actor);
    // A path can be reused: the new actor is alive, whatever the old one
    // did.
    this.stopped.delete(actor.path);
  }

  /**
   * Mark an actor and everything beneath it as stopped.
   *
   * Deleting the row on the spot was technically correct and useless in
   * practice — an actor that dies is exactly the one you were trying to
   * look at, and it vanished before you could. The row stays, reads as
   * terminated, and {@link sweep} collects it later.
   *
   * The server sends one `actor-stopped` for each cell, but ordering
   * between parent and child is not guaranteed to reach the client
   * intact — marking the subtree makes this idempotent either way, so no
   * orphan can survive a missed frame still claiming to be alive.
   */
  markStopped(path: string, atMs: number): void {
    for (const [key, node] of this.nodes) {
      if (key !== path && !key.startsWith(`${path}/`)) continue;
      if (!this.stopped.has(key)) this.stopped.set(key, atMs);
      this.nodes.set(key, { ...node, cellState: 'terminated', suspended: false });
    }
    this.collapsed.delete(path);
  }

  /**
   * Drop tombstones older than `retentionMs`.  Returns whether anything
   * went, so a caller can skip a re-render on a quiet tick.
   */
  sweep(nowMs: number, retentionMs: number): boolean {
    let removed = false;
    for (const [path, atMs] of this.stopped) {
      if (nowMs - atMs < retentionMs) continue;
      this.stopped.delete(path);
      this.nodes.delete(path);
      this.collapsed.delete(path);
      removed = true;
    }
    return removed;
  }

  /** Live actors — tombstones are shown, but they are not population. */
  get size(): number {
    return this.nodes.size - this.stopped.size;
  }

  get stoppedCount(): number {
    return this.stopped.size;
  }

  has(path: string): boolean {
    return this.nodes.has(path);
  }

  get(path: string): ActorNode | undefined {
    return this.nodes.get(path);
  }

  /** Collapse or expand a subtree. */
  toggle(path: string): void {
    if (this.collapsed.has(path)) this.collapsed.delete(path);
    else this.collapsed.add(path);
  }

  isCollapsed(path: string): boolean {
    return this.collapsed.has(path);
  }

  /**
   * Flatten to display order: parents before children, siblings by name.
   *
   * Nodes whose parent is unknown are treated as roots rather than
   * dropped — losing an actor from the view because its parent's frame
   * went missing would be worse than showing it slightly out of place.
   */
  rows(filter = ''): ReadonlyArray<TreeRow> {
    const childrenByParent = new Map<string | null, ActorNode[]>();
    for (const node of this.nodes.values()) {
      const parent = node.parentPath !== null && this.nodes.has(node.parentPath)
        ? node.parentPath
        : null;
      const bucket = childrenByParent.get(parent);
      if (bucket === undefined) childrenByParent.set(parent, [node]);
      else bucket.push(node);
    }
    for (const bucket of childrenByParent.values()) {
      bucket.sort((a, b) => a.name.localeCompare(b.name));
    }

    const needle = filter.trim().toLowerCase();
    const matching = needle.length === 0 ? null : this.pathsMatching(needle);

    const rows: TreeRow[] = [];
    const walk = (parent: string | null, depth: number): void => {
      for (const node of childrenByParent.get(parent) ?? []) {
        if (matching !== null && !matching.has(node.path)) continue;
        const children = childrenByParent.get(node.path) ?? [];
        // While filtering, keep everything open — a match hidden inside
        // a collapsed branch is a search that appears to have failed.
        const expanded = matching !== null || !this.collapsed.has(node.path);
        rows.push({
          node,
          depth,
          hasChildren: children.length > 0,
          expanded,
          stoppedAtMs: this.stopped.get(node.path) ?? null,
        });
        if (expanded) walk(node.path, depth + 1);
      }
    };
    walk(null, 0);
    return rows;
  }

  /** Paths that match, plus their ancestors so the branch stays reachable. */
  private pathsMatching(needle: string): Set<string> {
    const keep = new Set<string>();
    for (const node of this.nodes.values()) {
      if (!node.path.toLowerCase().includes(needle)
        && !node.className.toLowerCase().includes(needle)) continue;
      keep.add(node.path);
      let parent = node.parentPath;
      while (parent !== null && !keep.has(parent)) {
        keep.add(parent);
        parent = this.nodes.get(parent)?.parentPath ?? null;
      }
    }
    return keep;
  }
}
