/**
 * Aggregated flame graph — a *tree* of where time went, not a timeline.
 *
 * The tracing flame graph (`render/flamegraph.ts`) lays spans out along
 * a clock: each bar has a start and an end.  A profile has neither.  It
 * has stacks and weights, and identical stacks are summed — so the
 * layout is a different problem and gets its own module rather than a
 * mode flag on the other one.
 *
 * Pure functions; the panel does the drawing.
 */

/** One `(stack, weight)` pair, as speedscope models a sampled profile. */
export type WeightedStack = {
  /** Frame names, outermost first. */
  readonly frames: ReadonlyArray<string>;
  readonly weightMs: number;
  /** How many messages this stack represents. */
  readonly count: number;
  readonly errors: number;
};

/** A node of the aggregated tree. */
export type ProfileNode = {
  readonly name: string;
  /** Full path from the root, for a stable identity across redraws. */
  readonly key: string;
  readonly depth: number;
  /** Time in this subtree. */
  totalMs: number;
  /** Time attributed to this frame itself. */
  selfMs: number;
  count: number;
  errors: number;
  readonly children: Map<string, ProfileNode>;
};

/**
 * Build the tree from weighted stacks.
 *
 * A stack's weight lands as `self` on its leaf and as `total` on every
 * ancestor — the standard flame-graph accounting, and what makes "this
 * actor's subtree costs 40%" readable at a glance.
 */
export function buildProfileTree(stacks: ReadonlyArray<WeightedStack>): ProfileNode {
  const root: ProfileNode = {
    name: 'all',
    key: '',
    depth: 0,
    totalMs: 0,
    selfMs: 0,
    count: 0,
    errors: 0,
    children: new Map(),
  };

  for (const stack of stacks) {
    root.totalMs += stack.weightMs;
    root.count += stack.count;
    root.errors += stack.errors;
    let node = root;
    let key = '';
    stack.frames.forEach((name, index) => {
      key = `${key}/${name}`;
      let child = node.children.get(name);
      if (child === undefined) {
        child = {
          name,
          key,
          depth: index + 1,
          totalMs: 0,
          selfMs: 0,
          count: 0,
          errors: 0,
          children: new Map(),
        };
        node.children.set(name, child);
      }
      child.totalMs += stack.weightMs;
      child.count += stack.count;
      child.errors += stack.errors;
      node = child;
    });
    // Only the leaf did the work; ancestors merely contain it.
    node.selfMs += stack.weightMs;
  }
  return root;
}

/** A laid-out node ready to draw. */
export type ProfileRectangle = {
  readonly node: ProfileNode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** Vertical space one row occupies, in CSS pixels. */
export const PROFILE_ROW_HEIGHT = 20;

/**
 * Lay the tree out as an icicle: the root spans the full width, each
 * child takes the share of its parent that its total time represents.
 *
 * Siblings are ordered by weight, largest first, so the expensive path
 * is always on the left and the eye finds it without hunting.  Slivers
 * below `minimumWidth` are dropped — a bar thinner than a pixel cannot
 * be read or clicked, and drawing thousands of them is what makes naive
 * flame graphs slow.
 */
export function layoutProfile(
  root: ProfileNode,
  width: number,
  minimumWidth = 1,
): ReadonlyArray<ProfileRectangle> {
  const out: ProfileRectangle[] = [];
  if (root.totalMs <= 0) return out;

  const place = (node: ProfileNode, x: number, nodeWidth: number): void => {
    out.push({
      node,
      x,
      width: nodeWidth,
      y: node.depth * PROFILE_ROW_HEIGHT,
      height: PROFILE_ROW_HEIGHT - 2,
    });
    let offset = x;
    const children = [...node.children.values()].sort((a, b) => b.totalMs - a.totalMs);
    for (const child of children) {
      const childWidth = (child.totalMs / node.totalMs) * nodeWidth;
      if (childWidth < minimumWidth) continue;
      place(child, offset, childWidth);
      offset += childWidth;
    }
  };

  place(root, 0, width);
  return out;
}

/** How many rows the laid-out tree needs. */
export function profileDepth(rectangles: ReadonlyArray<ProfileRectangle>): number {
  return rectangles.reduce((deepest, rectangle) => Math.max(deepest, rectangle.node.depth), 0) + 1;
}

/** The heaviest leaves, for the "where did the time go" table. */
export function hottestLeaves(root: ProfileNode, limit: number): ReadonlyArray<ProfileNode> {
  const leaves: ProfileNode[] = [];
  const walk = (node: ProfileNode): void => {
    if (node.selfMs > 0) leaves.push(node);
    for (const child of node.children.values()) walk(child);
  };
  walk(root);
  return leaves.sort((a, b) => b.selfMs - a.selfMs).slice(0, limit);
}
