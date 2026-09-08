/**
 * Self-tests for the MultiNodeSpec harness.  These exist so that the
 * harness *itself* doesn't quietly rot — the real multi-node tests
 * (under `tests/multi-node/`) only stand up if these primitives work.
 *
 * What we cover:
 *   - constructor validation (empty / duplicate roles)
 *   - cluster bootstrap (N roles → N members up across every node's view)
 *   - graceful leave + ungraceful crash
 *   - bidirectional partition + heal
 *   - the await* helpers reach steady state
 *   - the await* helpers throw on timeout instead of hanging forever
 *   - accessor helpers (systemFor / clusterFor / addressFor) and unknown-role errors
 *   - the harness's test-scaled split-brain stability window (#839)
 */
import { describe, expect, test } from 'bun:test';
import { MultiNodeSpec } from '../../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../../src/testkit/internal/MultiNodeTransport.js';
import { DEFAULT_STABLE_AFTER_MS } from '../../../src/cluster/downing/index.js';
import type { DowningProvider } from '../../../src/cluster/downing/index.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  downAfterMs: 400,
} as const;

describe('MultiNodeSpec — construction', () => {
  test('rejects empty role list', () => {
    expect(() => new MultiNodeSpec({ roles: [] })).toThrow(/at least one role/);
  });

  test('rejects duplicate roles', () => {
    expect(() => new MultiNodeSpec({ roles: ['a', 'b', 'a'] })).toThrow(/unique/);
  });
});

describe('MultiNodeSpec — bootstrap', () => {
  test('three roles, all see each other Up', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
    });
    try {
      await spec.start();
      // Each node converges its own member list independently.
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      // Leader is deterministic — first up-member by address ordering.
      // We don't assert which one specifically, only that all three roles
      // agree on the same leader.
      const leaderA = spec.clusterFor('a').leader().toNullable()?.address.toString();
      const leaderB = spec.clusterFor('b').leader().toNullable()?.address.toString();
      const leaderC = spec.clusterFor('c').leader().toNullable()?.address.toString();
      expect(leaderA).toBeDefined();
      expect(leaderB).toBe(leaderA);
      expect(leaderC).toBe(leaderA);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 10_000);

  test('allRoles + accessor helpers work after start', async () => {
    const spec = new MultiNodeSpec({ roles: ['x', 'y'], failureDetector: TIGHT_FD });
    try {
      await spec.start();
      expect(spec.allRoles().sort()).toEqual(['x', 'y']);
      expect(spec.systemFor('x').name).toBe('x');
      expect(spec.clusterFor('y').selfAddress.systemName).toBe('y');
      expect(spec.addressFor('x').port).toBeGreaterThanOrEqual(30_000);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 10_000);

  test('unknown role throws with a clear error', async () => {
    const spec = new MultiNodeSpec({ roles: ['a'], failureDetector: TIGHT_FD });
    try {
      await spec.start();
      expect(() => spec.systemFor('does-not-exist')).toThrow(/unknown role/);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 10_000);
});

describe('MultiNodeSpec — failure simulation', () => {
  test('crash(role) drops the node from the others view', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      // Yank the transport out from under 'c' — others should detect via
      // missed heartbeats and downing.  We only assert on the survivors.
      await spec.crash('c');

      await Promise.all([
        spec.awaitMembers('a', 2, 5_000),
        spec.awaitMembers('b', 2, 5_000),
      ]);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 15_000);

  test('leave(role) advertises Leaving / Removed to peers', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
    });
    try {
      await spec.start();
      await spec.awaitMembers('a', 3);

      await spec.leave('b');

      // 'a' should converge to a 2-node view via gossip rather than
      // detection timeout (graceful exit is faster).
      await spec.awaitMembers('a', 2, 3_000);
      await spec.awaitMembers('c', 2, 3_000);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 10_000);

  test('partition + heal flips peer reachability', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
    });
    try {
      await spec.start();
      // All three views must reach steady state before partitioning —
      // otherwise we may cut the wire before B itself has been promoted
      // to `up`, leaving B stuck on `joining` since the leader can no
      // longer reach it.
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      // Cut a from b only — c should still see both.
      spec.partition('a', 'b');
      await spec.awaitMemberStatus('a', 'b', 'unreachable', 3_000);
      await spec.awaitMemberStatus('b', 'a', 'unreachable', 3_000);

      // 'c' is on neither side of the cut, but the unreachable observation
      // from a or b can still flow back through gossip — what we assert
      // here is that c hasn't *downed* either party (i.e. both remain
      // candidates that can recover on heal).
      const cView = spec.clusterFor('c').getMembers();
      const aFromC = cView.find((m) => m.address.systemName === 'a');
      const bFromC = cView.find((m) => m.address.systemName === 'b');
      expect(aFromC?.status).not.toBe('down');
      expect(aFromC?.status).not.toBe('removed');
      expect(bFromC?.status).not.toBe('down');
      expect(bFromC?.status).not.toBe('removed');

      // Heal — both sides should recover to 'up'.
      spec.heal('a', 'b');
      await spec.awaitMemberStatus('a', 'b', 'up', 3_000);
      await spec.awaitMemberStatus('b', 'a', 'up', 3_000);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 15_000);
});

describe('MultiNodeSpec — await timeouts', () => {
  test('awaitMembers throws when the count never converges', async () => {
    const spec = new MultiNodeSpec({ roles: ['solo'], failureDetector: TIGHT_FD });
    try {
      await spec.start();
      await expect(spec.awaitMembers('solo', 5, 200))
        .rejects.toThrow(/timeout after 200 ms/);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 5_000);

  test('awaitMemberStatus error message includes a member snapshot', async () => {
    const spec = new MultiNodeSpec({ roles: ['a', 'b'], failureDetector: TIGHT_FD });
    try {
      await spec.start();
      await spec.awaitMembers('a', 2);

      // We never crash 'b', so 'b -> down' will never happen — assert
      // the error carries the snapshot we use for debugging.
      await expect(spec.awaitMemberStatus('a', 'b', 'down', 200))
        .rejects.toThrow(/b=up/);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 5_000);
});

describe('MultiNodeSpec — the stability window is test-scaled (#839)', () => {
  test('a spec resolver is consulted about a partition well inside the shipped window', async () => {
    // `MultiNodeSpec` overrides `stable-after` down to 100 ms for the same
    // reason it overrides the gossip interval, and nothing detected the
    // override's absence: removing it leaves this file at 120 pass / 0 fail
    // and `tests/multi-node/LeaseMajority.test.ts` green.  It is not inert
    // though — LeaseMajority goes from 879 ms to 20.97 s without it, because
    // every partition in every spec then waits out the shipped 20 s window
    // before a strategy is asked anything.
    //
    // A guard rather than a comment naming that cost, because a twenty-fold
    // slowdown that no test fails on is exactly the shape that comes back.
    //
    // What binds it is the *unreachable* view reaching the provider.  A
    // provider that decides nothing is re-asked on every settled tick, so
    // "was it called at all" would go true before the crash and assert
    // nothing.  With the override gone the window is 20 s and its ceiling
    // 40 s, so neither path reaches the provider inside this budget.
    let sawUnreachable = false;
    const provider: DowningProvider = {
      decide(view) {
        if (view.unreachable.size > 0) sawUnreachable = true;
        return new Set();
      },
    };
    const spec = new MultiNodeSpec({
      roles: ['seed', 'peer'],
      failureDetector: TIGHT_FD,
      downing: (role) => (role === 'seed' ? provider : undefined),
    });
    try {
      await spec.start();
      await spec.awaitMembers('seed', 2);
      sawUnreachable = false;

      const crashedAt = Date.now();
      await spec.crash('peer');
      await awaitCondition(() => sawUnreachable, {
        timeoutMs: 4_000,
        intervalMs: 25,
        label: 'the spec resolver was consulted about the partitioned peer',
      });
      expect(Date.now() - crashedAt).toBeLessThan(DEFAULT_STABLE_AFTER_MS);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 15_000);
});
