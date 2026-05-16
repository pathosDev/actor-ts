/**
 * Empty Endpoints subset — lookup() returns [].  The seed provider
 * shouldn't crash on a service with no ready pods.
 */
import { KubernetesApiSeedProvider } from '../../../../../src/discovery/KubernetesApiSeedProvider.js';
import type { K8sCtx } from '../runner.js';
import type { BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<K8sCtx> = {
  name: 'lookup() handles empty Endpoints gracefully',
  async run(ctx) {
    const ns = `b9-empty-${Date.now()}`;
    const svc = 'actor-ts-cluster-empty';

    let res = await ctx.api('POST', '/api/v1/namespaces', {
      apiVersion: 'v1', kind: 'Namespace',
      metadata: { name: ns },
    });
    if (res.status !== 201 && res.status !== 409) {
      throw new Error(`create ns failed: ${res.status} ${res.body.slice(0, 200)}`);
    }

    try {
      res = await ctx.api('POST', `/api/v1/namespaces/${ns}/services`, {
        apiVersion: 'v1', kind: 'Service',
        metadata: { name: svc },
        spec: { clusterIP: 'None', ports: [{ port: 9000 }], selector: {} },
      });
      if (res.status !== 201) throw new Error(`create svc: ${res.status} ${res.body.slice(0, 200)}`);

      // Endpoints with NO subsets — represents "service exists, no pods ready".
      res = await ctx.api('POST', `/api/v1/namespaces/${ns}/endpoints`, {
        apiVersion: 'v1', kind: 'Endpoints',
        metadata: { name: svc },
        // No subsets field — same shape K8s emits for unready services.
      });
      if (res.status !== 201) throw new Error(`create endpoints: ${res.status} ${res.body.slice(0, 200)}`);

      const buildSeedProvider = (ctx as unknown as {
        buildSeedProvider: (ns: string, svc: string) => KubernetesApiSeedProvider;
      }).buildSeedProvider;
      const provider = buildSeedProvider(ns, svc);

      const addrs = await provider.lookup();
      if (addrs.length !== 0) {
        throw new Error(`expected empty list, got ${addrs.length} addresses`);
      }
    } finally {
      await ctx.api('DELETE', `/api/v1/namespaces/${ns}`);
    }
  },
};
