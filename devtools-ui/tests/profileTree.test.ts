import { describe, expect, test } from 'bun:test';
import {
  PROFILE_ROW_HEIGHT,
  buildProfileTree,
  hitTestProfile,
  hottestLeaves,
  layoutProfile,
  profileDepth,
  type WeightedStack,
} from '../src/render/profileTree.js';

const stack = (frames: string[], weightMs: number, count = 1, errors = 0): WeightedStack =>
  ({ frames, weightMs, count, errors });

describe('buildProfileTree', () => {
  test('sums weight into every ancestor', () => {
    const root = buildProfileTree([
      stack(['user', 'a', 'Ping'], 10),
      stack(['user', 'b', 'Ping'], 30),
    ]);
    expect(root.totalMs).toBe(40);
    expect(root.children.get('user')!.totalMs).toBe(40);
    expect(root.children.get('user')!.children.get('a')!.totalMs).toBe(10);
  });

  test('attributes self time only to the leaf', () => {
    const root = buildProfileTree([stack(['user', 'a', 'Ping'], 10)]);
    const user = root.children.get('user')!;
    expect(user.selfMs).toBe(0);
    expect(user.children.get('a')!.selfMs).toBe(0);
    expect(user.children.get('a')!.children.get('Ping')!.selfMs).toBe(10);
  });

  test('merges identical stacks', () => {
    const root = buildProfileTree([
      stack(['user', 'a', 'Ping'], 10, 3),
      stack(['user', 'a', 'Ping'], 5, 2),
    ]);
    const leaf = root.children.get('user')!.children.get('a')!.children.get('Ping')!;
    expect(leaf.totalMs).toBe(15);
    expect(leaf.count).toBe(5);
  });

  test('carries error counts up the tree', () => {
    const root = buildProfileTree([stack(['user', 'a', 'Ping'], 4, 2, 2)]);
    expect(root.errors).toBe(2);
    expect(root.children.get('user')!.errors).toBe(2);
  });

  test('keys each node by its full path, so names can repeat', () => {
    const root = buildProfileTree([
      stack(['user', 'a', 'work'], 1),
      stack(['system', 'a', 'work'], 1),
    ]);
    expect(root.children.get('user')!.children.get('a')!.key).toBe('/user/a');
    expect(root.children.get('system')!.children.get('a')!.key).toBe('/system/a');
  });

  test('an empty profile is an empty root', () => {
    const root = buildProfileTree([]);
    expect(root.totalMs).toBe(0);
    expect(root.children.size).toBe(0);
  });
});

describe('layoutProfile', () => {
  const root = buildProfileTree([
    stack(['user', 'slow', 'Work'], 75),
    stack(['user', 'fast', 'Work'], 25),
  ]);

  test('the root spans the full width', () => {
    const rectangles = layoutProfile(root, 100);
    const rootRectangle = rectangles.find((r) => r.node.depth === 0)!;
    expect(rootRectangle.x).toBe(0);
    expect(rootRectangle.width).toBe(100);
  });

  test('children take their share of the parent', () => {
    const rectangles = layoutProfile(root, 100);
    const slow = rectangles.find((r) => r.node.name === 'slow')!;
    const fast = rectangles.find((r) => r.node.name === 'fast')!;
    expect(slow.width).toBe(75);
    expect(fast.width).toBe(25);
  });

  test('puts the heaviest sibling on the left', () => {
    const rectangles = layoutProfile(root, 100);
    const slow = rectangles.find((r) => r.node.name === 'slow')!;
    const fast = rectangles.find((r) => r.node.name === 'fast')!;
    expect(slow.x).toBeLessThan(fast.x);
  });

  test('stacks depth downwards by a fixed row height', () => {
    const rectangles = layoutProfile(root, 100);
    const user = rectangles.find((r) => r.node.name === 'user')!;
    expect(user.y).toBe(PROFILE_ROW_HEIGHT);
  });

  test('drops slivers that cannot be seen or clicked', () => {
    const skewed = buildProfileTree([
      stack(['big', 'Work'], 10_000),
      stack(['tiny', 'Work'], 1),
    ]);
    const rectangles = layoutProfile(skewed, 100, 1);
    expect(rectangles.some((r) => r.node.name === 'big')).toBe(true);
    expect(rectangles.some((r) => r.node.name === 'tiny')).toBe(false);
  });

  test('an empty profile lays out nothing', () => {
    expect(layoutProfile(buildProfileTree([]), 100)).toEqual([]);
  });

  test('reports the number of rows needed', () => {
    expect(profileDepth(layoutProfile(root, 100))).toBe(4);
  });
});

describe('hitTestProfile', () => {
  const root = buildProfileTree([stack(['user', 'a', 'Work'], 10)]);
  const rectangles = layoutProfile(root, 100);

  test('finds the frame under the point', () => {
    const hit = hitTestProfile(rectangles, 50, PROFILE_ROW_HEIGHT + 5);
    expect(hit?.node.name).toBe('user');
  });

  test('returns null below the deepest row', () => {
    expect(hitTestProfile(rectangles, 50, 500)).toBeNull();
  });
});

describe('hottestLeaves', () => {
  test('ranks by self time and respects the limit', () => {
    const root = buildProfileTree([
      stack(['a', 'Slow'], 100),
      stack(['b', 'Medium'], 50),
      stack(['c', 'Fast'], 5),
    ]);
    const leaves = hottestLeaves(root, 2);
    expect(leaves.map((leaf) => leaf.name)).toEqual(['Slow', 'Medium']);
  });

  test('skips frames that did no work themselves', () => {
    const root = buildProfileTree([stack(['user', 'a', 'Work'], 10)]);
    expect(hottestLeaves(root, 10).map((leaf) => leaf.name)).toEqual(['Work']);
  });
});
