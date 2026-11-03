import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions, type ActorSystemOptionsBuilder } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Config } from '../../../src/config/Config.js';
import { DistributedDataId, DistributedDataOptions, GCounter } from '../../../src/crdt/index.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * The code route to the default quorum deadline, end to end (#856): the
 * builder the quorum page shows, handed to `start`, sets how long a quorum
 * call that names no `timeoutMs` waits — over what
 * `actor-ts.distributed-data.quorum-timeout` says, because explicit options
 * beat the file.
 *
 * The peer joins and never starts DistributedData, so nothing acknowledges and
 * every request runs into its deadline, whose number the rejection names.
 *
 * The second call is what tells the deadline from the ceiling.
 * `max-quorum-timeout` clamps the default as it clamps a caller's value, so a
 * `withQuorumTimeout` wired to the ceiling produces the first message
 * unchanged — the file's 3 s clamped to 150 ms — and only shows itself when a
 * caller asks for more than 150 ms and gets 150.
 */

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

/** Join `name` on `port` to the cluster `seed` names, or start one when there is none. */
async function joinNode(name: string, port: number, systemOptions: ActorSystemOptionsBuilder, seed?: string): Promise<Cluster> {
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(80);
  if (seed !== undefined) clusterOptions.withSeeds([seed]);
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return cluster;
}

const quiet = (): ActorSystemOptionsBuilder => ActorSystemOptions.create()
  .withLogger(new NoopLogger())
  .withLogLevel(LogLevel.Off);

/** Why `outcome` rejected — or a sentence saying it did not, which no pattern below matches. */
function reasonOf(outcome: PromiseSettledResult<unknown>): string {
  if (outcome.status === 'fulfilled') return 'the call resolved instead of timing out';
  return outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
}

describe('DistributedDataOptions.withQuorumTimeout, handed to start', () => {
  test('sets the deadline of a call that names none, over the configured one, and is not a ceiling', async () => {
    const configured = quiet().withConfig(Config.parseString('actor-ts.distributed-data.quorum-timeout = 3s'));
    const a = await joinNode('quorum-from-code-a', 48_561, configured);
    await joinNode('quorum-from-code-b', 48_562, quiet(), 'quorum-from-code-a@h:48561');
    await awaitCondition(() => a.upMembers().length >= 2, {
      timeoutMs: 4_000,
      intervalMs: 25,
      label: 'the two-node cluster converged',
    });

    const distributedDataOptions = DistributedDataOptions.create().withQuorumTimeout(150);
    const handle = a.system.extension(DistributedDataId).start(a, distributedDataOptions);
    const [byDefault, byCaller] = await Promise.allSettled([
      handle.updateAsync('by-default', GCounter.empty, (c) => c.increment('a', 1), { consistency: 'all' }),
      handle.updateAsync('by-caller', GCounter.empty, (c) => c.increment('a', 1), { consistency: 'all', timeoutMs: 400 }),
    ]);

    expect(reasonOf(byDefault)).toMatch(/timed out after 150ms/);
    expect(reasonOf(byCaller)).toMatch(/timed out after 400ms/);
  }, 10_000);
});
