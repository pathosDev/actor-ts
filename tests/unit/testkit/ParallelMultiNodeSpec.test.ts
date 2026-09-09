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
import { scaledMs } from '../../../src/testkit/TimeFactor.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ParallelMultiNodeSpec } from '../../../src/testkit/ParallelMultiNodeSpec.js';
import type { MemberSnapshot } from '../../../src/testkit/internal/ParallelMultiNodeBootstrap.js';
import {
  autoHandshake,
  type FakeWorker,
  FakeWorkerBackend,
} from '../worker/__fixtures__/InMemoryWorkerThread.js';

// Runs in CI.  The quarantine this file carried (`ACTOR_TS_SKIP_FLAKY_MNS=1`,
// #538) rested on the claim that Bun cannot respawn functional worker threads
// on GitHub's hosted runners after the first worker-thread test.  Measured
// against that claim: `.github/workflows/nightly-flakes.yml` has run exactly
// these suites on `ubuntu-latest` with the flag off, three repeats a night, for
// 21 consecutive nights (2026-08-17 to 2026-09-06) — 63 executions, and not one
// hang.  The written exit criterion was fourteen.

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
 * These spawn no OS threads at all, which is why they ran in CI throughout the
 * years this file's thread-spawning half was quarantined — and the correlation
 * bug they pin surfaces as a 30 s `await*` timeout, exactly the shape #538
 * taught everyone to dismiss as hosted-runner flakiness.
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

/** {@link captureWarnings} for a body that has to be awaited. */
async function captureWarningsWhile(body: () => Promise<void>): Promise<ReadonlyArray<string>> {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => { warnings.push(args.map((a) => String(a)).join(' ')); };
  try {
    await body();
    return warnings;
  } finally {
    console.warn = originalWarn;
  }
}

/**
 * The whole line `onMisdirectedControlFrame` writes, from the same five facts.
 *
 * Built here and compared in full rather than probed with `toContain`, because
 * the two clauses of that message are not equally covered by a substring: the
 * first names the frame that arrived, which any assertion about the drop
 * mentions anyway, while the second — the `reqId` and the request it actually
 * belongs to — is the half that turns "a stray frame existed" into something a
 * reader can act on, and is exactly the half three `toContain`s over the first
 * clause left free to be deleted without a failure.
 */
function misdirectedFrameWarning(report: {
  readonly arrivedKind: string;
  readonly arrivedFromRole: string;
  readonly requestId: number;
  readonly awaitedKind: string;
  readonly awaitedFromRole: string;
}): string {
  return `ParallelMultiNodeSpec: dropped control frame '${report.arrivedKind}' `
    + `from role '${report.arrivedFromRole}' (reqId ${report.requestId}) — that reqId `
    + `belongs to a '${report.awaitedKind}' awaited from role '${report.awaitedFromRole}'`;
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
      expect(warnings).toEqual([misdirectedFrameWarning({
        arrivedKind: 'mns-test.run-command-response',
        arrivedFromRole: 'b',
        requestId,
        awaitedKind: 'mns-test.query-members-response',
        awaitedFromRole: 'a',
      })]);
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
      expect(warnings).toEqual([misdirectedFrameWarning({
        arrivedKind: 'mns-test.query-members-response',
        arrivedFromRole: 'b',
        requestId,
        awaitedKind: 'mns-test.query-members-response',
        awaitedFromRole: 'a',
      })]);
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
      expect(warnings).toEqual([misdirectedFrameWarning({
        arrivedKind: 'mns-test.run-command-response',
        arrivedFromRole: 'a',
        requestId,
        awaitedKind: 'mns-test.query-members-response',
        awaitedFromRole: 'a',
      })]);
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

  /**
   * The symptom #777 is named after, rather than the correlation that causes
   * it.
   *
   * Every case above asserts settledness at the `getMembers` / `getLeader`
   * level, one frame at a time.  What a spec author actually sees is one level
   * up and much later: `awaitMembers` polls the same RPC until a condition
   * holds, a mis-correlated reply answers each poll with a view that will never
   * satisfy it, and thirty seconds later the run fails naming a convergence
   * that was never the problem — the message #538 taught everyone to read as
   * hosted-runner flakiness.  Worse, the wrong reply need not even be a member
   * view: a `run-command-response` settling a `getMembers` yields
   * `members === undefined`, the `.filter(…)` throws, and `awaitCondition`
   * swallows the throw as a retry.
   *
   * So this drives the whole loop with a stray racing every single poll, and
   * asserts that it converges anyway — inside a budget far below the timeout,
   * because "it eventually gave up" is the failure being ruled out.
   */
  test('awaitMembers converges even with a stray reply racing every poll', async () => {
    const { spec, workerFor } = specWithFakeWorkers(['a', 'b']);
    try {
      await spec.start();
      const workerA = workerFor('a');
      const workerB = workerFor('b');

      // Role 'b' answers role 'a''s question first, every time, with its own
      // one-member view — the count `awaitMembers` is waiting to leave behind.
      // Role 'a''s genuine, converged answer follows in the same turn, so the
      // only thing that decides the outcome is which of the two is allowed to
      // settle the pending entry.
      const postToWorkerA = workerA.postMessage.bind(workerA);
      workerA.postMessage = (value: unknown): void => {
        postToWorkerA(value);
        const frame = (value ?? undefined) as { kind?: string; reqId?: number } | undefined;
        if (frame?.kind !== 'mns-test.query-members' || frame.reqId === undefined) return;
        workerB.deliverMessage({
          kind: 'mns-test.query-members-response', reqId: frame.reqId, members: MEMBERS_OF_B,
        });
        workerA.deliverMessage({
          kind: 'mns-test.query-members-response', reqId: frame.reqId, members: MEMBERS_OF_A,
        });
      };

      const warnings = await captureWarningsWhile(async () => {
        await spec.awaitMembers('a', MEMBERS_OF_A.length, 1_000);
      });

      // And the stray was reported rather than swallowed on the way past.
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0]).toContain("from role 'b'");
    } finally {
      await spec.stop();
    }
  });
});

/* ------------------ the control-frame vocabulary (#777) ---------------- */

/**
 * Every `mns-test.*` literal in one file, in source order and de-duplicated.
 *
 * The bare prefix `'mns-test.'` — the `startsWith` filter in `onControlFrame` —
 * does not match: a kind needs at least one character after the dot.
 */
function controlFrameKindsIn(file: string): string[] {
  const source = readFileSync(join(import.meta.dir, '..', '..', '..', file), 'utf8');
  const kinds = [...source.matchAll(/'(mns-test\.[a-z-]+)'/g)].map((match) => match[1]!);
  return [...new Set(kinds)].sort();
}

/**
 * The eight kinds the harness and the worker bootstrap have to agree on.
 *
 * They are declared twice — once in `ParallelMultiNodeSpec.ts` for the side
 * that sends requests and correlates replies, once in
 * `internal/ParallelMultiNodeBootstrap.ts` for the side that answers them — and
 * the two declarations reference nothing in common, so `tsc` sees no relation
 * between them at all.  That was tolerable while `reqId` alone settled an RPC;
 * since #777 the correlation also matches on `expectedKind`, i.e. on the
 * request kind with `-response` appended, so a rename on one side turns every
 * reply from the other into a misdirected frame and every `await*` into its
 * uninformative timeout.  Nothing in CI would notice.
 */
const CONTROL_FRAME_KINDS = [
  'mns-test.leave',
  'mns-test.leave-response',
  'mns-test.query-leader',
  'mns-test.query-leader-response',
  'mns-test.query-members',
  'mns-test.query-members-response',
  'mns-test.run-command',
  'mns-test.run-command-response',
] as const;

describe('ParallelMultiNodeSpec — the two copies of the control vocabulary', () => {
  for (const file of [
    join('src', 'testkit', 'ParallelMultiNodeSpec.ts'),
    join('src', 'testkit', 'internal', 'ParallelMultiNodeBootstrap.ts'),
  ]) {
    test(`${file} names exactly the agreed kinds`, () => {
      expect(controlFrameKindsIn(file)).toEqual([...CONTROL_FRAME_KINDS]);
    });
  }

  test('every request kind has its reply under the name the correlation builds', () => {
    // `controlRpc` stores `expectedKind` as the request kind plus `-response`,
    // so the pairing is not a convention the two files happen to share — it is
    // arithmetic the harness performs on a string.
    const requests = CONTROL_FRAME_KINDS.filter((kind) => !kind.endsWith('-response'));
    expect(requests.map((kind) => `${kind}-response`).sort())
      .toEqual(CONTROL_FRAME_KINDS.filter((kind) => kind.endsWith('-response')));
  });
});

/* ------------------- the handshake's first-hello latch (#775) ----------- */

/**
 * A backend whose workers greet `helloCount` times and answer the first
 * `worker-init` only on a later microtask.
 *
 * Both halves matter.  {@link autoHandshake} replies to `worker-init`
 * synchronously, which would let the handshake resolve — and remove its
 * `message` listener — before the second hello was ever delivered, so an
 * unlatched implementation would look latched.  Deferring the reply keeps the
 * listener installed for the whole flood, which is the state the real
 * handshake is in for its entire ten-second window.
 */
function floodingHelloBackend(helloCount: number): FakeWorkerBackend {
  return new FakeWorkerBackend({
    onSpawn: (worker) => {
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (value: unknown): void => {
        post(value);
        const frame = (value ?? undefined) as { kind?: string; self?: unknown } | undefined;
        if (frame?.kind !== 'worker-init') return;
        queueMicrotask(() => worker.deliverMessage({ kind: 'worker-ready', self: frame.self }));
      };
      const add = worker.addEventListener.bind(worker);
      let greeted = false;
      worker.addEventListener = (event, handler): void => {
        add(event, handler);
        // The handshake's own listener is the first `message` subscription on
        // this worker; the control channel adds a second one after it resolves.
        if (event !== 'message' || greeted) return;
        greeted = true;
        queueMicrotask(() => {
          for (let hello = 0; hello < helloCount; hello += 1) {
            worker.deliverMessage({ kind: 'worker-hello' });
          }
        });
      };
    },
  });
}

describe('ParallelMultiNodeSpec — handshake', () => {
  test('only the first hello is answered, however many a worker sends', async () => {
    // `postMessage` structured-clones `init` on the *harness's* thread, and
    // `init` carries the seed list and the scenario's init data — so an
    // unlatched hello lets one worker charge the harness one clone per frame
    // for the whole ten-second handshake window, from inside the loop that is
    // still spawning the other roles (#775).  This is the testkit's copy of
    // `WorkerCluster.handshake`'s latch, and it had none of its coverage.
    const backend = floodingHelloBackend(5);
    const spec = new ParallelMultiNodeSpec({ roles: ['a'], backend });
    try {
      await spec.start();

      const worker = backend.spawned.find((candidate) => candidate.name === 'parallel-mns-a');
      expect(worker).toBeDefined();
      const inits = worker!.posted.filter(
        (frame) => (frame as { kind?: string } | null | undefined)?.kind === 'worker-init',
      );
      expect(inits).toHaveLength(1);
    } finally {
      await spec.stop();
    }
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
  }, scaledMs(150_000));

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
  }, scaledMs(150_000));
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
        spec.awaitMembers('a', 2, 30_000),
        spec.awaitMembers('b', 2, 30_000),
      ]);
    } finally {
      await spec.stop();
    }
  }, scaledMs(150_000));

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
  }, scaledMs(150_000));

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
  }, scaledMs(150_000));
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
  }, scaledMs(45_000));
});
