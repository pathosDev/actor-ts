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

/* ------------------------- security: request-body binding -------------------------- */

function reqWithBody(headers: Record<string, string>, bodyStr: string): HttpRequest {
  return {
    method: 'POST',
    path: '/payments',
    headers,
    query: {},
    params: {},
    body: new TextEncoder().encode(bodyStr),
  };
}

describe('idempotent — request-body fingerprint binding', () => {
  /**
   * **Exploit walkthrough (pre-fix).**  The middleware cached the
   * response keyed solely by the `Idempotency-Key` header — the
   * request body wasn't part of the cache lookup.  An attacker
   * (or a buggy client) could send:
   *
   *   POST /payments  Idempotency-Key: abc  body: {to: alice, amount: 100}
   *
   * see the response (200 + `{txId: 1}`), then immediately resend:
   *
   *   POST /payments  Idempotency-Key: abc  body: {to: bob,   amount: 9999}
   *
   * The middleware would find the cached response (keyed on `abc`)
   * and replay it verbatim — the second request silently received
   * the first's response, and the second request's body was DROPPED
   * without the handler ever seeing it.  Effect:
   *   - If the attacker can guess/observe a victim's idempotency
   *     key, they can poison the cache and steal the victim's
   *     response on their next legitimate attempt.
   *   - If a buggy client reuses a key for two different requests,
   *     the second is silently dropped — operationally invisible
   *     until a customer complains.
   *
   * Stripe's spec explicitly calls this out: same key + different
   * body → reject with 422 Unprocessable Entity.  Fix: compute
   * SHA-256 fingerprint of `method + path + body` on every request;
   * store it with the cached response; on replay verify the
   * fingerprints match.
   */
  test('exploit: same key + different body → 422 (not the cached response)', async () => {
    const cache = new InMemoryCache();
    let invocations = 0;
    const handler = idempotent({ cache })(() => {
      invocations++;
      return complete(Status.OK, { txId: invocations });
    });

    // First request: handler runs, body fingerprint stored.
    const r1 = await handler(reqWithBody({ 'idempotency-key': 'abc' },
      '{"to":"alice","amount":100}'));
    expect(r1.status).toBe(200);
    expect(invocations).toBe(1);

    // Second request: same key, DIFFERENT body.  Defense: 422.
    const r2 = await handler(reqWithBody({ 'idempotency-key': 'abc' },
      '{"to":"bob","amount":9999}'));
    expect(r2.status).toBe(422);
    expect(invocations).toBe(1);   // handler NOT invoked
    // Critically: r2's body does NOT include r1's response — no
    // information leak between requests.
    expect(JSON.stringify(r2.body)).not.toContain('txId');
  });

  test('exploit: same key + path-only difference → 422 (method+path is in the fingerprint)', async () => {
    const cache = new InMemoryCache();
    const handler = idempotent({ cache })(() => complete(Status.OK, { ok: true }));

    const r1Req: HttpRequest = {
      method: 'POST', path: '/payments', headers: { 'idempotency-key': 'k1' },
      query: {}, params: {}, body: new TextEncoder().encode('{"x":1}'),
    };
    await handler(r1Req);

    const r2Req: HttpRequest = {
      method: 'POST', path: '/refunds', headers: { 'idempotency-key': 'k1' },
      query: {}, params: {}, body: new TextEncoder().encode('{"x":1}'),  // same body
    };
    const r2 = await handler(r2Req);
    expect(r2.status).toBe(422);  // different path → fingerprint mismatch
  });

  test('regression: same key + same body → replays cached response (no 422)', async () => {
    const cache = new InMemoryCache();
    let invocations = 0;
    const handler = idempotent({ cache })(() => {
      invocations++;
      return complete(Status.OK, { id: invocations });
    });

    const body = '{"amount":42}';
    const r1 = await handler(reqWithBody({ 'idempotency-key': 'same' }, body));
    const r2 = await handler(reqWithBody({ 'idempotency-key': 'same' }, body));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body).toEqual(r2.body);   // SAME response replayed
    expect(invocations).toBe(1);         // handler called once
  });

  test('regression: empty-body request still gets fingerprinted (no crash, no false 422)', async () => {
    const cache = new InMemoryCache();
    const handler = idempotent({ cache })(() => complete(Status.OK, { ok: true }));

    const r1 = await handler(makeReq({ 'idempotency-key': 'no-body' }, null));
    const r2 = await handler(makeReq({ 'idempotency-key': 'no-body' }, null));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);   // both succeed; no 422 for null===null
  });

  test('different keys + different bodies → all independent (no interference)', async () => {
    const cache = new InMemoryCache();
    let invocations = 0;
    const handler = idempotent({ cache })(() => {
      invocations++;
      return complete(Status.OK, { n: invocations });
    });

    await handler(reqWithBody({ 'idempotency-key': 'k1' }, '{"a":1}'));
    await handler(reqWithBody({ 'idempotency-key': 'k2' }, '{"a":2}'));
    await handler(reqWithBody({ 'idempotency-key': 'k3' }, '{"a":3}'));
    expect(invocations).toBe(3);
  });
});
