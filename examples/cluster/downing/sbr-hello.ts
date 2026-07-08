/**
 * Hello Split-Brain Resolver: exercise each strategy on a synthetic
 * partition view — no actual cluster needed.
 *
 *   bun run examples/cluster/downing/sbr-hello.ts
 */
import {
  KeepMajority,
  KeepOldest,
  KeepReferee,
  KeepRefereeOptions,
  Member,
  NodeAddress,
  StaticQuorum,
  StaticQuorumOptions,
} from '../../../src/index.js';

function addr(port: number): NodeAddress { return new NodeAddress('sys', 'h', port); }
function upMember(port: number, roles: string[] = []): Member {
  return new Member(addr(port), 'up', 1, roles);
}

const allMembers = [upMember(1), upMember(2), upMember(3), upMember(4), upMember(5)];
const unreachable = new Set([addr(4).toString(), addr(5).toString()]);
const view = { allMembers, unreachable, self: addr(1) };

function show(name: string, decision: ReadonlySet<string>): void {
  console.log(`${name}: down = [${[...decision].join(', ')}]`);
}

show('KeepMajority        ', new KeepMajority().decide(view));
show('KeepOldest          ', new KeepOldest().decide(view));
const staticQuorumOptions = StaticQuorumOptions.create().withQuorumSize(3);
show('StaticQuorum(n=3)   ', new StaticQuorum(staticQuorumOptions).decide(view));
const keepRefereeOptions = KeepRefereeOptions.create().withRefereeAddress(addr(1).toString());
show('KeepReferee(port=1) ', new KeepReferee(keepRefereeOptions).decide(view));
