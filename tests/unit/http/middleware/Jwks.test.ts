import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import {
  JwksKeySet,
  JwksUnavailableError,
  importPublicKey,
  importSecret,
  keySetServes,
  verifySignature,
  type JwksDocumentFetcher,
  type JwksKeySetSettings,
  type VerificationKey,
} from '../../../../src/http/middleware/Jwks.js';
import type { JwtAlgorithm } from '../../../../src/http/middleware/JwtAuthOptions.js';
import type { Clock } from '../../../../src/Clock.js';
import { NoopLogger } from '../../../../src/Logger.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

/* --------------------------------- keys --------------------------------- */
// Generated once, at module scope: RSA generation is the slow part and bun's
// per-test cap is 5 000 ms.

const rsaParameters = (modulusLength: number): RsaHashedKeyGenParams => ({
  name: 'RSASSA-PKCS1-v1_5', modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
});
const rsa = await subtle.generateKey(rsaParameters(2048), true, ['sign', 'verify']) as CryptoKeyPair;
const rsaRotated = await subtle.generateKey(rsaParameters(2048), true, ['sign', 'verify']) as CryptoKeyPair;
const rsaSmall = await subtle.generateKey(rsaParameters(1024), true, ['sign', 'verify']) as CryptoKeyPair;
const ec = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
const ecP384 = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify']) as CryptoKeyPair;

const jwkOf = async (pair: CryptoKeyPair, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const { key_ops: _operations, ext: _extractable, ...jwk } = await subtle.exportKey('jwk', pair.publicKey);
  return { ...jwk, ...extra };
};

const pemOf = async (pair: CryptoKeyPair): Promise<string> => {
  const der = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  const base64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
};

const spkiOf = async (pair: CryptoKeyPair): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await subtle.exportKey('spki', pair.publicKey));

const signRs256 = async (pair: CryptoKeyPair, data: BufferSource): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, data));

const hmacWith = async (secret: BufferSource, data: BufferSource): Promise<Uint8Array<ArrayBuffer>> => {
  const key = await subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, data));
};

const rsaJwk = await jwkOf(rsa, { kid: 'rsa-1', alg: 'RS256', use: 'sig' });
const rsaRotatedJwk = await jwkOf(rsaRotated, { kid: 'rsa-2' });
const ecJwk = await jwkOf(ec, { kid: 'ec-1' });
const keySet = { keys: [rsaJwk, ecJwk] };

/* ------------------------------ harness --------------------------------- */

const manualClock = (start = 1_800_000_000_000): Clock & { advance(ms: number): void } => {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
};

/** A fetcher that answers from `answer` and counts what it was asked. */
const countingFetcher = (answer: (call: number) => unknown | Promise<unknown>): JwksDocumentFetcher & { calls: number } => {
  const fetcher = Object.assign(async (_url: string): Promise<unknown> => {
    fetcher.calls += 1;
    return answer(fetcher.calls);
  }, { calls: 0 });
  return fetcher;
};

const settings = (overrides: Partial<JwksKeySetSettings> = {}): JwksKeySetSettings => ({
  url: 'https://issuer.example/.well-known/jwks.json',
  algorithms: new Set<JwtAlgorithm>(['RS256', 'ES256']),
  timeoutMs: 1_000,
  maxResponseBytes: 65_536,
  cacheTtlMs: 600_000,
  minRefreshIntervalMs: 30_000,
  logger: new NoopLogger(),
  ...overrides,
});

const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

/* -------------------------------- tests --------------------------------- */

describe('JwksKeySet — what a JWK set yields', () => {
  test('RSA and P-256 keys are imported bound to RS256 and ES256, by kid', async () => {
    const keys = new JwksKeySet(settings(), manualClock(), countingFetcher(() => keySet));
    const [rsaKey] = await keys.keysFor('rsa-1', 'RS256');
    const [ecKey] = await keys.keysFor('ec-1', 'ES256');
    expect(rsaKey?.algorithm).toBe('RS256');
    expect(rsaKey?.signatureBytes).toBe(256);
    expect(ecKey?.algorithm).toBe('ES256');
    expect(ecKey?.signatureBytes).toBe(64);
  });

  test('keySetServes answers what an import yields: RS256 and ES256, never HS256', async () => {
    // JwtAuth asks the set only for an algorithm this says it serves, so the
    // answer and the import must agree: a set holding one key of every type
    // yields keys for exactly the algorithms keySetServes names.
    const octJwk = { kty: 'oct', kid: 'oct-1', k: btoa('s'.repeat(32)).replace(/=+$/, '') };
    const every: readonly JwtAlgorithm[] = ['RS256', 'ES256', 'HS256'];
    const keys = new JwksKeySet(
      settings({ algorithms: new Set<JwtAlgorithm>(every) }),
      manualClock(),
      countingFetcher(() => ({ keys: [rsaJwk, ecJwk, octJwk] })),
    );
    for (const algorithm of every) {
      expect({ algorithm, yields: (await keys.keysFor(undefined, algorithm)).length > 0 })
        .toEqual({ algorithm, yields: keySetServes(algorithm) });
    }
    expect(every.filter(keySetServes)).toEqual(['RS256', 'ES256']);
  });

  test('an HMAC (oct) key is never imported from a JWK set, whatever the token asks for', async () => {
    const octJwk = { kty: 'oct', kid: 'oct-1', k: btoa('s'.repeat(32)).replace(/=+$/, ''), alg: 'HS256' };
    const keys = new JwksKeySet(
      settings({ algorithms: new Set<JwtAlgorithm>(['RS256', 'ES256', 'HS256']) }),
      manualClock(),
      countingFetcher(() => ({ keys: [rsaJwk, octJwk] })),
    );
    expect(await keys.keysFor('oct-1', 'HS256')).toEqual([]);
    expect(await keys.keysFor(undefined, 'HS256')).toEqual([]);
  });

  test('entries whose own alg, use, key_ops, curve, size or private members disqualify them are skipped, the rest kept', async () => {
    const entries = [
      rsaJwk,
      await jwkOf(rsaRotated, { kid: 'alg-512', alg: 'RS512' }),
      await jwkOf(rsaRotated, { kid: 'use-enc', use: 'enc' }),
      await jwkOf(rsaRotated, { kid: 'ops-encrypt', key_ops: ['encrypt'] }),
      { ...(await subtle.exportKey('jwk', rsa.privateKey)), kid: 'private' },
      await jwkOf(rsaSmall, { kid: 'rsa-1024' }),
      await jwkOf(ecP384, { kid: 'p-384' }),
      'not an object',
      { kty: 'RSA', kid: 'garbage', n: 'AQAB', e: 'AQAB' },
    ];
    const keys = new JwksKeySet(settings(), manualClock(), countingFetcher(() => ({ keys: entries })));
    expect(await keys.keysFor('rsa-1', 'RS256')).toHaveLength(1);
    for (const kid of ['alg-512', 'use-enc', 'ops-encrypt', 'private', 'rsa-1024', 'garbage']) {
      expect(await keys.keysFor(kid, 'RS256')).toEqual([]);
    }
    expect(await keys.keysFor('p-384', 'ES256')).toEqual([]);
  });

  test('every skipped entry is reported at debug — position, kid and reason — and nothing above debug', async () => {
    const log = new RecordingLogger();
    const entries: unknown[] = [
      rsaJwk,
      await jwkOf(rsaRotated, { kid: 'alg-512', alg: 'RS512' }),
      await jwkOf(rsaRotated, { kid: 'use-enc', use: 'enc' }),
      await jwkOf(rsaRotated, { kid: 'ops-encrypt', key_ops: ['encrypt'] }),
      // An exported private key: its key_ops ['sign'] would refuse it too,
      // but the private members are what the report names.
      { ...(await subtle.exportKey('jwk', rsa.privateKey)), kid: 'private' },
      await jwkOf(rsaSmall, { kid: 'rsa-1024' }),
      await jwkOf(ecP384, { kid: 'p-384' }),
      ecJwk,
      'not an object',
      { ...rsaRotatedJwk, kid: 7 },
      { ...rsaRotatedJwk, kid: 'line\nbreak', use: 'enc' },
      { kty: 'RSA', kid: 'garbage', n: 'AQAB', e: 'AQAB' },
    ];
    const keys = new JwksKeySet(
      settings({ algorithms: new Set<JwtAlgorithm>(['RS256']), logger: log }),
      manualClock(),
      countingFetcher(() => ({ keys: entries })),
    );
    expect(await keys.keysFor('rsa-1', 'RS256')).toHaveLength(1);
    const prefix = 'JwtAuth: the JWK set at https://issuer.example/.well-known/jwks.json yields no key for';
    expect(log.records.filter((record) => record.level !== 'debug')).toEqual([]);
    const messages = log.records.map((record) => record.message);
    expect(messages.slice(0, -1)).toEqual([
      `${prefix} entry 1 (kid "alg-512"): its alg names another algorithm than RS256`,
      `${prefix} entry 2 (kid "use-enc"): its use is not 'sig'`,
      `${prefix} entry 3 (kid "ops-encrypt"): its key_ops do not include 'verify'`,
      `${prefix} entry 4 (kid "private"): it carries private key material (d)`,
      `${prefix} entry 5 (kid "rsa-1024"): it could not be imported: an RS256 key must be at least 2048 bits (RFC 7518 §3.3), this one has 1024`,
      `${prefix} entry 6 (kid "p-384"): it is not an RSA or P-256 key`,
      `${prefix} entry 7 (kid "ec-1"): its key type verifies ES256, which algorithms does not allow`,
      `${prefix} entry 8: it is not a JSON object`,
      `${prefix} entry 9: its kid is not a non-empty string`,
      `${prefix} entry 10 (kid "line\\nbreak"): its use is not 'sig'`,
    ]);
    // The runtime words its own refusal of a malformed key; only the frame is ours.
    expect(messages.at(-1)).toStartWith(`${prefix} entry 11 (kid "garbage"): it could not be imported: `);
    expect(messages.some((message) => message.includes('\n'))).toBe(false);
  });

  test('a published private key is skipped for its private members alone — use sig, alg RS256 and no key_ops', async () => {
    // Nothing but the private members says what this entry is: its alg, use
    // and missing key_ops all describe a verification key, and its public
    // half imports.  So that one check is all that keeps it out.
    const { key_ops: _operations, ext: _extractable, ...privateJwk } = await subtle.exportKey('jwk', rsaRotated.privateKey);
    const published = { ...privateJwk, kid: 'published-private', alg: 'RS256', use: 'sig' };
    const keys = new JwksKeySet(settings(), manualClock(), countingFetcher(() => ({ keys: [rsaJwk, published] })));
    expect(await keys.keysFor('published-private', 'RS256')).toEqual([]);
    expect(await keys.keysFor('rsa-1', 'RS256')).toHaveLength(1);
  });

  test('each private or symmetric member on its own disqualifies an otherwise public entry', async () => {
    const members: Record<string, unknown> = {
      d: 'AQAB', p: 'AQAB', q: 'AQAB', dp: 'AQAB', dq: 'AQAB', qi: 'AQAB', oth: [{ r: 'AQAB', d: 'AQAB', t: 'AQAB' }], k: 'AQAB',
    };
    const entries = Object.entries(members).map(([member, value]) => ({ ...rsaRotatedJwk, kid: `with-${member}`, [member]: value }));
    const keys = new JwksKeySet(settings(), manualClock(), countingFetcher(() => ({ keys: [rsaJwk, ...entries] })));
    for (const member of Object.keys(members)) {
      expect({ member, found: (await keys.keysFor(`with-${member}`, 'RS256')).length }).toEqual({ member, found: 0 });
    }
    expect(await keys.keysFor('rsa-1', 'RS256')).toHaveLength(1);
  });

  test('only keys for the allowed algorithms are imported', async () => {
    const keys = new JwksKeySet(settings({ algorithms: new Set<JwtAlgorithm>(['RS256']) }), manualClock(), countingFetcher(() => keySet));
    expect(await keys.keysFor('rsa-1', 'RS256')).toHaveLength(1);
    expect(await keys.keysFor('ec-1', 'ES256')).toEqual([]);
  });

  test('a key id the set holds for another algorithm is answered empty, without a refetch', async () => {
    const clock = manualClock();
    const fetcher = countingFetcher(() => keySet);
    const keys = new JwksKeySet(settings(), clock, fetcher);
    await keys.keysFor('rsa-1', 'RS256');
    clock.advance(60_000); // past the refresh floor: a refetch would be allowed
    expect(await keys.keysFor('rsa-1', 'ES256')).toEqual([]);
    expect(fetcher.calls).toBe(1);
  });

  test('a document that is not a JWK set is a failed fetch', async () => {
    for (const document of [{}, [], { keys: 'none' }, null, 'text']) {
      const keys = new JwksKeySet(settings(), manualClock(), countingFetcher(() => document));
      expect(await rejection(keys.keysFor('rsa-1', 'RS256'))).toBeInstanceOf(JwksUnavailableError);
    }
  });
});

describe('JwksKeySet — caching, refresh and failure', () => {
  test('the first request loads the set, and the cache answers until it expires', async () => {
    const clock = manualClock();
    const fetcher = countingFetcher(() => keySet);
    const keys = new JwksKeySet(settings(), clock, fetcher);
    for (let i = 0; i < 20; i += 1) await keys.keysFor('rsa-1', 'RS256');
    expect(fetcher.calls).toBe(1);
    clock.advance(600_000 - 1);
    await keys.keysFor('rsa-1', 'RS256');
    expect(fetcher.calls).toBe(1);
    clock.advance(1);
    await keys.keysFor('rsa-1', 'RS256');
    expect(fetcher.calls).toBe(2);
  });

  test('concurrent first requests share one fetch', async () => {
    const fetcher = countingFetcher(() => keySet);
    const keys = new JwksKeySet(settings(), manualClock(), fetcher);
    const answers = await Promise.all(Array.from({ length: 25 }, () => keys.keysFor('rsa-1', 'RS256')));
    expect(answers.every((found) => found.length === 1)).toBe(true);
    expect(fetcher.calls).toBe(1);
  });

  test('an unknown key id refreshes the set — the way a rotated key is found', async () => {
    const clock = manualClock();
    const fetcher = countingFetcher((call) => (call === 1 ? keySet : { keys: [rsaJwk, rsaRotatedJwk] }));
    const keys = new JwksKeySet(settings(), clock, fetcher);
    await keys.keysFor('rsa-1', 'RS256');
    clock.advance(30_000);
    expect(await keys.keysFor('rsa-2', 'RS256')).toHaveLength(1);
    expect(fetcher.calls).toBe(2);
  });

  test('a storm of unknown key ids costs one fetch per refresh floor, concurrent or not', async () => {
    const clock = manualClock();
    const fetcher = countingFetcher(() => keySet);
    const keys = new JwksKeySet(settings(), clock, fetcher);
    await keys.keysFor('rsa-1', 'RS256');
    expect(fetcher.calls).toBe(1);

    // Inside the floor of the initial load: no fetch at all.
    for (let i = 0; i < 50; i += 1) expect(await keys.keysFor(`random-${i}`, 'RS256')).toEqual([]);
    expect(fetcher.calls).toBe(1);

    // Past it: fifty concurrent unknown ids, one fetch between them.
    clock.advance(30_000);
    const answers = await Promise.all(Array.from({ length: 50 }, (_, i) => keys.keysFor(`storm-${i}`, 'RS256')));
    expect(answers.every((found) => found.length === 0)).toBe(true);
    expect(fetcher.calls).toBe(2);

    // And sequential ones right after it: still that one.
    for (let i = 0; i < 50; i += 1) await keys.keysFor(`after-${i}`, 'RS256');
    expect(fetcher.calls).toBe(2);

    // Known keys kept answering throughout.
    expect(await keys.keysFor('rsa-1', 'RS256')).toHaveLength(1);
  });

  test('an unreachable set fails closed, and is retried only once per refresh floor', async () => {
    const clock = manualClock();
    const fetcher = countingFetcher(() => {
      throw new Error('connect ECONNREFUSED');
    });
    const keys = new JwksKeySet(settings(), clock, fetcher);
    const first = await rejection(keys.keysFor('rsa-1', 'RS256'));
    expect(first).toBeInstanceOf(JwksUnavailableError);
    expect((first as Error).message).toContain('ECONNREFUSED');
    expect((first as Error).cause).toBeInstanceOf(Error);

    for (let i = 0; i < 10; i += 1) expect(await rejection(keys.keysFor('rsa-1', 'RS256'))).toBeInstanceOf(JwksUnavailableError);
    expect(fetcher.calls).toBe(1);

    clock.advance(30_000);
    expect(await rejection(keys.keysFor('rsa-1', 'RS256'))).toBeInstanceOf(JwksUnavailableError);
    expect(fetcher.calls).toBe(2);
  });

  test('an expired set whose refetch fails is not served stale — not once, not after', async () => {
    const clock = manualClock();
    const fetcher = countingFetcher((call) => {
      if (call === 1) return keySet;
      throw new Error('issuer down');
    });
    const keys = new JwksKeySet(settings(), clock, fetcher);
    expect(await keys.keysFor('rsa-1', 'RS256')).toHaveLength(1);
    clock.advance(600_000);
    // The refetch that fails, the requests inside the floor after it, and the
    // retry once the floor has passed: none of them answers from the old set.
    expect(await rejection(keys.keysFor('rsa-1', 'RS256'))).toBeInstanceOf(JwksUnavailableError);
    expect(await rejection(keys.keysFor('rsa-1', 'RS256'))).toBeInstanceOf(JwksUnavailableError);
    expect(await rejection(keys.keysFor(undefined, 'RS256'))).toBeInstanceOf(JwksUnavailableError);
    expect(fetcher.calls).toBe(2);
    clock.advance(30_000);
    expect(await rejection(keys.keysFor('rsa-1', 'RS256'))).toBeInstanceOf(JwksUnavailableError);
    expect(fetcher.calls).toBe(3);
  });

  test('requests for a rotated key that arrive while the refresh runs wait for it and find the key', async () => {
    const clock = manualClock();
    let refreshStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    let release: () => void = () => undefined;
    const fetcher = countingFetcher((call) => {
      if (call === 1) return keySet;
      refreshStarted();
      return new Promise((resolve) => {
        release = () => resolve({ keys: [rsaJwk, rsaRotatedJwk] });
      });
    });
    const keys = new JwksKeySet(settings(), clock, fetcher);
    await keys.keysFor('rsa-1', 'RS256');
    clock.advance(30_000);
    const first = keys.keysFor('rsa-2', 'RS256');
    await started;
    // Arrives inside the refresh floor the running fetch opened: it must join
    // that fetch, not answer "unknown" from the set being replaced.
    const second = keys.keysFor('rsa-2', 'RS256');
    release();
    expect(await first).toHaveLength(1);
    expect(await second).toHaveLength(1);
    expect(fetcher.calls).toBe(2);
  });

  test('an unknown key id whose refresh fails is unavailable, not unknown — and cached keys keep answering', async () => {
    const clock = manualClock();
    const fetcher = countingFetcher((call) => {
      if (call === 1) return keySet;
      throw new Error('issuer down');
    });
    const keys = new JwksKeySet(settings(), clock, fetcher);
    await keys.keysFor('rsa-1', 'RS256');
    clock.advance(30_000);
    expect(await rejection(keys.keysFor('rsa-2', 'RS256'))).toBeInstanceOf(JwksUnavailableError);
    // Within the floor after that failure: still unavailable, and no fetch.
    expect(await rejection(keys.keysFor('rsa-3', 'RS256'))).toBeInstanceOf(JwksUnavailableError);
    expect(fetcher.calls).toBe(2);
    // The set fetched before is still current, so its keys still answer.
    expect(await keys.keysFor('rsa-1', 'RS256')).toHaveLength(1);
  });

  test('a cached key answers while a refresh another request started is running, and does not inherit its failure', async () => {
    const clock = manualClock();
    let refreshStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    let failRefresh: (error: Error) => void = () => undefined;
    const fetcher = countingFetcher((call) => {
      if (call === 1) return keySet;
      refreshStarted();
      return new Promise((_resolve, reject) => {
        failRefresh = reject;
      });
    });
    const keys = new JwksKeySet(settings(), clock, fetcher);
    await keys.keysFor('rsa-1', 'RS256');
    clock.advance(30_000);
    const unknown = rejection(keys.keysFor('rsa-2', 'RS256'));
    await started;
    // The refresh is running now.  A cached key has nothing to wait for —
    // and must not come back as the refresh's failure.
    let cachedAnswer: number | unknown = 'pending';
    const cached = keys.keysFor('rsa-1', 'RS256').then(
      (found) => {
        cachedAnswer = found.length;
      },
      (error: unknown) => {
        cachedAnswer = error;
      },
    );
    failRefresh(new Error('issuer down'));
    await cached;
    expect(cachedAnswer).toBe(1);
    expect(await unknown).toBeInstanceOf(JwksUnavailableError);
    expect(fetcher.calls).toBe(2);
  });
});

describe('JwksKeySet — the HTTP fetch is bounded', () => {
  type Route = (request: IncomingMessage, response: ServerResponse) => void;
  const routes = new Map<string, Route>();
  const hits = new Map<string, number>();
  const sockets = new Set<Socket>();
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = request.url ?? '';
      hits.set(path, (hits.get(path) ?? 0) + 1);
      const route = routes.get(path);
      if (route === undefined) {
        response.writeHead(404).end();
        return;
      }
      route(request, response);
    });
    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;

    const json = (body: unknown): Route => (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    routes.set('/jwks', json(keySet));
    routes.set('/large', json({ keys: [rsaJwk], padding: 'x'.repeat(200_000) }));
    routes.set('/never', () => {
      // Never answers: only the client's deadline ends this exchange.
    });
    routes.set('/error', (_request, response) => {
      response.writeHead(500).end('boom');
    });
    routes.set('/redirect', (_request, response) => {
      response.writeHead(302, { location: '/jwks-elsewhere' }).end();
    });
    routes.set('/jwks-elsewhere', json(keySet));
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('a JWK set over loopback http is read with the default fetcher', async () => {
    const keys = new JwksKeySet(settings({ url: `${base}/jwks` }), manualClock());
    expect(await keys.keysFor('rsa-1', 'RS256')).toHaveLength(1);
  });

  test('a response over the size cap is a failed fetch', async () => {
    const keys = new JwksKeySet(settings({ url: `${base}/large`, maxResponseBytes: 4_096 }), manualClock());
    const error = await rejection(keys.keysFor('rsa-1', 'RS256'));
    expect(error).toBeInstanceOf(JwksUnavailableError);
    expect((error as Error).message).toContain('maxResponseBytes=4096');
  });

  test('a set slower than the deadline is a failed fetch, at the deadline and not the client default', async () => {
    const keys = new JwksKeySet(settings({ url: `${base}/never`, timeoutMs: 150 }), manualClock());
    const started = performance.now();
    const error = await rejection(keys.keysFor('rsa-1', 'RS256'));
    const elapsed = performance.now() - started;
    expect(error).toBeInstanceOf(JwksUnavailableError);
    // HttpClient's own default is 30 s; this ends at the 150 ms given.
    expect(elapsed).toBeLessThan(3_000);
  });

  test('a non-200 answer is a failed fetch', async () => {
    const keys = new JwksKeySet(settings({ url: `${base}/error` }), manualClock());
    const error = await rejection(keys.keysFor('rsa-1', 'RS256'));
    expect(error).toBeInstanceOf(JwksUnavailableError);
    expect((error as Error).message).toContain('500');
  });

  test('a redirect is refused, and its target never asked', async () => {
    const keys = new JwksKeySet(settings({ url: `${base}/redirect` }), manualClock());
    expect(await rejection(keys.keysFor('rsa-1', 'RS256'))).toBeInstanceOf(JwksUnavailableError);
    expect(hits.get('/redirect')).toBe(1);
    expect(hits.get('/jwks-elsewhere')).toBeUndefined();
  });
});

describe('static keys and the one-algorithm-per-key binding', () => {
  const signingInput = encoder.encode('header.payload');

  test('a PEM public key verifies its own RS256 signatures and nothing else', async () => {
    const key = await importPublicKey({ algorithm: 'RS256', key: await pemOf(rsa) });
    const signature = await signRs256(rsa, signingInput);
    expect(key.signatureBytes).toBe(256);
    expect(await verifySignature(key, signature, signingInput)).toBe(true);
    expect(await verifySignature(key, signature, encoder.encode('header.tampered'))).toBe(false);
    expect(await verifySignature(key, await signRs256(rsaRotated, signingInput), signingInput)).toBe(false);
  });

  test('a JWK public key takes its kid as the key id unless one is given', async () => {
    expect((await importPublicKey({ algorithm: 'RS256', key: rsaJwk })).keyId).toBe('rsa-1');
    expect((await importPublicKey({ keyId: 'rsa-1', algorithm: 'RS256', key: rsaJwk })).keyId).toBe('rsa-1');
    expect((await importPublicKey({ algorithm: 'ES256', key: await pemOf(ec) })).keyId).toBeUndefined();
  });

  test('an RSA key under 2048 bits is refused (RFC 7518 §3.3), and a key of the wrong type does not import', async () => {
    expect(await rejection(importPublicKey({ algorithm: 'RS256', key: await pemOf(rsaSmall) }))).toBeInstanceOf(Error);
    expect(String(await rejection(importPublicKey({ algorithm: 'RS256', key: await pemOf(rsaSmall) })))).toContain('2048');
    expect(await rejection(importPublicKey({ algorithm: 'RS256', key: await pemOf(ec) }))).toBeInstanceOf(Error);
  });

  test('an HS256 token signed with the RSA public key bytes verifies only under a naive import', async () => {
    // The forgery: HMAC over the signing input, keyed with what the attacker
    // has — the public key, as DER and as the PEM text.
    const rsaKey = await importPublicKey({ algorithm: 'RS256', key: await pemOf(rsa) });
    for (const publicBytes of [await spkiOf(rsa), encoder.encode(await pemOf(rsa))]) {
      const forged = await hmacWith(publicBytes, signingInput);
      // Here: the RSA key verifies RSA signatures only, so the forgery fails.
      expect(await verifySignature(rsaKey, forged, signingInput)).toBe(false);
      // A verifier that imports "the key" for whatever algorithm the token
      // names accepts it — which is what makes this test mean something.
      const naive = await subtle.importKey('raw', publicBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
      expect(await subtle.verify('HMAC', naive, forged, signingInput)).toBe(true);
    }
  });

  test('a secret verifies HMAC-SHA-256 and is bound to HS256', async () => {
    const secret = 's'.repeat(32);
    const key = await importSecret({ keyId: 'v1', secret });
    expect(key.algorithm).toBe('HS256');
    expect(key.signatureBytes).toBe(32);
    expect(await verifySignature(key, await hmacWith(encoder.encode(secret), signingInput), signingInput)).toBe(true);
    expect(await verifySignature(key, await hmacWith(encoder.encode('t'.repeat(32)), signingInput), signingInput)).toBe(false);
  });

  test('a WebCrypto refusal inside verify is a failed verification — never a pass, never a thrown error', async () => {
    // A key whose WebCrypto algorithm is not the one its binding verifies
    // with: verify throws on every runtime (InvalidAccessError), which is the
    // shape a runtime's own refusal of a key takes — Deno refuses a public
    // exponent of 1 there rather than at import.
    const hmac = await subtle.importKey('raw', encoder.encode('s'.repeat(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const mismatched: VerificationKey = { keyId: undefined, algorithm: 'RS256', key: hmac, signatureBytes: 256 };
    const signature = new Uint8Array(256);
    expect(await rejection(subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, hmac, signature, signingInput))).toBeDefined();
    expect(await verifySignature(mismatched, signature, signingInput)).toBe(false);
  });
});
