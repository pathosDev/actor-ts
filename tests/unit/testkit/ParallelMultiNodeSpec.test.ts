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
 *
 * Two blocks are the exception and spawn nothing: `construction`, and the
 * control-RPC correlation block, which drives in-memory fake workers through
 * the `backend` option.  Both stay outside the quarantine below, so they are
 * the only part of this file CI ever executes.
 */
import { describe, expect, test } from 'bun:test';
import { ParallelMultiNodeSpec } from '../../../src/testkit/ParallelMultiNodeSpec.js';
import type { MemberSnapshot } from '../../../src/testkit/internal/ParallelMultiNodeBootstrap.js';
import {
  autoHandshake,
  type FakeWorker,
  FakeWorkerBackend,
} from '../worker/__fixtures__/InMemoryWorkerThread.js';

// Quarantined on GitHub's hosted runners (ACTOR_TS_SKIP_FLAKY_MNS=1) —
// Bun there can't respawn functional worker threads after the first test
// (they spawn + handshake, then never run; reproducible only on the
// hosted runners, never locally or in Docker).  Runs locally + in Docker.
// #538 tracks the quarantine: `.github/workflows/nightly-flakes.yml` runs
// this suite nightly with the flag OFF, and 14 consecutive green nights are
// what removes this line.  The `construction` and control-RPC correlation
// describes spawn no workers, so they stay un-gated.
const describeMns = process.env.ACTOR_TS_SKIP_FLAKY_MNS === '1' ? describe.skip : describe;

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

/* ------------------- control-RPC correlation (#777) -------------------- */

/**
 * These spawn no OS threads, so they stay OUT of the `describeMns` quarantine
 * above and actually run in CI — which is the point: the correlation bug they
 * pin surfaces as a 30 s `await*` timeout, exactly the shape #538 taught
 * everyone to dismiss as hosted-runner flakiness.
 *
 * The seam is `ParallelMultiNodeSpecOptions.backend` (#520): the fake backend
 * hands back in-memory workers whose handshake `autoHandshake` completes on a
 * microtask, and `deliverMessage` fires the harness's own `message` listeners
 * synchronously.  So a stray frame and the genuine reply can be injected in a
 * known order with no wait between them, which is what makes the assertion
 * deterministic rather than a race the test usually wins.
 */
function specWithFakeWorkers(roles: ReadonlyArray<string>): {
  readonly spec: ParallelMultiNodeSpec;
  readonly workerFor: (role: string) => FakeWorker;
} {
  const backend = new FakeWorkerBackend({ onSpawn: (worker) => { autoHandshake(worker); } });
  const spec = new ParallelMultiNodeSpec({ roles: [...roles], backend });
  const workerFor = (role: string): FakeWorker => {
    // `spawnRole` names each worker after its role; matching on the name rather
    // than on spawn order keeps this honest if seed ordering ever changes.
    const worker = backend.spawned.find((candidate) => candidate.name === `parallel-mns-${role}`);
    if (!worker) throw new Error(`no worker was spawned for role '${role}'`);
    return worker;
  };
  return { spec, workerFor };
}

/** The `reqId` the harness stamped on the last control frame it posted to `worker`. */
function lastControlRequestId(worker: FakeWorker): number {
  const controlFrames = worker.posted.filter(
    (frame): frame is { kind: string; reqId: number } => {
      const kind = (frame as { kind?: unknown } | null | undefined)?.kind;
      return typeof kind === 'string' && kind.startsWith('mns-test.');
    },
  );
  const last = controlFrames.at(-1);
  if (last === undefined) throw new Error('the harness posted no control frame to this worker');
  return last.reqId;
}

/**
 * Run `body` with `console.warn` captured.  The mismatch report has no other
 * seam — the harness owns no `ActorSystem`, so the console is where it writes —
 * and capturing also keeps the expected warning out of the run's output.
 */
function captureWarnings(body: () => void): ReadonlyArray<string> {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => { warnings.push(args.map((a) => String(a)).join(' ')); };
  try {
    body();
    return warnings;
  } finally {
    console.warn = originalWarn;
  }
}

/**
 * Whether `promise` has settled *already*, without waiting on it.
 *
 * Ten microtask turns is an upper bound on the two the `getMembers` chain
 * needs — nothing on this path waits on a timer once a frame has been
 * delivered, so draining is deterministic rather than a bet.  Asserting
 * settledness directly is what keeps a regression legible: awaiting the value
 * instead would hang on `controlRpc`'s 5 s timer and be reported by bun as
 * `this test timed out after 5000ms`, the one message that names nothing.
 */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  return done;
}

const MEMBERS_OF_A: MemberSnapshot[] = [
  { address: '127.0.0.1:30500', status: 'up', roles: ['a'] },
  { address: '127.0.0.1:30501', status: 'up', roles: ['b'] },
];

/** Deliberately a different view, so a reply from the wrong role is visible. */
const MEMBERS_OF_B: MemberSnapshot[] = [
  { address: '127.0.0.1:30501', status: 'up', roles: ['b'] },
];

describe('ParallelMultiNodeSpec — control-RPC correlation', () => {
  test('a frame from another role does not settle the pending RPC', async () => {
    const { spec, workerFor } = specWithFakeWorkers(['a', 'b']);
    try {
      await spec.start();
      const membersPromise = spec.getMembers('a');
      const requestId = lastControlRequestId(workerFor('a'));

      // Role 'b' originates a frame carrying role 'a''s request id — what a
      // custom bootstrap or a scenario posting raw frames can produce.
      const warnings = captureWarnings(() => {
        workerFor('b').deliverMessage({
          kind: 'mns-test.run-command-response', reqId: requestId, result: 'stray',
        });
      });
      expect(await hasSettled(membersPromise)).toBe(false);

      // The genuine reply, from the role that was actually asked, still lands:
      // the stray must be dropped WITHOUT consuming the pending entry.
      workerFor('a').deliverMessage({
        kind: 'mns-test.query-members-response', reqId: requestId, members: MEMBERS_OF_A,
      });

      expect(await hasSettled(membersPromise)).toBe(true);
      expect(await membersPromise).toEqual(MEMBERS_OF_A);
      expect(warnings.join('\n')).toContain("from role 'b'");
    } finally {
      await spec.stop();
    }
  });

  test('a frame of the RIGHT kind from another role does not settle it either', async () => {
    const { spec, workerFor } = specWithFakeWorkers(['a', 'b']);
    try {
      await spec.start();
      const membersPromise = spec.getMembers('a');
      const requestId = lastControlRequestId(workerFor('a'));

      // Right kind, wrong worker — the case a kind-only guard waves through,
      // and the one that does the quiet damage: role 'b''s member view is a
      // perfectly well-formed answer to a question role 'a' was asked.
      const warnings = captureWarnings(() => {
        workerFor('b').deliverMessage({
          kind: 'mns-test.query-members-response', reqId: requestId, members: MEMBERS_OF_B,
        });
      });
      expect(await hasSettled(membersPromise)).toBe(false);

      workerFor('a').deliverMessage({
        kind: 'mns-test.query-members-response', reqId: requestId, members: MEMBERS_OF_A,
      });

      expect(await hasSettled(membersPromise)).toBe(true);
      expect(await membersPromise).toEqual(MEMBERS_OF_A);
      expect(warnings.join('\n')).toContain("from role 'b'");
    } finally {
      await spec.stop();
    }
  });

  test('a frame of the wrong kind from the right role does not settle it', async () => {
    const { spec, workerFor } = specWithFakeWorkers(['a', 'b']);
    try {
      await spec.start();
      const membersPromise = spec.getMembers('a');
      const requestId = lastControlRequestId(workerFor('a'));

      // Same worker, right request id, wrong conversation — a double-reply from
      // one role is as mis-correlated as a reply from another.
      const warnings = captureWarnings(() => {
        workerFor('a').deliverMessage({
          kind: 'mns-test.run-command-response', reqId: requestId, result: 'stray',
        });
      });
      expect(await hasSettled(membersPromise)).toBe(false);

      workerFor('a').deliverMessage({
        kind: 'mns-test.query-members-response', reqId: requestId, members: MEMBERS_OF_A,
      });

      expect(await hasSettled(membersPromise)).toBe(true);
      expect(await membersPromise).toEqual(MEMBERS_OF_A);
      expect(warnings.join('\n')).toContain('mns-test.run-command-response');
    } finally {
      await spec.stop();
    }
  });

  test('the matching reply from the role that was asked still settles it', async () => {
    const { spec, workerFor } = specWithFakeWorkers(['a', 'b']);
    try {
      await spec.start();
      const leaderPromise = spec.getLeader('b');
      const requestId = lastControlRequestId(workerFor('b'));

      const warnings = captureWarnings(() => {
        workerFor('b').deliverMessage({
          kind: 'mns-test.query-leader-response', reqId: requestId, leader: '127.0.0.1:30500',
        });
      });

      // The other half of the guard: a correlation check that rejected the
      // right reply too would pass every test above and break the harness.
      expect(await hasSettled(leaderPromise)).toBe(true);
      expect(await leaderPromise).toBe('127.0.0.1:30500');
      expect(warnings).toEqual([]);
    } finally {
      await spec.stop();
    }
  });

  test('two roles in flight at once each get their own reply', async () => {
    const { spec, workerFor } = specWithFakeWorkers(['a', 'b']);
    try {
      await spec.start();
      const membersPromise = spec.getMembers('a');
      const leaderPromise = spec.getLeader('b');
      const membersRequestId = lastControlRequestId(workerFor('a'));
      const leaderRequestId = lastControlRequestId(workerFor('b'));
      expect(membersRequestId).not.toBe(leaderRequestId);

      // Answered out of order, so nothing here depends on the counter's values.
      workerFor('b').deliverMessage({
        kind: 'mns-test.query-leader-response', reqId: leaderRequestId, leader: null,
      });
      workerFor('a').deliverMessage({
        kind: 'mns-test.query-members-response', reqId: membersRequestId, members: MEMBERS_OF_A,
      });

      expect(await hasSettled(leaderPromise)).toBe(true);
      expect(await hasSettled(membersPromise)).toBe(true);
      expect(await leaderPromise).toBeNull();
      expect(await membersPromise).toEqual(MEMBERS_OF_A);
    } finally {
      await spec.stop();
    }
  });
});

describeMns('ParallelMultiNodeSpec — bootstrap', () => {
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
  }, 150_000);

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
  }, 150_000);
});

describeMns('ParallelMultiNodeSpec — failure simulation', () => {
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
        spec.awaitMembers('a', 2, 30_000),
        spec.awaitMembers('b', 2, 30_000),
      ]);
    } finally {
      await spec.stop();
    }
  }, 150_000);

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
        spec.awaitMembers('a', 2, 30_000),
        spec.awaitMembers('c', 2, 30_000),
      ]);
    } finally {
      await spec.stop();
    }
  }, 150_000);

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
        spec.awaitMemberStatus('a', 'b', 'unreachable', 30_000),
        spec.awaitMemberStatus('b', 'a', 'unreachable', 30_000),
      ]);
      // Heal — both sides recover before downing kicks in (downAfterMs = 1 s,
      // total partition window above < 1 s in expectation).  In the rare
      // case downing wins the race we just exit silently — partition→heal
      // recovery semantics are validated in the in-process suite already.
      spec.heal('a', 'b');
    } finally {
      await spec.stop();
    }
  }, 150_000);
});

describeMns('ParallelMultiNodeSpec — await* timeouts', () => {
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
  }, 45_000);
});
