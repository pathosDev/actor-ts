/**
 * Realistic SBR: simulate a 5-node partition and run KeepMajority against
 * both sides of the split.  On side A (3 reachable) we decide to down
 * sides B (2 unreachable).  On side B (viewing A as unreachable) we
 * correctly decide to down ourselves — so the cluster converges on a
 * single surviving half.
 *
 *   bun run examples/cluster/downing/split-brain-survives.ts
 */
import {
  KeepMajority,
  Member,
  NodeAddress,
  type ClusterPartitionView,
} from '../../../src/index.js';

function addr(port: number): NodeAddress { return new NodeAddress('sys', 'h', port); }

const allMembers: Member[] = [1, 2, 3, 4, 5].map((p) => new Member(addr(p), 'up', 1));

// Side A sees 4 and 5 as unreachable.
const viewA: ClusterPartitionView = {
  allMembers, self: addr(1),
  unreachable: new Set([addr(4), addr(5)].map(a => a.toString())),
};
// Side B sees 1, 2, 3 as unreachable.
const viewB: ClusterPartitionView = {
  allMembers, self: addr(4),
  unreachable: new Set([addr(1), addr(2), addr(3)].map(a => a.toString())),
};

const strategy = new KeepMajority();

const decA = strategy.decide(viewA);
const decB = strategy.decide(viewB);

console.log('side A decides to down:', [...decA]);
console.log('side B decides to down:', [...decB]);

// Expected: both sides agree — A downs {4,5}, B downs itself {4,5}.
const sameDecision = [...decA].every((a) => decB.has(a))
  && [...decB].every((b) => decA.has(b));
console.log(sameDecision ? 'decisions agree ✓ — no split-brain' : 'split-brain possible ✗');
