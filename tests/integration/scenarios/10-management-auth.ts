/**
 * Scenario 10 — Management HTTP auth end-to-end (#312).
 *
 * The auth middleware is unit-tested but the full path
 * (BearerTokenAuth wrapping the cluster subtree, IpAllowlist
 * wrapping everything, /health stays anonymous) is worth proving
 * over real TCP via Fastify on real cluster nodes.  This is
 * non-destructive — we don't actually down anyone; the /cluster/down
 * test targets a fictional address so it round-trips through the
 * auth + handler layers and surfaces 404.
 *
 * Verified:
 *
 *   1. GET /cluster/members without Authorization → 401.
 *   2. GET /cluster/members with wrong token → 401.
 *   3. GET /cluster/members with correct token → 200 + member list.
 *   4. POST /cluster/down without Authorization → 401.
 *   5. POST /cluster/down with correct token + fictional address →
 *      404 (auth gate cleared, handler reports "no such member").
 *   6. GET /health without Authorization → 200 (probe contract).
 *
 * The IpAllowlist on every endpoint is implicitly tested too:
 * every request below comes from the controller container on the
 * docker bridge network (172.x), which is covered by the
 * `172.16.0.0/12` allowlist entry in node-runner.  A request from
 * outside the allowlist would 403 before reaching the auth layer.
 */

import { clusterLiveNodes, type Scenario } from './types.js';

const TOKEN = 'integration-test-token';  // Mirrors MGMT_TOKEN in compose env.
const MGMT_PORT_DEFAULT = 8080;


export const scenario: Scenario = {
  name: '10-management-auth',
  async run(ctx) {
    const live = await clusterLiveNodes(ctx.nodes, ctx.controlPort);
    if (live.length === 0) {
      console.log('[10] skipping — no live nodes');
      return;
    }
    const target = live[0]!;
    const mgmt = ctx.mgmtPort ?? MGMT_PORT_DEFAULT;
    const base = `http://${target}:${mgmt}`;

    // 1. /cluster/members without auth → 401.
    console.log('[10] GET /cluster/members without auth...');
    {
      const res = await fetch(`${base}/cluster/members`);
      if (res.status !== 401) {
        throw new Error(`[10] expected 401, got ${res.status}: ${await res.text()}`);
      }
      // Check WWW-Authenticate: Bearer realm=... was advertised.
      const wwwAuth = res.headers.get('www-authenticate');
      if (wwwAuth && !wwwAuth.startsWith('Bearer')) {
        console.warn(`[10] note: WWW-Authenticate present but unexpected: ${wwwAuth}`);
      }
    }

    // 2. /cluster/members with wrong token → 401.
    console.log('[10] GET /cluster/members with wrong token...');
    {
      const res = await fetch(`${base}/cluster/members`, {
        headers: { authorization: 'Bearer wrong-token-12345' },
      });
      if (res.status !== 401) {
        throw new Error(`[10] expected 401 for wrong token, got ${res.status}: ${await res.text()}`);
      }
    }

    // 3. /cluster/members with correct token → 200 + members.
    console.log('[10] GET /cluster/members with correct token...');
    {
      const res = await fetch(`${base}/cluster/members`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (res.status !== 200) {
        throw new Error(`[10] expected 200 for valid token, got ${res.status}: ${await res.text()}`);
      }
      const body = await res.json() as { members: ReadonlyArray<{ address: string }> };
      if (!Array.isArray(body.members) || body.members.length === 0) {
        throw new Error(`[10] /cluster/members returned empty: ${JSON.stringify(body)}`);
      }
      console.log(`[10]   /cluster/members returned ${body.members.length} members`);
    }

    // 4. /cluster/down without auth → 401.
    console.log('[10] POST /cluster/down without auth...');
    {
      const res = await fetch(`${base}/cluster/down`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'integration@phantom-host:9000' }),
      });
      if (res.status !== 401) {
        throw new Error(`[10] expected 401 (no auth), got ${res.status}: ${await res.text()}`);
      }
    }

    // 5. /cluster/down with auth + fictional address → 404.
    //    Cluster intact afterwards.
    console.log('[10] POST /cluster/down with auth + fictional address (expect 404)...');
    {
      const res = await fetch(`${base}/cluster/down`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ address: 'integration@phantom-host:9000' }),
      });
      if (res.status !== 404) {
        throw new Error(`[10] expected 404 for fictional address, got ${res.status}: ${await res.text()}`);
      }
    }

    // 6. /health without auth → 200.  Standard probe contract.
    console.log('[10] GET /health without auth (probe contract)...');
    {
      const res = await fetch(`${base}/health`);
      if (res.status !== 200) {
        throw new Error(`[10] /health expected anonymous 200, got ${res.status}: ${await res.text()}`);
      }
      const body = await res.json() as { status: string };
      if (body.status !== 'UP') {
        throw new Error(`[10] /health returned non-UP status: ${JSON.stringify(body)}`);
      }
    }

    console.log('[10] all 6 auth-path assertions passed; cluster intact');
  },
};
