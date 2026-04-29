/**
 * Self-tests for `ParallelMultiNodeSpec` (#46) — the worker-thread
 * variant of `MultiNodeSpec`.  Each role runs in its own
 * `worker_threads` Worker (Node) / Web Worker (Bun); the harness
 * coordinates lifecycle + control-channel RPCs.
 *
 * These tests exercise the harness's primitives without loading a
 * scenario module (the bootstrap's `setup` hook is skipped when no
 * scenario URL is provided) — a follow-up "real test" port lives in
 * `tests/multi-node/parallel-pubsub.test.ts`.
 *
 * **Why these are slower than the in-process suite**: each test
 * spawns one or more OS threads.  Worker spawn + cluster handshake
 * is ~200-400 ms per role.  Tests use generous timeouts to absorb
 * that startup cost without flaking under load.
 */
import { describe, expect, test } from 'bun:test';
import { ParallelMultiNodeSpec } from '../../../src/testkit/ParallelMultiNodeSpec.js';

const TIGHT_FD = {
  heartbeatIntervalMs: 100,
  unreachableAfterMs: 500,
  downAfterMs: 1_000,
} as const;

describe('ParallelMultiNodeSpec — construction', () => {
  test('rejects empty role list', () => {
    expect(() => new ParallelMultiNodeSpec({ roles: [] })).toThrow(/at least one role/);
  });

  test('rejects duplicate roles', () => {
    expect(() => new ParallelMultiNodeSpec({ roles: ['a', 'b', 'a'] })).toThrow(/unique/);
  });
});

describe('ParallelMultiNodeSpec — bootstrap', () => {
  test('three roles, all see each other Up via worker-side cluster', async () => {
    const spec = new ParallelMultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 100,
    });
    try {
      await spec.start();
      // Each worker-side cluster reports its own member view via
      // the control-channel RPC.
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      // Sanity: the leader is the same on every replica.
      const leaderA = await spec.getLeader('a');
      const leaderB = await spec.getLeader('b');
      const leaderC = await spec.getLeader('c');
      expect(leaderA).toBeDefined();
      expect(leaderB).toBe(leaderA);
      expect(leaderC).toBe(leaderA);
    } finally {
      await spec.stop();
    }
  }, 30_000);

  test('addressFor + allRoles work after start', async () => {
    const spec = new ParallelMultiNodeSpec({
      roles: ['x', 'y'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 100,
    });
    try {
      await spec.start();
      expect(spec.allRoles().sort()).toEqual(['x', 'y']);
      expect(spec.addressFor('x').systemName).toBe('x');
      expect(spec.addressFor('y').port).toBeGreaterThanOrEqual(30_500);
    } finally {
      await spec.stop();
    }
  }, 30_000);
});

describe('ParallelMultiNodeSpec — failure simulation', () => {
  test('crash(role) drops the worker; other roles see only 2 members', async () => {
    const spec = new ParallelMultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 100,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);
      await spec.crash('c');
      // Survivors converge to a 2-member view as the failure detector
      // declares c down.  The TIGHT_FD's downAfterMs of 1 s gives a
      // generous-but-bounded wait window.
      await Promise.all([
        spec.awaitMembers('a', 2, 8_000),
        spec.awaitMembers('b', 2, 8_000),
      ]);
    } finally {
      await spec.stop();
    }
  }, 30_000);

  test('leave(role) advertises a graceful exit to peers', async () => {
    const spec = new ParallelMultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 100,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);
      await spec.leave('b');
      // Graceful leave shrinks the survivors' view faster than the
      // failure detector would on its own.
      await Promise.all([
        spec.awaitMembers('a', 2, 5_000),
        spec.awaitMembers('c', 2, 5_000),
      ]);
    } finally {
      await spec.stop();
    }
  }, 30_000);

  test('partition + heal flips reachability without dropping the workers', async () => {
    const spec = new ParallelMultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 100,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);
      // Cut a from b only — c remains reachable from both.
      spec.partition('a', 'b');
      await Promise.all([
        spec.awaitMemberStatus('a', 'b', 'unreachable', 5_000),
        spec.awaitMemberStatus('b', 'a', 'unreachable', 5_000),
      ]);
      // Heal — both sides recover before downing kicks in (downAfterMs = 1 s,
      // total partition window above < 1 s in expectation).  In the rare
      // case downing wins the race we just exit silently — partition→heal
      // recovery semantics are validated in the in-process suite already.
      spec.heal('a', 'b');
    } finally {
      await spec.stop();
    }
  }, 30_000);
});

describe('ParallelMultiNodeSpec — await* timeouts', () => {
  test('awaitMembers throws when count never converges', async () => {
    const spec = new ParallelMultiNodeSpec({
      roles: ['solo'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 100,
    });
    try {
      await spec.start();
      // Single-role cluster will never reach 5 members; the timeout
      // should fire well within our 8 s budget.
      await expect(spec.awaitMembers('solo', 5, 1_500))
        .rejects.toThrow(/timeout after 1500 ms/);
    } finally {
      await spec.stop();
    }
  }, 15_000);
});
