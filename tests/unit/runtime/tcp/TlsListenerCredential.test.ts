/**
 * A listener may not silently downgrade itself to plaintext (#144).
 *
 * All three adapters used to decide "bind TLS?" by testing `cert && key`.  A
 * configuration carrying only one of the two — what a half-applied secret
 * rotation, a typo'd env var or an empty mounted file produces — therefore
 * answered "no", and the listener bound in **plaintext**.  Nothing surfaced it:
 * the dialing half of the same options object treats any `tls` value as TLS, so
 * the operator saw a node with TLS configured and a cluster that formed.
 *
 * The rule lives in `assertListenerTlsIsCoherent`, and every adapter reaches it
 * through `listenerUsesTls` — the check is welded to the decision precisely
 * because a separate check is what got skipped.  So the tests below assert at
 * both levels: the helper's verdict, and that each adapter really refuses to
 * bind.  The adapter half is the one that matters — a helper nobody calls on
 * the plaintext path is exactly the shape of the original defect.
 *
 * The rule is deliberately **listener-only**.  `{ ca }` with no client
 * certificate is the ordinary one-way-TLS dial and `ClusterClient` depends on
 * it.  What the dial path does refuse, since #1085, is the one shape that is
 * valid nowhere: half a client credential.  Every adapter used to drop the
 * half and dial one-way TLS under a configuration that read as mTLS.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  assertListenerTlsIsCoherent,
  listenerUsesTls,
} from '../../../../src/runtime/tcp/TcpBackend.js';
import { BunTcpBackend } from '../../../../src/runtime/tcp/BunTcpBackend.js';
import { DenoTcpBackend } from '../../../../src/runtime/tcp/DenoTcpBackend.js';
import { NodeTcpBackend } from '../../../../src/runtime/tcp/NodeTcpBackend.js';
import type { TcpListener, TlsTransportOptionsType } from '../../../../src/runtime/tcp/TcpBackend.js';

const CERT = '-----BEGIN CERTIFICATE-----\nnot-a-real-cert\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----';
const CA = '-----BEGIN CERTIFICATE-----\nnot-a-real-ca\n-----END CERTIFICATE-----';

const noopHandlers = {
  onOpen: () => {}, onData: () => {}, onClose: () => {}, onError: () => {},
};

describe('a half-configured listener credential is refused', () => {
  test('a certificate without its key throws, naming the missing half', () => {
    expect(() => assertListenerTlsIsCoherent({ cert: CERT }, 'Node.js'))
      .toThrow(/`cert` is set on this listener but `key` is not/);
  });

  test('a key without its certificate throws, naming the missing half', () => {
    expect(() => assertListenerTlsIsCoherent({ key: KEY }, 'Bun'))
      .toThrow(/`key` is set on this listener but `cert` is not/);
  });

  test('the message says what would otherwise have happened', () => {
    // The value of failing closed is that the operator learns *why*: a startup
    // failure that only says "bad TLS options" leaves the far more alarming
    // fact — the listener was about to serve plaintext — undiscovered.
    expect(() => assertListenerTlsIsCoherent({ cert: CERT }, 'Node.js'))
      .toThrow(/bind in PLAINTEXT/);
  });

  test('the message rules out the file-path reading of these fields', () => {
    // The fields have never accepted a path — not here and not in Node, Bun or
    // Deno underneath — so an operator debugging a rejected listener should not
    // spend the next hour testing whether one was expected.
    expect(() => assertListenerTlsIsCoherent({ key: KEY }, 'Deno'))
      .toThrow(/not a path to a file/);
  });

  test('empty material counts as absent, not as configured', () => {
    // What an unset environment variable or a mis-mounted secret looks like by
    // the time it reaches this layer.  Treating it as "set" would defer the
    // failure to the TLS stack, which reports a PEM parse error and never
    // mentions which field was empty.
    expect(() => assertListenerTlsIsCoherent({ cert: '', key: KEY }, 'Node.js'))
      .toThrow(/`key` is set on this listener but `cert` is not/);
    expect(() => assertListenerTlsIsCoherent({ cert: CERT, key: new Uint8Array(0) }, 'Node.js'))
      .toThrow(/`cert` is set on this listener but `key` is not/);
  });

  test('a listener with no server credential at all is refused', () => {
    // `{ ca }` is a *dialer* configuration: it says which peers to trust, not
    // what to present.  On a listener there is nothing to hand the client, so
    // the bind would fall through to plaintext exactly as the half-configured
    // case did.
    expect(() => assertListenerTlsIsCoherent({ ca: CA }, 'Node.js'))
      .toThrow(/carries no `cert` and no `key`/);
    expect(() => assertListenerTlsIsCoherent({}, 'Bun'))
      .toThrow(/carries no `cert` and no `key`/);
  });

  test('a complete credential still binds', () => {
    expect(() => assertListenerTlsIsCoherent({ cert: CERT, key: KEY }, 'Node.js')).not.toThrow();
    expect(() => assertListenerTlsIsCoherent({ cert: CERT, key: KEY, ca: CA }, 'Bun')).not.toThrow();
  });
});

describe('listenerUsesTls — the decision and the check are one call', () => {
  test('no TLS configured is the only way to reach a plaintext bind', () => {
    expect(listenerUsesTls(undefined, 'Node.js')).toBe(false);
  });

  test('any TLS configured either binds TLS or throws — never plaintext', () => {
    expect(listenerUsesTls({ cert: CERT, key: KEY }, 'Node.js')).toBe(true);
    for (const tls of [{ cert: CERT }, { key: KEY }, { ca: CA }, {}] as TlsTransportOptionsType[]) {
      expect(() => listenerUsesTls(tls, 'Node.js')).toThrow();
    }
  });

  test('the runtime-specific rules still apply through it', () => {
    // Deno cannot host mTLS at all; the credential rule must not have shadowed
    // that check by running first and passing.
    expect(() => listenerUsesTls({ cert: CERT, key: KEY, ca: CA }, 'Deno'))
      .toThrow(/cannot HOST an mTLS listener on Deno/);
  });
});

describe('the adapters refuse to bind rather than downgrading', () => {
  /**
   * Bind and fail if it succeeded.  Port 0 means the OS picks one, so a
   * regression here really does open a plaintext listener — which is the point:
   * asserting on the helper alone would not have caught the original defect,
   * because the helper was never called on this path.
   */
  async function expectNoPlaintextBind(
    listen: () => Promise<TcpListener>,
    pattern: RegExp,
  ): Promise<void> {
    let listener: TcpListener | undefined;
    try {
      listener = await listen();
    } catch (err) {
      expect((err as Error).message).toMatch(pattern);
      return;
    }
    await listener.close();
    throw new Error('the listener bound anyway — a half-configured TLS listener served plaintext');
  }

  test('BunTcpBackend', async () => {
    await expectNoPlaintextBind(
      () => new BunTcpBackend().listen({
        host: '127.0.0.1', port: 0, tls: { cert: CERT }, handlers: noopHandlers,
      }),
      /`cert` is set on this listener but `key` is not/,
    );
  });

  test('NodeTcpBackend', async () => {
    await expectNoPlaintextBind(
      () => new NodeTcpBackend().listen({
        host: '127.0.0.1', port: 0, tls: { key: KEY, ca: CA }, handlers: noopHandlers,
      }),
      /`key` is set on this listener but `cert` is not/,
    );
  });

  test('DenoTcpBackend', async () => {
    const realDeno = (globalThis as { Deno?: unknown }).Deno;
    let bound = false;
    Object.defineProperty(globalThis, 'Deno', {
      value: {
        listenTls: () => { bound = true; throw new Error('unreachable'); },
        listen: () => { bound = true; throw new Error('unreachable'); },
      },
      configurable: true,
      writable: true,
    });
    try {
      await expect(new DenoTcpBackend().listen({
        host: '127.0.0.1', port: 0, tls: { cert: CERT }, handlers: noopHandlers,
      })).rejects.toThrow(/`cert` is set on this listener but `key` is not/);
      // Neither branch may run: falling back to `Deno.listen` would be the
      // plaintext downgrade itself.
      expect(bound).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'Deno', { value: realDeno, configurable: true, writable: true });
    }
  });

  test('a listener with no `tls` at all is still plain TCP', async () => {
    // The rule must not have turned "no TLS" into an error — every non-TLS
    // cluster takes this path.
    const listener = await new BunTcpBackend().listen({
      host: '127.0.0.1', port: 0, handlers: noopHandlers,
    });
    expect(listener.port).toBeGreaterThan(0);
    await listener.close();
  });
});

describe('the dial path: one-way TLS untouched, half a client credential refused (#1085)', () => {
  const realDeno = (globalThis as { Deno?: unknown }).Deno;
  afterEach(() => {
    Object.defineProperty(globalThis, 'Deno', { value: realDeno, configurable: true, writable: true });
  });

  /** A stand-in `Deno` that records what each dial asked for and dials nothing. */
  function recordingDeno(): Array<Record<string, unknown>> {
    const dials: Array<Record<string, unknown>> = [];
    Object.defineProperty(globalThis, 'Deno', {
      value: {
        connectTls: (options: Record<string, unknown>) => {
          dials.push(options);
          throw new Error('stop here — the options are what this test is about');
        },
      },
      configurable: true,
      writable: true,
    });
    return dials;
  }

  /** `node:tls` and `node:net` stand-ins: a dial is recorded, never made. */
  function recordingNodeBackend(): { backend: NodeTcpBackend; dials: unknown[] } {
    const dials: unknown[] = [];
    const refuse = (options: unknown): never => {
      dials.push(options);
      throw new Error('stop here — the options are what this test is about');
    };
    const modules = {
      net: () => Promise.resolve({ connect: refuse, createServer: refuse, isIP: () => 4 } as never),
      tls: () => Promise.resolve({ connect: refuse, createServer: refuse } as never),
    };
    return { backend: new NodeTcpBackend(modules), dials };
  }

  async function dialError(dial: () => Promise<unknown>): Promise<Error | undefined> {
    try {
      await dial();
      return undefined;
    } catch (error) {
      return error as Error;
    }
  }

  test('`{ ca }` alone is still the ordinary one-way dial', async () => {
    // One-way TLS: authenticate the server, present nothing.  `ClusterClient`
    // never listens, so `{ ca }` alone is its normal configuration and the
    // listener rule must not reach it.
    const dials = recordingDeno();
    const error = await dialError(() => new DenoTcpBackend().connect({
      host: '10.0.0.1', port: 2552, tls: { ca: CA }, handlers: noopHandlers,
    }));
    expect(error?.message).toMatch(/stop here/);
    expect(dials).toHaveLength(1);
    expect(dials[0]!['caCerts']).toEqual([CA]);
  });

  const halves: ReadonlyArray<[string, TlsTransportOptionsType, string]> = [
    ['a certificate without its key', { cert: CERT, ca: CA }, 'cert'],
    ['a key without its certificate', { key: KEY, ca: CA }, 'key'],
    ['a certificate with an empty key', { cert: CERT, key: '', ca: CA }, 'cert'],
  ];

  for (const [label, tls, present] of halves) {
    test(`DenoTcpBackend refuses ${label}, dialling nothing`, async () => {
      const dials = recordingDeno();
      const error = await dialError(() => new DenoTcpBackend().connect({
        host: '10.0.0.1', port: 2552, tls, handlers: noopHandlers,
      }));
      expect(error?.message).toContain(`\`${present}\``);
      expect(error?.message).toMatch(/half a client credential/);
      expect(dials).toHaveLength(0);
    });

    test(`NodeTcpBackend refuses ${label}, dialling nothing`, async () => {
      const { backend, dials } = recordingNodeBackend();
      const error = await dialError(() => backend.connect({
        host: '10.0.0.1', port: 2552, tls, handlers: noopHandlers,
      }));
      expect(error?.message).toMatch(/half a client credential/);
      expect(dials).toHaveLength(0);
    });

    test(`BunTcpBackend refuses ${label}, dialling nothing`, async () => {
      // With a signal, the Bun adapter hands the dial to its cancellable
      // delegate — a recording one here, so a missed check shows as a dial.
      const dials: unknown[] = [];
      const delegate = {
        connect: (options: unknown): Promise<never> => {
          dials.push(options);
          return Promise.reject(new Error('stop here — the options are what this test is about'));
        },
      };
      const error = await dialError(() => new BunTcpBackend(delegate as never).connect({
        host: '10.0.0.1', port: 2552, tls, handlers: noopHandlers, signal: new AbortController().signal,
      }));
      expect(error?.message).toMatch(/half a client credential/);
      expect(dials).toHaveLength(0);
    });
  }

  test('the refusal names neither value — one of them is a private key', async () => {
    recordingDeno();
    const error = await dialError(() => new DenoTcpBackend().connect({
      host: '10.0.0.1', port: 2552, tls: { key: KEY, ca: CA }, handlers: noopHandlers,
    }));
    expect(error?.message).not.toContain('not-a-real-key');
  });
});
