/**
 * Realistic seed discovery: Kubernetes first, DNS fallback, ENV as last
 * resort.  Typical pattern for pods that run both in-cluster (where the
 * K8s API answers) and during local dev (where only ENV is available).
 *
 *   bun run examples/discovery/seeds/aggregate-bootstrap.ts
 */
import {
  AggregateSeedProvider,
  ConfigSeedProvider,
  ConfigSeedProviderOptions,
  DnsSeedProvider,
  DnsSeedProviderOptions,
  KubernetesApiSeedProvider,
  KubernetesApiSeedProviderOptions,
} from '../../../src/index.js';

async function main(): Promise<void> {
  // Simulate a K8s provider that would return pod IPs in production; here we
  // fake `fetchEndpoints` to show the shape.
  const k8sOptions = KubernetesApiSeedProviderOptions.create()
    .withNamespace('default').withServiceName('cluster-app')
    .withSystemName('my-app').withPort(2552)
    .withFetchEndpoints(async () => {
      // In real life this hits the API.  For the demo we pretend nothing
      // is running yet — empty list forces fallback.
      return [];
    });
  const k8s = new KubernetesApiSeedProvider(k8sOptions);

  // DNS provider with an injected resolve — pretend 2 pods are visible.
  const dnsOptions = DnsSeedProviderOptions.create()
    .withHostname('cluster-app.default.svc.cluster.local')
    .withSystemName('my-app')
    .withPort(2552)
    .withResolve(async () => ['10.244.0.1', '10.244.0.2']);
  const dns = new DnsSeedProvider(dnsOptions);

  // Static ENV list used only if everything else fails.
  process.env.LOCAL_SEEDS = 'localhost:2552';
  const envSeedOptions = ConfigSeedProviderOptions.create()
    .withSeeds((process.env.LOCAL_SEEDS ?? '').split(','))
    .withSystemName('my-app');
  const env = new ConfigSeedProvider(envSeedOptions);

  const chain = new AggregateSeedProvider([k8s, dns, env], (m, e) => {
    console.warn(`[seeds] ${m}`, e);
  });

  const seeds = await chain.lookup();
  console.log('chosen seeds:', seeds.map(s => s.toString()));
}

void main();
