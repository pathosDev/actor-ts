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

  /** Replace everything — a fresh snapshot. */
  reset(actors: ReadonlyArray<ActorNode>): void {
    this.nodes = new Map(actors.map((actor) => [actor.path, actor]));
  }

  /** Insert or update one actor. */
  upsert(actor: ActorNode): void {
    this.nodes.set(actor.path, actor);
  }

  /**
   * Remove an actor and everything beneath it.
   *
   * The server sends one `actor-stopped` for each cell, but ordering
   * between parent and child is not guaranteed to reach the client
   * intact — dropping the subtree makes the removal idempotent either
   * way, so no orphan can survive a missed frame.
   */
  remove(path: string): void {
    for (const key of [...this.nodes.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
    }
    this.collapsed.delete(path);
  }

  get size(): number {
    return this.nodes.size;
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
        rows.push({ node, depth, hasChildren: children.length > 0, expanded });
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
