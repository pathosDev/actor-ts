/**
 * Empty Endpoints subset — lookup() returns [].  The seed provider
 * shouldn't crash on a service with no ready pods.
 */
import { KubernetesApiSeedProvider } from '../../../../../src/discovery/KubernetesApiSeedProvider.js';
import type { K8sContext } from '../runner.js';
import type { BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<K8sContext> = {
  name: 'lookup() handles empty Endpoints gracefully',
  async run(context) {
    const ns = `b9-empty-${Date.now()}`;
    const svc = 'actor-ts-cluster-empty';

    let response = await context.api('POST', '/api/v1/namespaces', {
      apiVersion: 'v1', kind: 'Namespace',
      metadata: { name: ns },
    });
    if (response.status !== 201 && response.status !== 409) {
      throw new Error(`create ns failed: ${response.status} ${response.body.slice(0, 200)}`);
    }

    try {
      response = await context.api('POST', `/api/v1/namespaces/${ns}/services`, {
        apiVersion: 'v1', kind: 'Service',
        metadata: { name: svc },
        spec: { clusterIP: 'None', ports: [{ port: 9000 }], selector: {} },
      });
      if (response.status !== 201) throw new Error(`create svc: ${response.status} ${response.body.slice(0, 200)}`);

      // Endpoints with NO subsets — represents "service exists, no pods ready".
      response = await context.api('POST', `/api/v1/namespaces/${ns}/endpoints`, {
        apiVersion: 'v1', kind: 'Endpoints',
        metadata: { name: svc },
        // No subsets field — same shape K8s emits for unready services.
      });
      if (response.status !== 201) throw new Error(`create endpoints: ${response.status} ${response.body.slice(0, 200)}`);

      const buildSeedProvider = (context as unknown as {
        buildSeedProvider: (ns: string, svc: string) => KubernetesApiSeedProvider;
      }).buildSeedProvider;
      const provider = buildSeedProvider(ns, svc);

      const addrs = await provider.lookup();
      if (addrs.length !== 0) {
        throw new Error(`expected empty list, got ${addrs.length} addresses`);
      }
    } finally {
      await context.api('DELETE', `/api/v1/namespaces/${ns}`);
    }
  },
};
