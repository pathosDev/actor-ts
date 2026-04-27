import { describe, expect, test } from 'bun:test';
import {
  KeepMajority,
  KeepOldest,
  StaticQuorum,
  KeepReferee,
  addrKey,
  type ClusterPartitionView,
} from '../../../../src/cluster/downing/index.js';
import { Member } from '../../../../src/cluster/Member.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';

const addr = (port: number, host = 'h'): NodeAddress => new NodeAddress('sys', host, port);

/** Build a view with the given members + explicit unreachable addresses. */
function view(
  members: Array<{ port: number; status?: string; roles?: string[] }>,
  unreachablePorts: number[],
  selfPort = members[0]!.port,
): ClusterPartitionView {
  const ms: Member[] = members.map((m) =>
    new Member(addr(m.port), (m.status ?? 'up') as never, 1, m.roles ?? []));
  const unreachable = new Set(unreachablePorts.map((p) => addr(p).toString()));
  return { allMembers: ms, unreachable, self: addr(selfPort) };
}

describe('KeepMajority', () => {
  test('reachable majority downs the minority', () => {
    const v = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }, { port: 5 }], [4, 5]);
    const decision = new KeepMajority().decide(v);
    expect(decision.has(addr(4).toString())).toBe(true);
    expect(decision.has(addr(5).toString())).toBe(true);
    expect(decision.size).toBe(2);
  });

  test('minority side downs itself', () => {
    const v = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }, { port: 5 }], [1, 2, 3]);
    const decision = new KeepMajority().decide(v);
    // "We" see ports 4,5 as reachable but they are in the minority.
    expect(decision.has(addr(4).toString())).toBe(true);
    expect(decision.has(addr(5).toString())).toBe(true);
  });

  test('tie stays pending (no decision)', () => {
    const v = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);
    expect(new KeepMajority().decide(v).size).toBe(0);
  });

  test('role filter only counts tagged members', () => {
    // 3 workers, 1 idle node; unreachable=[3] (worker).  Among workers
    // only (ports 1,2,3), 2 are reachable vs 1 unreachable → majority → down 3.
    const v = view([
      { port: 1, roles: ['worker'] },
      { port: 2, roles: ['worker'] },
      { port: 3, roles: ['worker'] },
      { port: 9, roles: ['idle'] }, // excluded
    ], [3]);
    const decision = new KeepMajority({ role: 'worker' }).decide(v);
    expect(decision.has(addr(3).toString())).toBe(true);
    expect(decision.has(addr(9).toString())).toBe(false); // not even considered
  });
});

describe('KeepOldest', () => {
  test('oldest-reachable side downs the other', () => {
    const v = view([{ port: 1 }, { port: 2 }, { port: 3 }], [2, 3]);
    const decision = new KeepOldest().decide(v);
    expect(decision.has(addr(2).toString())).toBe(true);
    expect(decision.has(addr(3).toString())).toBe(true);
  });

  test('oldest-unreachable → this side downs itself', () => {
    const v = view([{ port: 1 }, { port: 2 }, { port: 3 }], [1]);
    const decision = new KeepOldest().decide(v);
    // Ports 2 & 3 are reachable but oldest (1) is on other side → they down themselves.
    expect(decision.has(addr(2).toString())).toBe(true);
    expect(decision.has(addr(3).toString())).toBe(true);
  });
});

describe('StaticQuorum', () => {
  test('reachable meets quorum → down unreachable', () => {
    const v = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [3, 4]);
    const decision = new StaticQuorum({ quorumSize: 2 }).decide(v);
    expect(decision.has(addr(3).toString())).toBe(true);
    expect(decision.has(addr(4).toString())).toBe(true);
  });

  test('reachable below quorum → down ourselves', () => {
    const v = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [2, 3, 4]);
    const decision = new StaticQuorum({ quorumSize: 2 }).decide(v);
    // Only port 1 is reachable; we're under quorum → down self.
    expect(decision.has(addr(1).toString())).toBe(true);
  });

  test('quorumSize < 1 throws', () => {
    expect(() => new StaticQuorum({ quorumSize: 0 })).toThrow(/quorumSize/);
  });
});

describe('KeepReferee', () => {
  test('referee reachable on this side → down the other', () => {
    const v = view([{ port: 1 }, { port: 2 }, { port: 3 }], [3]);
    const decision = new KeepReferee({ refereeAddress: addr(1).toString() }).decide(v);
    expect(decision.has(addr(3).toString())).toBe(true);
  });

  test('referee unreachable → down this side', () => {
    const v = view([{ port: 1 }, { port: 2 }, { port: 3 }], [1]);
    const decision = new KeepReferee({ refereeAddress: addr(1).toString() }).decide(v);
    // Ports 2 & 3 are reachable but referee is on other side → down self.
    expect(decision.has(addr(2).toString())).toBe(true);
    expect(decision.has(addr(3).toString())).toBe(true);
  });

  test('downAllIfBelowQuorum downs everyone when referee-side too small', () => {
    const v = view([{ port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }], [2, 3, 4]);
    const decision = new KeepReferee({
      refereeAddress: addr(1).toString(),
      downAllIfBelowQuorum: 3,
    }).decide(v);
    // Only port 1 is reachable (referee side) — below quorum of 3 → down all.
    expect(decision.size).toBe(4);
  });
});

describe('addrKey helper', () => {
  test('serialises member address consistently with NodeAddress.toString', () => {
    const m = new Member(addr(9000), 'up', 1);
    expect(addrKey(m)).toBe(addr(9000).toString());
  });
});
