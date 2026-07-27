import { describe, expect, test } from 'bun:test';
import { ActorTreeModel } from '../src/panels/actors/actorsTree.js';
import type { ActorNode } from '../../src/devtools/protocol/index.js';

function node(path: string, parentPath: string | null, className = 'SomeActor'): ActorNode {
  return {
    path,
    parentPath,
    name: path.split('/').pop() ?? path,
    className,
    cellState: 'running',
    mailboxSize: 0,
    stashSize: 0,
    suspended: false,
    dispatcher: null,
    childCount: 0,
  };
}

/** A small tree: root → user → {alpha → leaf, beta}. */
function sampleTree(): ActorTreeModel {
  const model = new ActorTreeModel();
  model.reset([
    node('/', null, 'Guardian'),
    node('/user', '/', 'Guardian'),
    node('/user/alpha', '/user', 'AlphaActor'),
    node('/user/alpha/leaf', '/user/alpha', 'LeafActor'),
    node('/user/beta', '/user', 'BetaActor'),
  ]);
  return model;
}

describe('ActorTreeModel — structure', () => {
  test('flattens parents before children, siblings by name', () => {
    expect(sampleTree().rows().map((row) => row.node.path)).toEqual([
      '/', '/user', '/user/alpha', '/user/alpha/leaf', '/user/beta',
    ]);
  });

  test('reports depth and whether a node has children', () => {
    const rows = sampleTree().rows();
    const alpha = rows.find((row) => row.node.path === '/user/alpha')!;
    expect(alpha.depth).toBe(2);
    expect(alpha.hasChildren).toBe(true);
    expect(rows.find((row) => row.node.path === '/user/beta')!.hasChildren).toBe(false);
  });

  test('an upsert for a known path replaces rather than duplicates', () => {
    // This is what makes a delta racing the snapshot harmless.
    const model = sampleTree();
    const before = model.size;
    model.upsert({ ...node('/user/beta', '/user', 'BetaActor'), mailboxSize: 42 });
    expect(model.size).toBe(before);
    expect(model.get('/user/beta')!.mailboxSize).toBe(42);
  });

  test('treats a node whose parent is unknown as a root instead of dropping it', () => {
    const model = new ActorTreeModel();
    model.reset([node('/user/orphan', '/user/vanished')]);
    expect(model.rows().map((row) => row.node.path)).toEqual(['/user/orphan']);
    expect(model.rows()[0]!.depth).toBe(0);
  });
});

describe('ActorTreeModel — removal', () => {
  test('removing an actor takes its subtree with it', () => {
    const model = sampleTree();
    model.remove('/user/alpha');
    expect(model.has('/user/alpha')).toBe(false);
    expect(model.has('/user/alpha/leaf')).toBe(false);
    expect(model.has('/user/beta')).toBe(true);
  });

  test('removal is idempotent, so a repeated or missed frame is harmless', () => {
    const model = sampleTree();
    model.remove('/user/alpha');
    expect(() => model.remove('/user/alpha')).not.toThrow();
    expect(model.size).toBe(3);
  });

  test('does not remove a sibling with a shared name prefix', () => {
    const model = new ActorTreeModel();
    model.reset([node('/user/work', '/user'), node('/user/worker', '/user')]);
    model.remove('/user/work');
    expect(model.has('/user/worker')).toBe(true);
  });
});

describe('ActorTreeModel — collapsing', () => {
  test('collapsing hides descendants but keeps the node', () => {
    const model = sampleTree();
    model.toggle('/user/alpha');
    const paths = model.rows().map((row) => row.node.path);
    expect(paths).toContain('/user/alpha');
    expect(paths).not.toContain('/user/alpha/leaf');
  });

  test('toggling twice restores the subtree', () => {
    const model = sampleTree();
    model.toggle('/user/alpha');
    model.toggle('/user/alpha');
    expect(model.rows().map((row) => row.node.path)).toContain('/user/alpha/leaf');
  });
});

describe('ActorTreeModel — filtering', () => {
  test('keeps ancestors so a match stays reachable', () => {
    const paths = sampleTree().rows('leaf').map((row) => row.node.path);
    expect(paths).toEqual(['/', '/user', '/user/alpha', '/user/alpha/leaf']);
  });

  test('matches on class name too', () => {
    const paths = sampleTree().rows('betaactor').map((row) => row.node.path);
    expect(paths).toContain('/user/beta');
    expect(paths).not.toContain('/user/alpha/leaf');
  });

  test('a filter overrides collapsing, so a match is never hidden', () => {
    const model = sampleTree();
    model.toggle('/user/alpha');
    expect(model.rows('leaf').map((row) => row.node.path)).toContain('/user/alpha/leaf');
  });

  test('an unmatched filter yields nothing', () => {
    expect(sampleTree().rows('nothing-here')).toHaveLength(0);
  });

  test('whitespace is not a filter', () => {
    expect(sampleTree().rows('   ')).toHaveLength(5);
  });
});
