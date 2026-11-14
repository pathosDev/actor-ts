import type { Cluster } from '../../src/cluster/Cluster.js';
import { Member } from '../../src/cluster/Member.js';
import type { NodeAddress } from '../../src/cluster/NodeAddress.js';

/**
 * Write `node` into `cluster`'s member view as `up`, with nothing running
 * behind it, and hand it back.
 *
 * A region refuses a `ShardHome` on a node that is no current member (#1750),
 * so a test that places a shard on another node it never starts has to make
 * that node a member first.  Written into the membership map directly, the way
 * `HandOffTimeout.test.ts` stages its fabricated regions' nodes, so no gossip
 * round has to admit it.
 */
export function stageMember(cluster: Cluster, node: NodeAddress): NodeAddress {
  (cluster as unknown as { readonly members: Map<string, Member> }).members
    .set(node.toString(), new Member(node, 'up', 1));
  return node;
}
