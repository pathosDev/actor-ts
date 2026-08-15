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
import { OptionsError } from '../../../../../src/util/OptionsValidator.js';
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

  test('exact 50/50 tie — each side downs itself, so the cluster stops whole', () => {
    // The 2-2 split, seen from both halves.  Neither reaches `needed`, and
    // the answer has to be symmetric: if one side stayed up while the other
    // downed itself the outcome would depend on which view we asked.
    const members = [{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }];

    const fromOneTwo = new KeepMajority().decide(view(members, [3, 4], 1));
    expect(fromOneTwo).toEqual(new Set([addr(1).toString(), addr(2).toString()]));

    const fromThreeFour = new KeepMajority().decide(view(members, [1, 2], 3));
    expect(fromThreeFour).toEqual(new Set([addr(3).toString(), addr(4).toString()]));

    // Together the two halves down every member — a stopped cluster, not a
    // forked one.  This is the property #1170 was about; "pending" left both
    // halves live for the duration of the partition.
    const downed = new Set([...fromOneTwo, ...fromThreeFour]);
    expect(downed.size).toBe(members.length);
  });

  test('odd member count always reaches a verdict on a partition', () => {
    // With an odd count one side always holds `floor(n/2) + 1`, so the tie
    // path is unreachable and a real split is always decided one way or the
    // other.  This is what makes an odd cluster the recommended shape rather
    // than merely the tidy one.
    const members = [{ port: 1 }, { port: 2 }, { port: 3 }];
    for (const unreachablePorts of [[3], [2, 3], [1], [1, 2]]) {
      const decision = new KeepMajority().decide(view(members, unreachablePorts, 1));
      expect(decision.size).toBeGreaterThan(0);
    }

    // A view with nothing unreachable is not a partition: there is simply
    // nothing to down, and an empty decision is the right answer.
    expect(new KeepMajority().decide(view(members, [])).size).toBe(0);
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
    expect(() => new StaticQuorum(quorumOptions)).toThrow(OptionsError);
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
 *
 * Models the `held` gate that both shipped backends have (#600): the
 * lease is only owned once an acquire has RESOLVED as won, and
 * `release()` is a no-op before then.  Without that, the double accepted
 * a release at any moment and the #142 tests passed against semantics no
 * real `Lease` implements.
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
  /** True once an acquire resolved as won — mirrors the backends' `held`. */
  private held = false;
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
  resolveAt(index: number, got: boolean): void {
    const entry = this.pending[index];
    if (!entry) throw new Error(`FencedFakeLease.resolveAt(${index}): no such pending acquire`);
    this.pending[index] = null as never;
    // Ownership starts here, not when acquire() was called — which is why
    // a release fired at timeout time cannot undo anything.
    if (got) this.held = true;
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
    if (!this.held) return;                      // the contract's no-op
    if (this.releaseShouldReject) throw new Error('release failed');
    this.held = false;
    this.released = true;
  }
  checkAlive(): boolean { return this.held; }
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

    // 3. Another decide() detects the deadline passed → bumps the epoch
    //    and abandons attempt #1.  No fresh acquire starts while that
    //    attempt is unresolved (#600) — one of them landing on the wire
    //    while the other is being undone is the race the block prevents.
    expect(strat.decide(clusterView).size).toBe(0);             // notices the deadline, abandons #1
    expect(strat.decide(clusterView).size).toBe(0);             // still waiting on the abandoned attempt
    expect(lease.acquireCalls).toBe(1);
    expect(lease.released).toBe(false);                         // nothing taken yet, nothing to undo

    // 4. Now the SLOW acquire #1 finally resolves "won".
    //    Without the epoch guard, this would write decision=surviveSet
    //    even though we abandoned the attempt — the exact split-brain
    //    vector.  The win is undone instead.
    lease.resolveAt(0, true);
    await flushMicrotasks();
    expect(strat.decide(clusterView).size).toBe(0);             // still pending — late result was discarded
    expect(lease.released).toBe(true);

    // 5. With the undo done, the next decide() kicks off acquire #2,
    //    which resolves "lost" — the OTHER side won during the cleanup
    //    window.  Strategy must converge to "down our own side".
    expect(lease.acquireCalls).toBe(2);
    lease.resolveAt(1, false);
    await flushMicrotasks();
    const after = strat.decide(clusterView);
    expect(after.size).toBe(2);
    expect(after.has(addr(1).toString())).toBe(true);
    expect(after.has(addr(2).toString())).toBe(true);
  });

  /**
   * The #600 regression.  #142 fired `release()` from the timeout branch,
   * where the backend cannot yet hold the lease — `release()` is a no-op
   * until an acquire has resolved, so the abandoned attempt went on to
   * land, set `held`, start its renewal loop and keep the record claimed
   * for good.  The undo has to wait for the attempt to report back.
   */
  test('an abandoned acquire that lands on the wire is released, not left claimed', async () => {
    const lease = new FencedFakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease).withAcquireTimeoutMs(30);
    const strat = new LeaseMajority(leaseOptions);
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);

    expect(strat.decide(clusterView).size).toBe(0);
    expect(lease.released).toBe(false);

    // Cross the deadline and abandon the attempt.
    await new Promise((r) => setTimeout(r, 50));
    strat.decide(clusterView);
    await flushMicrotasks();
    // Releasing here would be a no-op against every real backend, so the
    // strategy does not even try.
    expect(lease.released).toBe(false);
    expect(lease.checkAlive()).toBe(false);

    // The abandoned acquire succeeds on the wire — now there is ownership
    // to undo, and it gets undone.
    lease.resolveAt(0, true);
    await flushMicrotasks();
    expect(lease.released).toBe(true);
    expect(lease.checkAlive()).toBe(false);
  });

  test('an abandoned acquire that lost is not released, and unblocks the next attempt', async () => {
    const lease = new FencedFakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease).withAcquireTimeoutMs(30);
    const strat = new LeaseMajority(leaseOptions);
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);

    expect(strat.decide(clusterView).size).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    strat.decide(clusterView);

    lease.resolveAt(0, false);
    await flushMicrotasks();
    expect(lease.released).toBe(false);      // never held it — nothing to release

    // The block on fresh attempts lifts as soon as the abandoned one
    // reports back, however it reports.
    expect(strat.decide(clusterView).size).toBe(0);
    expect(lease.acquireCalls).toBe(2);
  });

  test('release rejection puts the strategy in fail-safe until the partition heals', async () => {
    const lease = new FencedFakeLease();
    lease.releaseShouldReject = true;
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease).withAcquireTimeoutMs(30);
    const strat = new LeaseMajority(leaseOptions);
    const clusterView = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);

    expect(strat.decide(clusterView).size).toBe(0);
    await new Promise((r) => setTimeout(r, 50));

    // First post-timeout decide: notices the deadline and abandons the
    // attempt.  The attempt then lands, so the undo runs — and rejects,
    // which is what sets fail-safe.
    strat.decide(clusterView);
    lease.resolveAt(0, true);
    await flushMicrotasks();
    await flushMicrotasks();

    // Subsequent decide() calls on the SAME partition view must NOT
    // claim majority — even if a fresh acquire would now succeed.
    // The lease state is ambiguous, so the strategy refuses to even
    // start another attempt (a same-owner re-acquire would "win"
    // trivially and hand us a false majority).
    expect(strat.decide(clusterView).size).toBe(0);
    expect(strat.decide(clusterView).size).toBe(0);
    expect(lease.acquireCalls).toBe(1);

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

  /**
   * `reset()` is the second way an acquire loses its watcher, and it is
   * the likelier one: the acquire budget is 5 s by default, while a
   * partition healing or a membership change inside that window needs no
   * stall at all.  Dropping the result is not enough — the attempt can
   * still land on the wire, and then the record is claimed and renewed
   * forever by a node whose own strategy walked away from it.  That is
   * the exact end state #600 exists to prevent, so the heal path has to
   * track the abandoned attempt just like the timeout path does.
   *
   * `acquireTimeoutMs` is deliberately far out of reach here, so nothing
   * but the heal can abandon the attempt.
   */
  test('a heal mid-acquire abandons the attempt: a late win is released, not left claimed', async () => {
    const lease = new FencedFakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease).withAcquireTimeoutMs(30_000);
    const strat = new LeaseMajority(leaseOptions);
    const split = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);

    expect(strat.decide(split).size).toBe(0);
    expect(lease.acquireCalls).toBe(1);

    // The partition heals while acquire #1 is still on the wire.
    const healed = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], []);
    expect(strat.decide(healed).size).toBe(0);

    // #1 lands as a win.  Nobody is reading its result any more, so
    // unless it is undone the backend holds and renews the lease for good.
    lease.resolveAt(0, true);
    await flushMicrotasks();
    expect(lease.released).toBe(true);
    expect(lease.checkAlive()).toBe(false);

    // With the undo done, the strategy is ready for the next split.
    const newSplit = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);
    expect(strat.decide(newSplit).size).toBe(0);
    expect(lease.acquireCalls).toBe(2);
  });

  /**
   * The same reset, reached through a changed partition view instead of a
   * heal.  Here `decide()` does not return early, so an untracked
   * abandonment is worse than a leak: it starts acquire #2 while #1 is
   * still outstanding, breaking the "no overlapping attempts" rule that
   * makes the abandon-release safe in the first place.
   */
  test('a partition-view change mid-acquire waits for the abandoned attempt instead of overlapping a second', async () => {
    const lease = new FencedFakeLease();
    const leaseOptions = LeaseMajorityOptions.create().withLease(lease).withAcquireTimeoutMs(30_000);
    const strat = new LeaseMajority(leaseOptions);
    const splitA = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);

    expect(strat.decide(splitA).size).toBe(0);
    expect(lease.acquireCalls).toBe(1);

    // Different unreachable set, still an even split — acquire #1 is
    // invalidated but remains on the wire.
    const splitB = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [2, 4], 1);
    expect(strat.decide(splitB).size).toBe(0);
    expect(lease.acquireCalls).toBe(1);
    expect(strat.decide(splitB).size).toBe(0);
    expect(lease.acquireCalls).toBe(1);

    // Only once #1 has reported back — and its win has been undone — may
    // a fresh attempt for the new view start.
    lease.resolveAt(0, true);
    await flushMicrotasks();
    expect(lease.released).toBe(true);
    expect(strat.decide(splitB).size).toBe(0);
    expect(lease.acquireCalls).toBe(2);
  });
});
