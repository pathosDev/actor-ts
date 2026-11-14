import { describe, expect, test } from 'bun:test';
import { CacheError } from '../../../../src/cache/Cache.js';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import { cached } from '../../../../src/http/cache/ResponseCache.js';
import { rateLimit } from '../../../../src/http/cache/RateLimit.js';
import { RateLimitOptions } from '../../../../src/http/cache/RateLimitOptions.js';
import { complete } from '../../../../src/http/Route.js';
import { Status, type HttpRequest } from '../../../../src/http/Types.js';
import { DefaultMetricsRegistry } from '../../../../src/metrics/Metrics.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';

/**
 * A rate limiter whose cache fails must not be silently off (#983): the
 * failure is logged and counted, and whether the request passes is a
 * configured choice rather than an unconditional `catch {}`.
 */

const request: HttpRequest = { method: 'GET', path: '/', headers: {}, query: {}, params: {}, body: null };

/** A cache whose `incr` rejects — each call with a fresh error, like a Redis outage. */
function failingCache(error: () => Error = () => new CacheError('RedisCache.incr failed: Connection is closed')): InMemoryCache {
  const cache = new InMemoryCache();
  cache.incr = async () => { throw error(); };
  return cache;
}

describe('rateLimit — a failing backend is visible', () => {
  test('the failure is logged at warn, and the request still passes by default', async () => {
    const logger = new RecordingLogger();
    let handled = 0;
    const limited = rateLimit({ cache: failingCache(), windowMs: 60_000, max: 1, key: () => 'k', logger })(
      () => { handled += 1; return complete(Status.OK, { ok: true }); },
    );
    expect((await limited(request)).status).toBe(200);
    expect(handled).toBe(1);
    const warnings = logger.records.filter((record) => record.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('Connection is closed');
    expect(warnings[0]!.message).toContain('fail open');
  });

  test('every failure increments http_rate_limit_backend_errors_total', async () => {
    const metrics = new DefaultMetricsRegistry();
    const limited = rateLimit({
      cache: failingCache(), windowMs: 60_000, max: 1, key: () => 'k',
      logger: new RecordingLogger(), metrics,
    })(() => complete(Status.OK, {}));
    for (let i = 0; i < 5; i++) await limited(request);
    expect(metrics.counter('http_rate_limit_backend_errors_total', { prefix: 'rl:' }).value).toBe(5);
  });

  test('the log is rate-limited — fifty failures inside one window are one line, not fifty', async () => {
    const logger = new RecordingLogger();
    const limited = rateLimit({ cache: failingCache(), windowMs: 60_000, max: 2, key: () => 'k', logger })(
      () => complete(Status.OK, {}),
    );
    for (let i = 0; i < 50; i++) await limited(request);
    expect(logger.records).toHaveLength(1);
  });

  test('onBackendError is told about every failure, with the key and the mode', async () => {
    const seen: Array<{ message: string; key: string; failureMode: string; permanent: boolean }> = [];
    const limited = rateLimit({
      cache: failingCache(), windowMs: 60_000, max: 1, key: () => 'client-7',
      logger: new RecordingLogger(),
      onBackendError: (error, context) => {
        seen.push({ message: (error as Error).message, ...context });
      },
    })(() => complete(Status.OK, {}));
    await limited(request);
    await limited(request);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ key: 'client-7', failureMode: 'open', permanent: false });
  });
});

describe('rateLimit — failureMode', () => {
  test("'closed' answers 503 and never runs the handler", async () => {
    let handled = 0;
    const limited = rateLimit({
      cache: failingCache(), windowMs: 60_000, max: 100, key: () => 'k',
      failureMode: 'closed', logger: new RecordingLogger(),
    })(() => { handled += 1; return complete(Status.OK, {}); });
    for (let i = 0; i < 3; i++) {
      expect((await limited(request)).status).toBe(Status.ServiceUnavailable);
    }
    expect(handled).toBe(0);
  });

  test("'open' is the default and passes every request through", async () => {
    let handled = 0;
    const limited = rateLimit({
      cache: failingCache(), windowMs: 60_000, max: 1, key: () => 'k', logger: new RecordingLogger(),
    })(() => { handled += 1; return complete(Status.OK, {}); });
    for (let i = 0; i < 4; i++) expect((await limited(request)).status).toBe(200);
    expect(handled).toBe(4);
  });

  test('the builder writes failureMode under the plain field name', () => {
    const options = RateLimitOptions.create().withFailureMode('closed');
    expect({ ...options }).toEqual({ failureMode: 'closed' });
  });

  test('an unknown failureMode is refused up front', () => {
    expect(() => rateLimit({
      cache: new InMemoryCache(), windowMs: 1_000, max: 1, key: () => 'k',
      failureMode: 'sideways' as 'open',
    })).toThrow(OptionsError);
  });

  test('a healthy cache never logs or calls onBackendError', async () => {
    const logger = new RecordingLogger();
    let calls = 0;
    const limited = rateLimit({
      cache: new InMemoryCache(), windowMs: 60_000, max: 1, key: () => 'k', logger,
      onBackendError: () => { calls += 1; },
    })(() => complete(Status.OK, {}));
    await limited(request);
    expect((await limited(request)).status).toBe(429);
    expect(calls).toBe(0);
    expect(logger.records).toHaveLength(0);
  });
});

describe('rateLimit — a permanent failure is reported as such', () => {
  test('the same error instance twice is a memoised failure: one error-level line naming it', async () => {
    // `RedisCache` memoises the `ioredis` import through `Lazy`, rejection
    // included — a missing peer rejects every call with the identical error.
    const missingPeer = new CacheError('RedisCache requires the "ioredis" package.  Install it with: npm install ioredis');
    const logger = new RecordingLogger();
    const permanence: boolean[] = [];
    const limited = rateLimit({
      cache: failingCache(() => missingPeer), windowMs: 60_000, max: 1, key: () => 'k', logger,
      onBackendError: (_error, context) => { permanence.push(context.permanent); },
    })(() => complete(Status.OK, {}));
    for (let i = 0; i < 10; i++) await limited(request);
    expect(permanence.slice(0, 2)).toEqual([false, true]);
    const errors = logger.records.filter((record) => record.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('ioredis');
    expect(errors[0]!.message).toContain('permanent');
  });
});

describe('cached(...) does not replay rate-limit counters', () => {
  test("a cache hit carries no x-ratelimit-* headers from the first caller's response", async () => {
    const responses = cached({ cache: new InMemoryCache(), ttlMs: 60_000, key: () => 'k' });
    const handler = responses(() => complete(Status.OK, { ok: true }, {
      'x-ratelimit-limit': '10',
      'x-ratelimit-remaining': '9',
      'x-custom': 'kept',
    }));
    await handler(request);
    const hit = await handler(request);
    expect(hit.headers?.['x-ratelimit-remaining']).toBeUndefined();
    expect(hit.headers?.['x-ratelimit-limit']).toBeUndefined();
    expect(hit.headers?.['x-custom']).toBe('kept');
  });
});
