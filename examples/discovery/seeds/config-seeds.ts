/**
 * Hello seed discovery: resolve cluster seeds from a plain config list or
 * from an environment variable.
 *
 *   bun run examples/discovery/seeds/config-seeds.ts
 */
import { ConfigSeedProvider, ConfigSeedProviderOptions, seedsFromEnv } from '../../../src/index.js';

async function main(): Promise<void> {
  // From code.
  const seedOptions = ConfigSeedProviderOptions.create()
    .withSeeds(['seed1.cluster.local:2552', 'seed2.cluster.local:2552'])
    .withSystemName('my-app');
  const nodeA = new ConfigSeedProvider(seedOptions);
  console.log('from code:', (await nodeA.lookup()).map(x => x.toString()));

  // From ENV.
  process.env.CLUSTER_SEEDS = 'seed1.cluster.local:2552,seed2.cluster.local:2552';
  const nodeB = seedsFromEnv('CLUSTER_SEEDS', 'my-app');
  console.log('from env:', (await nodeB.lookup()).map(x => x.toString()));
}

void main();
