import { describe, expect, test } from 'bun:test';
import {
  KeepMajority,
  KeepOldest,
  LeaseMajority,
  LeaseMajorityOptions,
  StaticQuorum,
  StaticQuorumOptions,
  KeepReferee,
  KeepRefereeOptions,
  addrKey,
  type ClusterPartitionView,
} from '../../../../../src/cluster/downing/index.js';
import type { Lease } from '../../../../../src/coordination/Lease.js';
import { Member } from '../../../../../src/cluster/Member.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';

const addr = (port: number, host = 'h'): NodeAddress => new NodeAddress('sys', host, port);

/** Build a view with the given members + explicit unreachable addresses. */
function view(
  members: Array<{ port: number; status?: string; roles?: string[] }>,
  unreachablePorts: number[],
  selfPort = members[0]!.port,
): ClusterPartitionView {
  const ms: Member[] = members.map((member) =>
    new Member(addr(member.port), (member.status ?? 'up') as never, 1, member.roles ?? []));
  const unreachable = new Set(unreachablePorts.map((p) => addr(p).toString()));
  return { allMembers: ms, unreachable, self: addr(selfPort) };
}

describe('KeepMajority', () => {
  test('reachable majority downs the minority', () => {
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }, { port: 5 }], [4, 5]);
    const decision = new KeepMajority().decide(clusterView);
    expect(decision.has(addr(4).toString())).toBe(true);
    expect(decision.has(addr(5).toString())).toBe(true);
    expect(decision.size).toBe(2);
  });

  test('minority side downs itself', () => {
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }, { port: 5 }], [1, 2, 3]);
    const decision = new KeepMajority().decide(clusterView);
    // "We" see ports 4,5 as reachable but they are in the minority.
    expect(decision.has(addr(4).toString())).toBe(true);
    expect(decision.has(addr(5).toString())).toBe(true);
  });

  test('tie stays pending (no decision)', () => {
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);
    expect(new KeepMajority().decide(clusterView).size).toBe(0);
  });

  test('role filter only counts tagged members', () => {
    // 3 workers, 1 idle node; unreachable=[3] (worker).  Among workers
    // only (ports 1,2,3), 2 are reachable vs 1 unreachable → majority → down 3.
    const clusterView = view([
      { port: 1, roles: ['worker'] },
      { port: 2, roles: ['worker'] },
      { port: 3, roles: ['worker'] },
      { port: 9, roles: ['idle'] }, // excluded
    ], [3]);
    const decision = new KeepMajority({ role: 'worker' }).decide(clusterView);
    expect(decision.has(addr(3).toString())).toBe(true);
    expect(decision.has(addr(9).toString())).toBe(false); // not even considered
  });
});

describe('KeepOldest', () => {
  test('oldest-reachable side downs the other', () => {
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }], [2, 3]);
    const decision = new KeepOldest().decide(clusterView);
    expect(decision.has(addr(2).toString())).toBe(true);
    expect(decision.has(addr(3).toString())).toBe(true);
  });

  test('oldest-unreachable → this side downs itself', () => {
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }], [1]);
    const decision = new KeepOldest().decide(clusterView);
    // Ports 2 & 3 are reachable but oldest (1) is on other side → they down themselves.
    expect(decision.has(addr(2).toString())).toBe(true);
    expect(decision.has(addr(3).toString())).toBe(true);
  });
});

describe('StaticQuorum', () => {
  test('reachable meets quorum → down unreachable', () => {
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);
    const quorumOptions = StaticQuorumOptions.create().withQuorumSize(2);
    const decision = new StaticQuorum(quorumOptions).decide(clusterView);
    expect(decision.has(addr(3).toString())).toBe(true);
    expect(decision.has(addr(4).toString())).toBe(true);
  });

  test('reachable below quorum → down ourselves', () => {
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [2, 3, 4]);
    const quorumOptions = StaticQuorumOptions.create().withQuorumSize(2);
    const decision = new StaticQuorum(quorumOptions).decide(clusterView);
    // Only port 1 is reachable; we're under quorum → down self.
    expect(decision.has(addr(1).toString())).toBe(true);
  });

  test('quorumSize < 1 throws', () => {
    const quorumOptions = StaticQuorumOptions.create().withQuorumSize(0);
    expect(() => new StaticQuorum(quorumOptions)).toThrow(/quorumSize/);
  });
});

describe('KeepReferee', () => {
  test('referee reachable on this side → down the other', () => {
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }], [3]);
    const refereeOptions = KeepRefereeOptions.create().withRefereeAddress(addr(1).toString());
    const decision = new KeepReferee(refereeOptions).decide(clusterView);
    expect(decision.has(addr(3).toString())).toBe(true);
  });

  test('referee unreachable → down this side', () => {
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }], [1]);
    const refereeOptions = KeepRefereeOptions.create().withRefereeAddress(addr(1).toString());
    const decision = new KeepReferee(refereeOptions).decide(clusterView);
    // Ports 2 & 3 are reachable but referee is on other side → down self.
    expect(decision.has(addr(2).toString())).toBe(true);
    expect(decision.has(addr(3).toString())).toBe(true);
  });

  test('downAllIfBelowQuorum downs everyone when referee-side too small', () => {
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [2, 3, 4]);
    const refereeOptions = KeepRefereeOptions.create()
      .withRefereeAddress(addr(1).toString())
      .withDownAllIfBelowQuorum(3);
    const decision = new KeepReferee(refereeOptions).decide(clusterView);
    // Only port 1 is reachable (referee side) — below quorum of 3 → down all.
    expect(decision.size).toBe(4);
  });
});

describe('addrKey helper', () => {
  test('serialises member address consistently with NodeAddress.toString', () => {
    const member = new Member(addr(9000), 'up', 1);
    expect(addrKey(member)).toBe(addr(9000).toString());
  });
});

/* ============================== LeaseMajority ============================== */

/**
 * Hand-rolled controllable Lease so the tests can pin acquire-result
 * timing.  Promises are deferred — the test resolves them explicitly.
 */
class FakeLease implements Lease {
  private nextAcquire: { resolve: (b: boolean) => void; reject: (e: Error) => void } | null = null;
  acquireCalls = 0;
  released = false;

  acquire(): Promise<boolean> {
    this.acquireCalls++;
    return new Promise<boolean>((resolve, reject) => {
      this.nextAcquire = { resolve, reject };
    });
  }
  resolveAcquire(got: boolean): void {
    const pending = this.nextAcquire;
    if (!pending) throw new Error('FakeLease.resolveAcquire: no acquire in flight');
    this.nextAcquire = null;
    pending.resolve(got);
  }
  rejectAcquire(reason: string): void {
    const pending = this.nextAcquire;
    if (!pending) throw new Error('FakeLease.rejectAcquire: no acquire in flight');
    this.nextAcquire = null;
    pending.reject(new Error(reason));
  }
  async release(): Promise<void> { this.released = true; }
  checkAlive(): boolean { return false; }
  onLost(): () => void { return () => {}; }
}

const flushMicrotasks = (): Promise<void> =>
  new Promise((r) => setTimeout(r, 0));

describe('LeaseMajority', () => {
  test('strict majority: returns the unreachable side without touching the lease', () => {
    const lease = new FakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease);
    const strat = new LeaseMajority(leaseOptions);
    // 5 members, 3 reachable (1,2,3) vs 2 unreachable (4,5).
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }, { port: 5 }], [4, 5]);
    const decision = strat.decide(clusterView);
    expect(decision.size).toBe(2);
    expect(decision.has(addr(4).toString())).toBe(true);
    expect(decision.has(addr(5).toString())).toBe(true);
    expect(lease.acquireCalls).toBe(0);
  });

  test('strict minority: downs our own side without touching the lease', () => {
    const lease = new FakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease);
    const strat = new LeaseMajority(leaseOptions);
    // 5 members, but from this perspective unreachable=[1,2,3], reachable=[4,5].
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }, { port: 5 }], [1, 2, 3], 4);
    const decision = strat.decide(clusterView);
    expect(decision.size).toBe(2);
    expect(decision.has(addr(4).toString())).toBe(true);
    expect(decision.has(addr(5).toString())).toBe(true);
    expect(lease.acquireCalls).toBe(0);
  });

  test('equal-size split: starts acquire, returns no decision until it resolves', async () => {
    const lease = new FakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease);
    const strat = new LeaseMajority(leaseOptions);
    // 4 members, 2/2 split.
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);
    const decision = strat.decide(clusterView);
    expect(decision.size).toBe(0);                  // pending
    expect(lease.acquireCalls).toBe(1);

    // Calling decide() again with the same view: still pending, no
    // duplicate acquire.
    expect(strat.decide(clusterView).size).toBe(0);
    expect(lease.acquireCalls).toBe(1);

    // Resolve the acquire as winner — next decide() returns the
    // unreachable set.
    lease.resolveAcquire(true);
    await flushMicrotasks();
    const after = strat.decide(clusterView);
    expect(after.size).toBe(2);
    expect(after.has(addr(3).toString())).toBe(true);
    expect(after.has(addr(4).toString())).toBe(true);
  });

  test('equal-size split + acquire returns false: down our own side', async () => {
    const lease = new FakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease);
    const strat = new LeaseMajority(leaseOptions);
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);
    expect(strat.decide(clusterView).size).toBe(0);
    lease.resolveAcquire(false);
    await flushMicrotasks();
    const after = strat.decide(clusterView);
    expect(after.size).toBe(2);
    // We are 1; reachable side is 1+2 — both should be downed.
    expect(after.has(addr(1).toString())).toBe(true);
    expect(after.has(addr(2).toString())).toBe(true);
  });

  test('lease unreachable (acquire rejects): pending stays pending; next tick retries', async () => {
    const lease = new FakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease);
    const strat = new LeaseMajority(leaseOptions);
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);
    expect(strat.decide(clusterView).size).toBe(0);
    lease.rejectAcquire('K8s API unreachable');
    await flushMicrotasks();
    // Still pending — strategy never risks both surviving.
    expect(strat.decide(clusterView).size).toBe(0);
    // Next decide() with same view triggers a fresh acquire.
    expect(lease.acquireCalls).toBe(2);
  });

  test('partition view changes between ticks: state resets, fresh acquire kicks off', async () => {
    const lease = new FakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease);
    const strat = new LeaseMajority(leaseOptions);
    // First view: 2/2 split.  Acquire kicks off.
    const v1 = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);
    expect(strat.decide(v1).size).toBe(0);
    expect(lease.acquireCalls).toBe(1);
    // Resolve as winner so we cache a decision.
    lease.resolveAcquire(true);
    await flushMicrotasks();
    expect(strat.decide(v1).size).toBe(2);

    // New partition (different unreachable set) → strategy resets.
    const v2 = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [2, 4], 1);
    expect(strat.decide(v2).size).toBe(0);
    expect(lease.acquireCalls).toBe(2);
  });

  test('role filter: only role-tagged members count toward majority calculation', () => {
    const lease = new FakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease).withRole('worker');
    const strat = new LeaseMajority(leaseOptions);
    // 3 workers (1,2,3) + 1 idle (9).  Unreachable=[3].  Workers
    // alone: 2 reachable vs 1 unreachable → strict majority → no Lease.
    const clusterView = view([
      { port: 1, roles: ['worker'] },
      { port: 2, roles: ['worker'] },
      { port: 3, roles: ['worker'] },
      { port: 9, roles: ['idle'] },
    ], [3]);
    const decision = strat.decide(clusterView);
    expect(decision.has(addr(3).toString())).toBe(true);
    expect(decision.has(addr(9).toString())).toBe(false);
    expect(lease.acquireCalls).toBe(0);
  });

  test('no partition (everyone reachable): empty decision, no lease activity', () => {
    const lease = new FakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease);
    const strat = new LeaseMajority(leaseOptions);
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }], []);
    expect(strat.decide(clusterView).size).toBe(0);
    expect(lease.acquireCalls).toBe(0);
  });
});

/* ============= LeaseMajority — #142 split-brain hardening ============= */

/**
 * Controllable lease that tracks every acquire individually so we can
 * resolve them out-of-order — required for the "stale acquire returns
 * `true` after the local timeout invalidated it" scenario.
 */
class FencedFakeLease implements Lease {
  /** Pending acquires in order of issue, so tests can resolve a specific one. */
  private pending: Array<{
    resolve: (result: boolean | { token: string } | null) => void;
    reject: (e: Error) => void;
    kind: 'plain' | 'token';
  }> = [];
  acquireCalls = 0;
  plainAcquireCalls = 0;
  tokenAcquireCalls = 0;
  released = false;
  releaseShouldReject = false;
  /** Tokens that will be returned for successive token-acquires. */
  tokenStream: string[] = ['t1', 't2', 't3', 't4'];

  acquire(): Promise<boolean> {
    this.acquireCalls++;
    this.plainAcquireCalls++;
    return new Promise<boolean>((resolve, reject) => {
      this.pending.push({
        resolve: (clusterView) => resolve(clusterView as boolean),
        reject,
        kind: 'plain',
      });
    });
  }

  acquireWithToken(): Promise<{ readonly token: string } | null> {
    this.acquireCalls++;
    this.tokenAcquireCalls++;
    return new Promise<{ readonly token: string } | null>((resolve, reject) => {
      this.pending.push({
        resolve: (clusterView) => resolve(clusterView as { token: string } | null),
        reject,
        kind: 'token',
      });
    });
  }

  /** Resolve the Nth-issued pending acquire with the given outcome. */
  resolveAt(idx: number, got: boolean): void {
    const entry = this.pending[idx];
    if (!entry) throw new Error(`FencedFakeLease.resolveAt(${idx}): no such pending acquire`);
    this.pending[idx] = null as never;
    if (entry.kind === 'token') {
      const value = got ? { token: this.tokenStream.shift() ?? 'tX' } : null;
      entry.resolve(value);
    } else {
      entry.resolve(got);
    }
  }

  pendingCount(): number {
    return this.pending.filter((p) => p !== null).length;
  }

  async release(): Promise<void> {
    if (this.releaseShouldReject) throw new Error('release failed');
    this.released = true;
  }
  checkAlive(): boolean { return false; }
  onLost(): () => void { return () => {}; }
}

describe('LeaseMajority — #142 split-brain hardening', () => {
  /**
   * The headline regression: a slow acquire that resolves `true` AFTER
   * the local timeout-recovery has invalidated it must NOT write
   * `decision=surviveSet`.  Without the epoch guard, that write was
   * what let both sides of a partition simultaneously believe they
   * won the lease.
   */
  test('late-arriving acquire result with stale epoch is dropped', async () => {
    const lease = new FencedFakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease).withAcquireTimeoutMs(50);
    const strat = new LeaseMajority(leaseOptions);
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);

    // 1. Initial decide() kicks off acquire #1 (epoch 1).
    expect(strat.decide(clusterView).size).toBe(0);
    expect(lease.acquireCalls).toBe(1);
    expect(lease.pendingCount()).toBe(1);

    // 2. Simulate the local timeout firing — advance past the deadline.
    await new Promise((r) => setTimeout(r, 60));

    // 3. Another decide() detects the deadline passed → bumps epoch,
    //    fires release, and kicks off acquire #2 in the same call
    //    sequence (the next decide() does the kickoff because
    //    acquiring=false now).
    expect(strat.decide(clusterView).size).toBe(0);             // first decide post-timeout: notices deadline, no new kickoff yet
    expect(strat.decide(clusterView).size).toBe(0);             // second decide: now acquiring=false, kicks off acquire #2
    expect(lease.acquireCalls).toBe(2);
    expect(lease.released).toBe(true);

    // 4. Now the SLOW acquire #1 finally resolves "won".
    //    Without the epoch guard, this would write decision=surviveSet
    //    even though we abandoned the attempt — the exact split-brain
    //    vector.
    lease.resolveAt(0, true);
    await flushMicrotasks();
    expect(strat.decide(clusterView).size).toBe(0);             // still pending — late result was discarded

    // 5. Acquire #2 resolves "lost" — the OTHER side won during the
    //    cleanup window.  Strategy must converge to "down our own side".
    lease.resolveAt(1, false);
    await flushMicrotasks();
    const after = strat.decide(clusterView);
    expect(after.size).toBe(2);
    expect(after.has(addr(1).toString())).toBe(true);
    expect(after.has(addr(2).toString())).toBe(true);
  });

  test('timeout proactively releases the lease to undo a may-have-succeeded acquire on the wire', async () => {
    const lease = new FencedFakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease).withAcquireTimeoutMs(30);
    const strat = new LeaseMajority(leaseOptions);
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);

    expect(strat.decide(clusterView).size).toBe(0);
    expect(lease.released).toBe(false);

    // Cross the deadline.
    await new Promise((r) => setTimeout(r, 50));

    // Next decide() triggers the abandon-release.
    strat.decide(clusterView);
    // release is fire-and-forget; let it run.
    await flushMicrotasks();
    expect(lease.released).toBe(true);
  });

  test('release rejection puts the strategy in fail-safe until the partition heals', async () => {
    const lease = new FencedFakeLease();
    lease.releaseShouldReject = true;
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease).withAcquireTimeoutMs(30);
    const strat = new LeaseMajority(leaseOptions);
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);

    expect(strat.decide(clusterView).size).toBe(0);
    await new Promise((r) => setTimeout(r, 50));

    // First post-timeout decide: notices deadline, triggers release
    // (which rejects, setting fail-safe).
    strat.decide(clusterView);
    await flushMicrotasks();
    await flushMicrotasks();

    // Subsequent decide() calls on the SAME partition view must NOT
    // claim majority — even if a fresh acquire would now succeed.
    // The lease state is ambiguous.
    expect(strat.decide(clusterView).size).toBe(0);
    expect(strat.decide(clusterView).size).toBe(0);

    // Healing the partition resets fail-safe — strategy is ready
    // for the next split.
    const healed = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], []);
    expect(strat.decide(healed).size).toBe(0);

    // A fresh split now kicks off a fresh acquire normally.
    const newSplit = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);
    const callsBefore = lease.acquireCalls;
    expect(strat.decide(newSplit).size).toBe(0);
    expect(lease.acquireCalls).toBe(callsBefore + 1);
  });

  test('uses acquireWithToken when the backend implements it', async () => {
    const lease = new FencedFakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease);
    const strat = new LeaseMajority(leaseOptions);
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);

    expect(strat.decide(clusterView).size).toBe(0);
    // Strategy must prefer the token-based API when present.  A
    // future regression that strips the feature-detection path
    // would route through plainAcquireCalls and fail loudly here.
    expect(lease.tokenAcquireCalls).toBe(1);
    expect(lease.plainAcquireCalls).toBe(0);

    // Resolve as winner via the token path.
    lease.resolveAt(0, true);
    await flushMicrotasks();
    const decision = strat.decide(clusterView);
    expect(decision.size).toBe(2);
    expect(decision.has(addr(3).toString())).toBe(true);
    expect(decision.has(addr(4).toString())).toBe(true);
  });

  test('reset (partition heal) drops in-flight acquire results via epoch bump', async () => {
    const lease = new FencedFakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease);
    const strat = new LeaseMajority(leaseOptions);
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);

    expect(strat.decide(clusterView).size).toBe(0);
    expect(lease.acquireCalls).toBe(1);

    // Heal the partition before the acquire resolves.
    const healed = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], []);
    expect(strat.decide(healed).size).toBe(0);

    // Now the in-flight acquire finally resolves as "won".  Without
    // the epoch bump in reset(), this would have written
    // `decision=surviveSet` against a healed view — a phantom split-
    // brain.
    lease.resolveAt(0, true);
    await flushMicrotasks();

    // Same healed view: no decision lingering.
    expect(strat.decide(healed).size).toBe(0);

    // A NEW split must kick off a fresh acquire — no cached decision
    // is allowed to leak from the previous epoch.
    const newSplit = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);
    const callsBefore = lease.acquireCalls;
    expect(strat.decide(newSplit).size).toBe(0);
    expect(lease.acquireCalls).toBe(callsBefore + 1);
  });
});
