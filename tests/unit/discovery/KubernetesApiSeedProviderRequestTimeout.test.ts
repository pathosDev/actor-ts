import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import { AggregateSeedProvider } from '../../../src/discovery/AggregateSeedProvider.js';
import { ConfigSeedProvider } from '../../../src/discovery/ConfigSeedProvider.js';
import { ConfigSeedProviderOptions } from '../../../src/discovery/ConfigSeedProviderOptions.js';
import {
  endpointsPath,
  KubernetesApiSeedProvider,
  requestEndpoints,
} from '../../../src/discovery/KubernetesApiSeedProvider.js';
import { KubernetesApiSeedProviderOptions } from '../../../src/discovery/KubernetesApiSeedProviderOptions.js';

/**
 * #1524 — the seed provider's API request has a ceiling.
 *
 * The failure it guards against is an API server that accepts the TCP
 * connection and then never answers: a control-plane restart, a
 * `NetworkPolicy` dropping the reply, a stalled admission webhook.  Before the
 * fix that produced neither `'error'` nor `'end'`, so `lookup()` never
 * settled — and both layers above it, `AggregateSeedProvider` and
 * `StableObservation`, are written to survive a provider that *throws*, not
 * one that hangs.  The ladder therefore never reached the rung that exists
 * for exactly this case.
 *
 * A bare `net` server that accepts and writes nothing is that API server: the
 * HTTPS client sends its ClientHello and waits, and nothing about the stall
 * depends on a certificate that never gets exchanged.  The ceiling is a
 * wall-clock deadline on the whole exchange, not the request's *socket*
 * timeout — Bun never arms that one while the handshake is pending, which is
 * why the stalled handshake and a stalled body are bounded alike only through
 * the abort signal (measured in `requestEndpoints`' JSDoc; the lease client
 * had the same hole, #1529).
 */

/** Well under the default, so the timer is what settles the request and not anything else. */
const CEILING_MS = 300;
/** Slack for the timer firing late on a loaded machine; a hang is unbounded, so any finite slack discriminates. */
const SLACK_MS = 1_500;

/**
 * The cap lives in the fixture because the runner's cannot be trusted here:
 * with the bound removed, a pending `node:https` handshake keeps bun's
 * per-test timeout from ever firing, and `bun test` prints its header and
 * hangs (measured: killed at 45 s, no failure reported).  This turns that
 * regression into a red test with a message that says what happened.
 */
async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HUNG: the request was still pending after ${ms}ms — the bound never fired`)), ms);
  });
  try { return await Promise.race([promise, hung]); } finally { clearTimeout(timer); }
}

/** Accepts connections and holds every socket open without writing a byte. */
async function serverThatNeverAnswers(): Promise<{ port: number; server: Server; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  return { port: address.port, server, sockets };
}

describe('KubernetesApiSeedProvider — a request that is never answered (#1524)', () => {
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

  test('requestEndpoints rejects within its ceiling instead of pending', async () => {
    const port = await stalledApiServer();
    const started = performance.now();

    const outcome = requestEndpoints({
      host: '127.0.0.1',
      port,
      path: endpointsPath('default', 'my-svc'),
      token: 'irrelevant',
      timeoutMs: CEILING_MS,
    });

    await expect(settlesWithin(outcome, CEILING_MS + SLACK_MS)).rejects.toThrow(/no answer from 127\.0\.0\.1:\d+ within 300ms/);
    // Rejected because the ceiling fired, not because something else failed
    // first: not so fast it was a refusal.  Only the lower bound — the
    // fixture cap above already holds the upper one (#1338).
    expect(performance.now() - started).toBeGreaterThanOrEqual(CEILING_MS * 0.5);
  }, CEILING_MS + SLACK_MS + 2_000);

  test('the discovery ladder falls through to its next rung', async () => {
    // The precise property the issue names: a stalled Kubernetes rung used to
    // stop the ladder, so the static fallback that exists for this case was
    // unreachable.  With the ceiling the rung rejects, the aggregate logs the
    // fall-through and the next provider answers.
    const port = await stalledApiServer();
    const kubernetesOptions = KubernetesApiSeedProviderOptions.create()
      .withNamespace('default')
      .withServiceName('my-svc')
      .withSystemName('sys')
      .withPort(2552)
      .withFetchEndpoints(() => requestEndpoints({
        host: '127.0.0.1',
        port,
        path: endpointsPath('default', 'my-svc'),
        token: 'irrelevant',
        timeoutMs: CEILING_MS,
      }));
    const fallbackOptions = ConfigSeedProviderOptions.create()
      .withSystemName('sys')
      .withSeeds(['10.0.0.9:2552']);
    const logged: string[] = [];
    const ladder = new AggregateSeedProvider(
      [new KubernetesApiSeedProvider(kubernetesOptions), new ConfigSeedProvider(fallbackOptions)],
      (message) => { logged.push(message); },
    );

    const seeds = await settlesWithin(ladder.lookup(), CEILING_MS + SLACK_MS);

    expect(seeds.map((seed) => seed.toString())).toEqual(['sys@10.0.0.9:2552']);
    expect(logged.some((line) => line.includes('falling through to next'))).toBe(true);
  }, CEILING_MS + SLACK_MS + 2_000);

  test('the ceiling is validated as a positive number', () => {
    const options = KubernetesApiSeedProviderOptions.create()
      .withNamespace('default')
      .withServiceName('my-svc')
      .withSystemName('sys')
      .withPort(2552)
      .withRequestTimeoutMs(0);
    expect(() => new KubernetesApiSeedProvider(options)).toThrow(/requestTimeoutMs/);
  });
});
