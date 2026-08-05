/**
 * The cluster `hello` handshake carries no credential, so on a TLS cluster
 * mTLS *is* the admission control — and it was never actually switched on.
 * Both listener adapters hard-defaulted `requestCert` to `false`, and nothing
 * in `src/`, `examples/` or `docs/` ever set `requestClientCert: true`.  Since
 * `rejectUnauthorized` has no effect on a server unless `requestCert` is on,
 * the documented `{cert, key, ca, rejectUnauthorized: true}` recipe produced
 * server-authenticated TLS only: anyone could complete the handshake with no
 * certificate at all and then claim any identity they liked in their `hello`
 * (#565).
 *
 * These tests pin the derived default and the fail-closed guards, and — for
 * Bun, whose listener is reachable through a stubbed global — assert the
 * option object the runtime actually receives, rather than only the helper
 * that computes it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  assertListenerTlsIsCoherent,
  listenerTlsOptions,
  requiresClientCertificate,
} from '../../../../src/runtime/tcp/TcpBackend.js';
import { DenoTcpBackend } from '../../../../src/runtime/tcp/DenoTcpBackend.js';

const CERT = '-----BEGIN CERTIFICATE-----\nnot-a-real-cert\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----';
const CA = '-----BEGIN CERTIFICATE-----\nnot-a-real-ca\n-----END CERTIFICATE-----';

const noopHandlers = {
  onOpen: () => {}, onData: () => {}, onClose: () => {}, onError: () => {},
};

describe('TLS listener client-certificate policy (#565)', () => {
  test('a listener given a CA demands a peer certificate', () => {
    // This is the documented cluster-security recipe.  Pre-fix it resolved to
    // `requestCert: false`, i.e. no peer authentication whatsoever.
    expect(requiresClientCertificate({ cert: CERT, key: KEY, ca: CA })).toBe(true);
    expect(requiresClientCertificate({ cert: CERT, key: KEY, ca: CA, rejectUnauthorized: true }))
      .toBe(true);
  });

  test('one-way TLS stays available, but only when asked for explicitly', () => {
    // No trust bundle: there is nothing to verify against, so demanding a cert
    // would reject every peer.
    expect(requiresClientCertificate({ cert: CERT, key: KEY })).toBe(false);
    // An explicit opt-out still wins over the derived default.
    expect(requiresClientCertificate({ cert: CERT, key: KEY, ca: CA, requestClientCert: false }))
      .toBe(false);
  });

  test('requestClientCert without a CA is rejected at bind time', () => {
    // Fail closed: the combination reads as mutual authentication but has no
    // trust anchor, and a listener that is quietly less secure than its config
    // suggests behaves exactly like a correct one until it is attacked.
    expect(() => assertListenerTlsIsCoherent(
      { cert: CERT, key: KEY, requestClientCert: true }, 'Node.js',
    )).toThrow(/no `ca` was supplied/);
  });

  test('the coherent configurations do not throw', () => {
    expect(() => assertListenerTlsIsCoherent({ cert: CERT, key: KEY, ca: CA }, 'Node.js'))
      .not.toThrow();
    expect(() => assertListenerTlsIsCoherent({ cert: CERT, key: KEY }, 'Bun'))
      .not.toThrow();
  });
});

describe('the option object handed to the listener', () => {
  // `listenerTlsOptions` is what both the Node and the Bun adapter pass
  // straight into `tls.createServer` / `Bun.listen`, so asserting on it is
  // asserting on what the runtime receives.  It exists as one function
  // precisely because #565 survived by being written out twice: two copies of
  // the same wrong default look like a convention, not a bug.
  test('the documented mTLS recipe produces requestCert: true', () => {
    expect(listenerTlsOptions({ cert: CERT, key: KEY, ca: CA, rejectUnauthorized: true }, 'Node.js'))
      .toEqual({
        cert: CERT, key: KEY, ca: CA, requestCert: true, rejectUnauthorized: true,
      });
  });

  test('Node and Bun cannot drift apart on the policy', () => {
    const tls = { cert: CERT, key: KEY, ca: CA };
    expect(listenerTlsOptions(tls, 'Node.js')).toEqual(listenerTlsOptions(tls, 'Bun'));
  });

  test('an incoherent listener throws before any option object exists', () => {
    expect(() => listenerTlsOptions({ cert: CERT, key: KEY, requestClientCert: true }, 'Bun'))
      .toThrow(/no `ca` was supplied/);
  });
});

describe('DenoTcpBackend — mTLS is refused rather than silently skipped', () => {
  const realDeno = (globalThis as { Deno?: unknown }).Deno;
  const setDeno = (value: unknown): void => {
    Object.defineProperty(globalThis, 'Deno', { value, configurable: true, writable: true });
  };
  afterEach(() => { setDeno(realDeno); });

  test('a CA-configured listener fails closed on Deno', async () => {
    // `Deno.ListenTlsOptions` takes only a cert and a key — there is no way to
    // request or verify a client certificate, so a listener bound here would
    // authenticate nobody.  Binding anyway would hand the operator the exact
    // false assurance #565 is about, so the bind is refused instead.
    let bound = false;
    setDeno({
      listenTls: () => { bound = true; throw new Error('unreachable'); },
      listen: () => { bound = true; throw new Error('unreachable'); },
    });
    await expect(new DenoTcpBackend().listen({
      host: '127.0.0.1', port: 0,
      tls: { cert: CERT, key: KEY, ca: CA },
      handlers: noopHandlers,
    })).rejects.toThrow(/cannot HOST an mTLS listener on Deno/);
    expect(bound).toBe(false);
  });
});

describe('DenoTcpBackend — the dialling half of mTLS (#576)', () => {
  const realDeno = (globalThis as { Deno?: unknown }).Deno;
  const setDeno = (value: unknown): void => {
    Object.defineProperty(globalThis, 'Deno', { value, configurable: true, writable: true });
  };
  afterEach(() => { setDeno(realDeno); });

  /** Capture what the adapter hands `Deno.connectTls`, then abort the dial. */
  async function captureConnectTlsOptions(
    tls: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let seen: Record<string, unknown> = {};
    setDeno({
      connectTls: (options: Record<string, unknown>) => {
        seen = options;
        throw new Error('stop here — the options are what this test is about');
      },
    });
    await new DenoTcpBackend().connect({
      host: '10.0.0.1', port: 2552, tls: tls as never, handlers: noopHandlers,
    }).catch(() => { /* expected */ });
    return seen;
  }

  test('the client certificate is presented', async () => {
    // Deno supports this — `connectTls` accepts `key` + `cert` — but the
    // adapter never passed them.  So a Deno node could not answer a listener
    // that (correctly, since #565) demands a certificate, which meant it could
    // not join an mTLS cluster at all.
    const seen = await captureConnectTlsOptions({ cert: CERT, key: KEY, ca: CA });
    expect(seen['cert']).toBe(CERT);
    expect(seen['key']).toBe(KEY);
    expect(seen['caCerts']).toEqual([CA]);
  });

  test('a key without its certificate is not sent as a credential', async () => {
    const seen = await captureConnectTlsOptions({ key: KEY, ca: CA });
    expect(seen['key']).toBeUndefined();
    expect(seen['cert']).toBeUndefined();
  });

  test('serverName overrides the SNI hostname instead of vanishing', async () => {
    // It used to be passed as `hostname_`, which is not a Deno option — and
    // the adapter's hand-written interface declared the typo, so the compiler
    // could not see it and the value was silently dropped.
    const seen = await captureConnectTlsOptions({ ca: CA, serverName: 'cluster.internal' });
    expect(seen['hostname']).toBe('cluster.internal');
    expect(seen).not.toHaveProperty('hostname_');
    expect(seen).not.toHaveProperty('serverName');
  });

  test('without an override the dial target is the SNI name', async () => {
    const seen = await captureConnectTlsOptions({ ca: CA });
    expect(seen['hostname']).toBe('10.0.0.1');
    expect(seen['port']).toBe(2552);
  });
});
