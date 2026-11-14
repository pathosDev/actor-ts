import { describe, expect, test } from 'bun:test';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import { idempotent } from '../../../../src/http/cache/IdempotencyKey.js';
import { IdempotencyOptions } from '../../../../src/http/cache/IdempotencyOptions.js';
import { complete } from '../../../../src/http/Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../../../../src/http/Types.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';

/**
 * The claim on an in-flight key and the record of a finished one are two
 * different things with two lifetimes (#984), and the claim is released or
 * overwritten only by the request that still holds it (#1082).
 *
 * No test here sleeps: a claim lapsing is simulated by deleting it, which is
 * exactly what its TTL expiring does to the cache.
 */

type TtlCall = { readonly operation: 'setIfAbsent' | 'set'; readonly key: string; readonly ttlMs: number | undefined };

/** An `InMemoryCache` that records the TTL every write asked for. */
class RecordingCache extends InMemoryCache {
  readonly writes: TtlCall[] = [];
  override async setIfAbsent<V>(key: string, value: V, ttlMs?: number): Promise<boolean> {
    this.writes.push({ operation: 'setIfAbsent', key, ttlMs });
    return super.setIfAbsent(key, value, ttlMs);
  }
  override async set<V>(key: string, value: V, ttlMs?: number): Promise<void> {
    this.writes.push({ operation: 'set', key, ttlMs });
    return super.set(key, value, ttlMs);
  }
}

const request = (key: string, body = '{"amount":100}'): HttpRequest => ({
  method: 'POST',
  path: '/payments',
  headers: { 'idempotency-key': key },
  query: {},
  params: {},
  body: new TextEncoder().encode(body),
});

/** A promise and the function that settles it. */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

const DAY_MS = 24 * 60 * 60_000;

describe('idempotent — the claim has its own, short TTL', () => {
  test('the in-flight claim is written with lockTtlMs (default 60 s), the record with ttlMs', async () => {
    const cache = new RecordingCache();
    const handler = idempotent({ cache })(() => complete(Status.OK, { ok: true }));
    await handler(request('k1'));
    expect(cache.writes).toEqual([
      { operation: 'setIfAbsent', key: 'idem:k1', ttlMs: 60_000 },
      { operation: 'set', key: 'idem:k1', ttlMs: DAY_MS },
    ]);
  });

  test('a configured lockTtlMs is the claim TTL, independent of ttlMs', async () => {
    const cache = new RecordingCache();
    const handler = idempotent({ cache, ttlMs: 3_600_000, lockTtlMs: 5_000 })(() => complete(Status.OK, {}));
    await handler(request('k2'));
    expect(cache.writes.map((write) => write.ttlMs)).toEqual([5_000, 3_600_000]);
  });

  test('a worker that dies mid-handler leaves a claim that lapses on lockTtlMs, not on the 24 h record TTL', async () => {
    const cache = new RecordingCache();
    const never = deferred<HttpResponse>();
    const started = deferred<void>();
    const crashed = idempotent({ cache })(() => { started.resolve(); return never.promise; });
    void crashed(request('crash'));
    await started.promise;
    // The only write is the claim, and it expires in a minute: nothing else
    // will ever touch the key, so this TTL is the whole recovery path.
    expect(cache.writes).toEqual([{ operation: 'setIfAbsent', key: 'idem:crash', ttlMs: 60_000 }]);
    const retry = await idempotent({ cache })(() => complete(Status.OK, {}))(request('crash'));
    expect(retry.status).toBe(Status.Conflict);
  });
});

describe('idempotent — a handler that throws is not re-run by default', () => {
  test('throw after a side effect: the retry is answered from a failed record, the charge happens once', async () => {
    const cache = new InMemoryCache();
    let charges = 0;
    const handler = idempotent({ cache })(() => {
      charges += 1;
      throw new Error('receipt email service down');
    });
    await expect(handler(request('pay-1'))).rejects.toThrow('receipt email service down');
    const retry = await handler(request('pay-1'));
    expect(charges).toBe(1);
    expect(retry.status).toBe(Status.InternalServerError);
    expect(JSON.stringify(retry.body)).toContain('new key');
  });

  test('the failed record still guards its fingerprint: same key, different request → 422', async () => {
    const cache = new InMemoryCache();
    const handler = idempotent({ cache })(() => { throw new Error('boom'); });
    await expect(handler(request('pay-2'))).rejects.toThrow();
    const other = await handler(request('pay-2', '{"amount":999}'));
    expect(other.status).toBe(Status.UnprocessableEntity);
  });

  test("onHandlerError: 'release' opts back into a retry, for a handler known to be atomic", async () => {
    const cache = new InMemoryCache();
    let attempts = 0;
    const handler = idempotent({ cache, onHandlerError: 'release' })(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('transaction rolled back');
      return complete(Status.OK, { ok: true });
    });
    await expect(handler(request('atomic'))).rejects.toThrow();
    expect((await handler(request('atomic'))).status).toBe(200);
    expect(attempts).toBe(2);
  });
});

describe('idempotent — transient failures are not pinned', () => {
  test('a 503 is not stored: the retry runs the handler again, and its 200 is what replays', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = idempotent({ cache })(() => {
      calls += 1;
      return calls === 1
        ? complete(Status.ServiceUnavailable, { error: 'upstream 503' })
        : complete(Status.Created, { id: 'p-1' });
    });
    expect((await handler(request('t-1'))).status).toBe(503);
    expect((await handler(request('t-1'))).status).toBe(201);
    expect((await handler(request('t-1'))).status).toBe(201);
    expect(calls).toBe(2);
  });

  test('by default 5xx, 408 and 429 are released; 2xx and other 4xx are stored', async () => {
    for (const [status, stored] of [
      [500, false], [502, false], [503, false], [408, false], [429, false],
      [200, true], [201, true], [400, true], [404, true], [409, true], [422, true],
    ] as const) {
      const cache = new InMemoryCache();
      let calls = 0;
      const handler = idempotent({ cache })(() => { calls += 1; return complete(status, {}); });
      await handler(request(`s-${status}`));
      await handler(request(`s-${status}`));
      expect({ status, stored: calls === 1 }).toEqual({ status, stored });
    }
  });

  test('cacheStatuses replaces the default rule', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = idempotent({ cache, cacheStatuses: [200, 201] })(() => {
      calls += 1;
      return complete(Status.NotFound, {});
    });
    await handler(request('nf'));
    await handler(request('nf'));
    expect(calls).toBe(2);
  });
});

describe('idempotent — release and overwrite are token-checked (#1082)', () => {
  /**
   * The issue's four steps: A claims and overruns its claim; B claims after
   * the lapse; A finishes; C arrives.  Whatever A does on finishing must not
   * touch B's claim, so C is refused with 409 instead of running alongside B.
   */
  async function overrun(onHandlerError: 'retain' | 'release', finishA: (gate: ReturnType<typeof deferred<HttpResponse>>) => void) {
    const cache = new InMemoryCache();
    const gateA = deferred<HttpResponse>();
    const gateB = deferred<HttpResponse>();
    const gates = [gateA, gateB];
    // Each execution announces that it started, i.e. that its claim is held —
    // the test steps on that signal instead of on elapsed time.
    const started = [deferred<void>(), deferred<void>()];
    let executions = 0;
    const handler = idempotent({ cache, lockTtlMs: 5_000, onHandlerError })(() => {
      started[executions]?.resolve();
      executions += 1;
      return gates.shift()?.promise ?? complete(Status.OK, { by: 'C' });
    });

    const a = handler(request('k')).then((response) => response, (error: Error) => error);
    await started[0]!.promise;
    await cache.delete('idem:k');                     // A's claim lapses
    const b = handler(request('k'));                  // B claims and starts
    await started[1]!.promise;
    finishA(gateA);                                   // A finishes, late
    const outcomeA = await a;
    const c = await handler(request('k'));            // C arrives
    gateB.resolve(complete(Status.OK, { by: 'B' }));
    const outcomeB = await b;
    const replay = await handler(request('k'));
    return { executions, outcomeA, c, outcomeB, replay };
  }

  test("a late throw under 'release' does not delete the claim a retry now holds", async () => {
    const run = await overrun('release', (gate) => gate.reject(new Error('A failed late')));
    expect(run.outcomeA).toBeInstanceOf(Error);
    expect(run.c.status).toBe(Status.Conflict);
    expect(run.executions).toBe(2);
    expect(run.replay.body).toEqual({ by: 'B' });
  });

  test("a late throw under 'retain' does not overwrite that claim with a failed record", async () => {
    const run = await overrun('retain', (gate) => gate.reject(new Error('A failed late')));
    expect(run.c.status).toBe(Status.Conflict);
    expect(run.executions).toBe(2);
    expect(run.replay.body).toEqual({ by: 'B' });
  });

  test('a late success does not overwrite that claim; its response still reaches its own caller', async () => {
    const run = await overrun('retain', (gate) => gate.resolve(complete(Status.OK, { by: 'A' })));
    expect((run.outcomeA as HttpResponse).body).toEqual({ by: 'A' });
    expect(run.c.status).toBe(Status.Conflict);
    expect(run.executions).toBe(2);
    expect(run.replay.body).toEqual({ by: 'B' });
  });

  test('a late transient failure does not release that claim either', async () => {
    const run = await overrun('retain', (gate) => gate.resolve(complete(Status.ServiceUnavailable, {})));
    expect(run.c.status).toBe(Status.Conflict);
    expect(run.executions).toBe(2);
  });
});

describe('idempotent — lifecycle options', () => {
  test('the builder writes each new field under its plain name', () => {
    const options = IdempotencyOptions.create()
      .withLockTtlMs(10_000)
      .withOnHandlerError('release')
      .withCacheStatuses([200]);
    expect({ ...options }).toEqual({ lockTtlMs: 10_000, onHandlerError: 'release', cacheStatuses: [200] });
  });

  test('invalid values are refused up front', () => {
    const cache = new InMemoryCache();
    expect(() => idempotent({ cache, lockTtlMs: 0 })).toThrow(OptionsError);
    expect(() => idempotent({ cache, onHandlerError: 'retry' as 'retain' })).toThrow(OptionsError);
    expect(() => idempotent({ cache, cacheStatuses: [] })).toThrow(OptionsError);
  });
});
