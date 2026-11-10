import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import {
  k8sRequest,
  type K8sFetchClient,
  type K8sLeaseObject,
} from '../../../src/coordination/leases/K8sApi.js';
import { KubernetesLease } from '../../../src/coordination/leases/KubernetesLease.js';
import { KubernetesLeaseOptions } from '../../../src/coordination/leases/KubernetesLeaseOptions.js';
import { assertCompletesWithin } from '../../util/AsyncAssertions.js';

/**
 * #1529 — the lease client's `operation-timeout` holds through a stalled TLS
 * handshake.
 *
 * `K8sApi`'s default client bounded each request with `https.request`'s
 * `timeout` option, a *socket* timeout that Bun 1.4.2 never arms while the
 * handshake is pending — so against an API server that accepts the connection
 * and writes nothing, the one outage the bound exists for, the request never
 * settled.  That matters more here than in the seed provider (#1524): the
 * renewal loop's in-flight guard drops a tick that overlaps a request still
 * on the wire, on the assumption that the request has a ceiling.  Without
 * one a holder whose API server stalls mid-handshake keeps its renewal wedged
 * on a single PUT instead of timing out, firing `onLost` and letting a replica
 * take over.
 *
 * `tests/unit/coordination/KubernetesLease.test.ts` drives the lease through a
 * fake `K8sFetchClient`, so the real socket never appears there.  Here the
 * default `node:https` client is aimed at a bare `net` server that accepts
 * and holds every socket open — which is what a control-plane restart, a
 * `NetworkPolicy` dropping the reply or a wedged admission webhook look like
 * from the client, and nothing about the stall depends on a certificate that
 * is never exchanged.  The CA is the test fixture's, so a refusal would come
 * from the handshake and not from an unparsable `ca` option.
 *
 * The cap on each case lives in the fixture, not in the runner: with the
 * bound removed, a pending `node:https` handshake keeps bun's per-test
 * timeout from ever firing, and `bun test` prints its header and hangs
 * (measured on #1524: killed at 45 s, no failure reported).
 * `assertCompletesWithin` turns that into a red test whose message says what
 * happened.
 */

/** Well under the default, so the deadline is what settles the request and not anything else. */
const CEILING_MS = 300;
/** Slack for a timer firing late on a loaded machine; a hang is unbounded, so any finite slack discriminates. */
const SLACK_MS = 1_500;
/** Renewal cadence for the lease case — the first PUT goes out this soon after acquire. */
const RENEWAL_MS = 100;

const CA = readFileSync(new URL('../../fixtures/tls/test-ca.pem', import.meta.url), 'utf8');

/** Accepts connections and holds every socket open without writing a byte. */
async function serverThatNeverAnswers(): Promise<{ port: number; server: Server; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  return { port: address.port, server, sockets };
}

describe('K8sApi — a request the API server never answers (#1529)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  async function stalledApiServer(): Promise<number> {
    const { port, server, sockets } = await serverThatNeverAnswers();
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return port;
  }

  test('the default client rejects within operation-timeout instead of pending', async () => {
    const port = await stalledApiServer();
    const started = performance.now();

    const outcome = k8sRequest(
      { apiServerUrl: `https://127.0.0.1:${port}`, authToken: 'irrelevant', caCert: CA },
      { method: 'GET', path: '/apis/coordination.k8s.io/v1/namespaces/default/leases/x', timeoutMs: CEILING_MS },
    );

    await expect(assertCompletesWithin(
      outcome, CEILING_MS + SLACK_MS, 'HUNG: the request was still pending — the bound never fired',
    )).rejects.toThrow(/k8s request timeout: no answer from 127\.0\.0\.1:\d+ within 300ms/);
    // Rejected because the deadline fired and not because something failed
    // first: a refusal or a bad option would come back at once.  Only the
    // lower bound — the fixture cap above already holds the upper one.
    expect(performance.now() - started).toBeGreaterThanOrEqual(CEILING_MS * 0.5);
  }, CEILING_MS + SLACK_MS + 2_000);

  test('a holder whose API server stalls mid-handshake loses the lease rather than wedging', async () => {
    // The property the issue names, on the real socket.  Acquire goes through
    // a stand-in that answers — no lease yet, then created — so the holder
    // has a lease and a renewal loop; the renewal PUT alone is handed to the
    // real `node:https` client, aimed at the server that never answers.
    const port = await stalledApiServer();
    const acquireAnswered: K8sFetchClient = {
      request: async (credentials, options) => {
        if (options.method === 'PUT') {
          return k8sRequest(credentials, {
            method: options.method, path: options.path, body: options.body, timeoutMs: options.timeoutMs,
          });
        }
        if (options.method === 'GET') return { status: 404, body: null };
        if (options.method === 'POST') {
          const created = options.body as K8sLeaseObject;
          return { status: 201, body: { ...created, metadata: { ...created.metadata, resourceVersion: '1' } } };
        }
        return { status: 200, body: null };
      },
    };
    const options = KubernetesLeaseOptions.create()
      .withName('stalled-api-server')
      .withOwner('pod-a')
      .withNamespace('default')
      .withTtlMs(15_000)
      .withRenewalIntervalMs(RENEWAL_MS)
      .withOperationTimeoutMs(CEILING_MS)
      .withApiServerUrl(`https://127.0.0.1:${port}`)
      .withAuthToken('irrelevant')
      .withCaCert(CA)
      .withClient(acquireAnswered);
    const lease = new KubernetesLease(options);
    cleanups.push(async () => { await lease.release(); });
    const lost = new Promise<string>((resolve) => { lease.onLost(resolve); });

    expect(await lease.acquire()).toBe(true);
    expect(lease.checkAlive()).toBe(true);

    const reason = await assertCompletesWithin(
      lost, RENEWAL_MS + CEILING_MS + SLACK_MS, 'HUNG: the renewal never settled, so onLost never fired',
    );
    expect(reason).toMatch(/^renewal error: k8s request timeout: no answer from 127\.0\.0\.1:\d+ within 300ms$/);
    expect(lease.checkAlive()).toBe(false);
  }, RENEWAL_MS + CEILING_MS + SLACK_MS + 2_000);
});
