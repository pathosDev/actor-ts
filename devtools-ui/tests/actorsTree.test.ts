import { describe, expect, test } from 'bun:test';
import { ActorTreeModel } from '../src/panels/actors/actorsTree.js';
import type { ActorNode } from '../../src/devtools/protocol/index.js';

function node(path: string, parentPath: string | null, className = 'SomeActor'): ActorNode {
  return {
    nodeAddress: 'local',
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
    internal: false,
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

describe('ActorTreeModel — stopping', () => {
  test('stopping an actor takes its subtree with it', () => {
    const model = sampleTree();
    model.markStopped('/user/alpha', 1_000);
    const stopped = model.rows().filter((row) => row.stoppedAtMs !== null);
    expect(stopped.map((row) => row.node.path))
      .toEqual(['/user/alpha', '/user/alpha/leaf']);
    expect(stopped.every((row) => row.node.cellState === 'terminated')).toBe(true);
    expect(model.rows().find((row) => row.node.path === '/user/beta')!.stoppedAtMs).toBeNull();
  });

  test('keeps the row visible so the actor you were watching does not vanish', () => {
    const model = sampleTree();
    const before = model.rows().length;
    model.markStopped('/user/alpha', 1_000);
    expect(model.rows().length).toBe(before);
    // Shown, but not counted as population.
    expect(model.size).toBe(3);
    expect(model.stoppedCount).toBe(2);
  });

  test('stopping is idempotent, so a repeated or missed frame is harmless', () => {
    const model = sampleTree();
    model.markStopped('/user/alpha', 1_000);
    expect(() => model.markStopped('/user/alpha', 9_000)).not.toThrow();
    // The first stop time wins — a duplicate frame must not restart the
    // countdown and keep the row alive forever.
    expect(model.rows().find((row) => row.node.path === '/user/alpha')!.stoppedAtMs).toBe(1_000);
  });

  test('does not stop a sibling with a shared name prefix', () => {
    const model = new ActorTreeModel();
    model.reset([node('/user/work', '/user'), node('/user/worker', '/user')]);
    model.markStopped('/user/work', 1_000);
    expect(model.rows().find((row) => row.node.path === '/user/worker')!.stoppedAtMs).toBeNull();
  });

  test('sweeps tombstones once they age out, and only then', () => {
    const model = sampleTree();
    model.markStopped('/user/alpha', 1_000);

    expect(model.sweep(20_000, 30_000)).toBe(false);
    expect(model.has('/user/alpha')).toBe(true);

    expect(model.sweep(31_001, 30_000)).toBe(true);
    expect(model.has('/user/alpha')).toBe(false);
    expect(model.has('/user/alpha/leaf')).toBe(false);
    expect(model.has('/user/beta')).toBe(true);
    expect(model.stoppedCount).toBe(0);
  });

  test('a respawn on the same path is alive again', () => {
    const model = sampleTree();
    model.markStopped('/user/beta', 1_000);
    model.upsert(node('/user/beta', '/user'));
    expect(model.rows().find((row) => row.node.path === '/user/beta')!.stoppedAtMs).toBeNull();
    expect(model.stoppedCount).toBe(0);
  });

  test('a fresh snapshot clears tombstones — it describes only the living', () => {
    const model = sampleTree();
    model.markStopped('/user/alpha', 1_000);
    model.reset([node('/user', null)]);
    expect(model.stoppedCount).toBe(0);
    expect(model.size).toBe(1);
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

describe('ActorTreeModel — a whole tree at once', () => {
  test('folds a whole tree in, and tombstones what left it', () => {
    const model = new ActorTreeModel();
    model.applyFullTree([node('/user', null), node('/user/a', '/user')], 1_000);
    expect(model.size).toBe(2);

    // The second round no longer mentions `/user/a`.  A remote node
    // reports everything each time, so its absence *is* the stop event —
    // and it earns the same thirty seconds a local one gets.
    model.applyFullTree([node('/user', null), node('/user/b', '/user')], 2_000);
    const rows = model.rows();
    const gone = rows.find((row) => row.node.path === '/user/a');
    expect(gone).toBeDefined();
    expect(gone!.stoppedAtMs).toBe(2_000);
    expect(gone!.node.cellState).toBe('terminated');
    expect(rows.find((row) => row.node.path === '/user/b')!.stoppedAtMs).toBeNull();
    expect(model.size).toBe(2);

    // Coming back is just another upsert.
    model.applyFullTree([node('/user', null), node('/user/a', '/user')], 3_000);
    expect(model.rows().find((row) => row.node.path === '/user/a')!.stoppedAtMs).toBeNull();
  });
});
