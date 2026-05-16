/**
 * KubernetesApiSeedProvider.lookup() against a real K8s endpoint
 * object — verify the IP-extraction + NodeAddress shaping over a
 * real K8s API response.
 */
import { KubernetesApiSeedProvider } from '../../../../../src/discovery/KubernetesApiSeedProvider.js';
import type { K8sCtx } from '../runner.js';
import type { BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<K8sCtx> = {
  name: 'lookup() returns NodeAddresses for Endpoints subsets',
  async run(ctx) {
    const ns = `b9-basic-${Date.now()}`;
    const svc = 'actor-ts-cluster';

    // 1. Create the namespace.
    let res = await ctx.api('POST', '/api/v1/namespaces', {
      apiVersion: 'v1', kind: 'Namespace',
      metadata: { name: ns },
    });
    if (res.status !== 201 && res.status !== 409) {
      throw new Error(`create ns failed: ${res.status} ${res.body.slice(0, 200)}`);
    }

    try {
      // 2. Create the Service.  Headless (clusterIP: None) so we don't
      //    leak a virtual IP into the test setup.
      res = await ctx.api('POST', `/api/v1/namespaces/${ns}/services`, {
        apiVersion: 'v1', kind: 'Service',
        metadata: { name: svc },
        spec: { clusterIP: 'None', ports: [{ port: 9000 }], selector: {} },
      });
      if (res.status !== 201) throw new Error(`create svc: ${res.status} ${res.body.slice(0, 200)}`);

      // 3. Create the Endpoints object directly — no real pods backing it,
      //    we hand-craft the subsets so the test is deterministic.
      res = await ctx.api('POST', `/api/v1/namespaces/${ns}/endpoints`, {
        apiVersion: 'v1', kind: 'Endpoints',
        metadata: { name: svc },
        subsets: [
          {
            addresses: [
              { ip: '10.0.0.1' },
              { ip: '10.0.0.2' },
              { ip: '10.0.0.3' },
            ],
            ports: [{ port: 9000 }],
          },
        ],
      });
      if (res.status !== 201) throw new Error(`create endpoints: ${res.status} ${res.body.slice(0, 200)}`);

      // 4. Build a SeedProvider pointed at this fixture.
      const buildSeedProvider = (ctx as unknown as {
        buildSeedProvider: (ns: string, svc: string) => KubernetesApiSeedProvider;
      }).buildSeedProvider;
      const provider = buildSeedProvider(ns, svc);

      // 5. Exercise lookup() — assert IPs come back as NodeAddresses.
      const addrs = await provider.lookup();
      if (addrs.length !== 3) {
        throw new Error(`expected 3 NodeAddresses, got ${addrs.length}`);
      }
      const ips = addrs.map((a) => a.host).sort();
      if (ips.join(',') !== '10.0.0.1,10.0.0.2,10.0.0.3') {
        throw new Error(`unexpected IPs: ${ips.join(',')}`);
      }
      // System name + port are pulled from the provider settings.
      for (const a of addrs) {
        if (a.systemName !== 'k8s-integration') {
          throw new Error(`systemName mismatch: ${a.systemName}`);
        }
        if (a.port !== 9000) {
          throw new Error(`port mismatch: ${a.port}`);
        }
      }
    } finally {
      // Cleanup — delete the namespace cascades to its objects.
      await ctx.api('DELETE', `/api/v1/namespaces/${ns}`);
    }
  },
};
