/**
 * Child-process fixture for `tests/unit/cluster/downing/LeaseMajorityTerminate.test.ts`
 * (#1753).
 *
 * The setup of `LeaseMajorityLeave.fixture.ts` — two in-process nodes, an even
 * split only the lease decides, `lease-majority` selected in configuration over
 * the in-memory store — with one difference: the winner never leaves.  Both
 * systems are terminated bare, and the fixture returns.  Whether this process
 * then exits, and whether the record was given back, is the whole assertion: a
 * lease nobody released is renewed on its provider's own scheduler, a timer
 * that holds the event loop open.
 */
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { Config } from '../../../../src/config/Config.js';
import { _substituteLeaseBackendForTest } from '../../../../src/coordination/LeaseFromConfig.js';
import { InMemoryLease, inMemoryLeaseStore } from '../../../../src/coordination/leases/InMemoryLease.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const SYSTEM = 'lease-terminate-exit';
const RECORD = `${SYSTEM}-split-brain-resolver`;

/** `lease-majority` over a `kubernetes` lease, which the backend seam below turns into an in-memory one. */
const LEASE_MAJORITY = `
  actor-ts.coordination.lease { backend = kubernetes, ttl = 2s }
  actor-ts.cluster.split-brain-resolver.active-strategy = lease-majority
`;

_substituteLeaseBackendForTest((options, config) => new InMemoryLease(options, config));

async function startNode(port: number, seeds: string[], hocon?: string): Promise<{ system: ActorSystem; cluster: Cluster }> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (hocon !== undefined) systemOptions.withConfig(Config.parseString(hocon));
  const system = ActorSystem.create(SYSTEM, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(SYSTEM, 'h', port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 4_000 })
    .withFailureDetectorAutoDown(false)
    .withSplitBrainResolver({ stableAfterMs: 1 })
    .withGossipIntervalMs(80)
    .withSeeds(seeds);
  return { system, cluster: await Cluster.join(system, clusterOptions) };
}

const a = await startNode(64_761, [], LEASE_MAJORITY);
// b runs no strategy, so a's arbitration is the only one and a wins it.
const b = await startNode(64_762, [`${SYSTEM}@h:64761`]);
await awaitCondition(() => a.cluster.upMembers().length === 2, { timeoutMs: 4_000, label: 'both members up on a' });
// b goes silent without leaving: an even split only the lease decides.
await b.cluster.transport.shutdown();
await awaitCondition(
  () => inMemoryLeaseStore.peek(RECORD)?.owner.startsWith(`${SYSTEM}@h:64761`) === true,
  { timeoutMs: 4_000, label: 'a won the arbitration' },
);
// Printed so a parent can tell "never got this far" from "got here and was
// held open" — the exit code alone cannot.
console.log('won=true');

// No leave: a bare terminate, which runs no coordinated shutdown under the
// shipped `run-by-actor-system-terminate = false`.
await a.system.terminate();
await b.system.terminate();
console.log(`released=${inMemoryLeaseStore.peek(RECORD) === undefined}`);
