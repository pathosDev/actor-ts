import { describe, expect, test } from 'bun:test';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import { idempotent } from '../../../../src/http/cache/IdempotencyKey.js';
import { complete } from '../../../../src/http/Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../../../../src/http/types.js';

function makeReq(headers: Record<string, string> = {}, body: Uint8Array | null = null): HttpRequest {
  return { method: 'POST', path: '/payments', headers, query: {}, params: {}, body };
}

describe('idempotent — happy paths', () => {
  test('first request runs the handler; second with same key replays cached response', async () => {
    const cache = new InMemoryCache();
    let invocations = 0;
    const inner = (): HttpResponse => { invocations++; return complete(Status.OK, { id: invocations }); };
    const handler = idempotent({ cache })(inner);

    const first = await handler(makeReq({ 'idempotency-key': 'k1' }));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ id: 1 });
    expect(invocations).toBe(1);

    const second = await handler(makeReq({ 'idempotency-key': 'k1' }));
    expect(second.body).toEqual({ id: 1 });  // SAME response replayed
    expect(invocations).toBe(1);             // handler NOT called again
  });

  test('different keys → independent invocations', async () => {
    const cache = new InMemoryCache();
    let invocations = 0;
    const handler = idempotent({ cache })(() => {
      invocations++;
      return complete(Status.OK, { n: invocations });
    });
    await handler(makeReq({ 'idempotency-key': 'k1' }));
    await handler(makeReq({ 'idempotency-key': 'k2' }));
    expect(invocations).toBe(2);
  });

  test('Uint8Array bodies round-trip through cache via base64', async () => {
    const cache = new InMemoryCache();
    let invocations = 0;
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const handler = idempotent({ cache })(() => {
      invocations++;
      return { status: 200, body: bytes, contentType: 'application/octet-stream' };
    });
    const r1 = await handler(makeReq({ 'idempotency-key': 'k-bin' }));
    expect(r1.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(r1.body as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
    const r2 = await handler(makeReq({ 'idempotency-key': 'k-bin' }));
    expect(r2.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(r2.body as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
    expect(invocations).toBe(1);
  });
});

describe('idempotent — concurrency', () => {
  test('concurrent requests with same key: one runs handler, other(s) get 409', async () => {
    const cache = new InMemoryCache();
    let invocations = 0;
    const handler = idempotent({ cache })(async () => {
      invocations++;
      // Hold the handler open so the second concurrent request sees in-flight.
      await Bun.sleep(20);
      return complete(Status.OK, { ok: true });
    });
    const both = await Promise.all([
      handler(makeReq({ 'idempotency-key': 'race' })),
      handler(makeReq({ 'idempotency-key': 'race' })),
    ]);
    const statuses = both.map((r) => r.status).sort();
    expect(statuses).toEqual([Status.OK, Status.Conflict]);
    expect(invocations).toBe(1);
  });
});

describe('idempotent — missing header policy', () => {
  test('default (reject): no header → 400', async () => {
    const cache = new InMemoryCache();
    const handler = idempotent({ cache })(() => complete(Status.OK, {}));
    const r = await handler(makeReq({}));
    expect(r.status).toBe(Status.BadRequest);
  });

  test('pass-through: no header → handler runs', async () => {
    const cache = new InMemoryCache();
    let ran = 0;
    const handler = idempotent({ cache, missingHeader: 'pass-through' })(() => {
      ran++;
      return complete(Status.OK, {});
    });
    await handler(makeReq({}));
    expect(ran).toBe(1);
  });
});

describe('idempotent — error path', () => {
  test('handler throw → in-flight marker is released so retries can succeed', async () => {
    const cache = new InMemoryCache();
    let attempt = 0;
    const handler = idempotent({ cache })(() => {
      attempt++;
      if (attempt === 1) throw new Error('transient');
      return complete(Status.OK, { ok: true });
    });
    await expect(handler(makeReq({ 'idempotency-key': 'rec' }))).rejects.toThrow();
    // After failure, the marker is dropped → retry runs the handler again.
    const second = await handler(makeReq({ 'idempotency-key': 'rec' }));
    expect(second.status).toBe(200);
    expect(attempt).toBe(2);
  });
});

describe('idempotent — TTL / config guards', () => {
  test('TTL is honoured: after expiry, handler runs anew', async () => {
    const cache = new InMemoryCache();
    let ran = 0;
    const handler = idempotent({ cache, ttlMs: 30 })(() => {
      ran++;
      return complete(Status.OK, { n: ran });
    });
    await handler(makeReq({ 'idempotency-key': 'short' }));
    await Bun.sleep(50);
    await handler(makeReq({ 'idempotency-key': 'short' }));
    expect(ran).toBe(2);
  });

  test('rejects invalid TTL', () => {
    const cache = new InMemoryCache();
    expect(() => idempotent({ cache, ttlMs: 0 })).toThrow();
    expect(() => idempotent({ cache, ttlMs: -1 })).toThrow();
  });
});
