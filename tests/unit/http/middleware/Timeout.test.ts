import { describe, expect, test } from 'bun:test';
import { Config } from '../../../../src/config/Config.js';
import { requestDeadlineOf, requestTimeout } from '../../../../src/http/middleware/Timeout.js';
import { DEFAULT_REQUEST_TIMEOUT_DEADLINE_MS, TimeoutOptions } from '../../../../src/http/middleware/TimeoutOptions.js';
import { compile, complete, get, withMiddleware, type Middleware, type Route } from '../../../../src/http/Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../../../../src/http/Types.js';
import { MAX_TIMER_DELAY_MS } from '../../../../src/util/Constants.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';

const request: HttpRequest = { method: 'GET', path: '/', headers: {}, query: {}, params: {}, body: null };
const ok = (): HttpResponse => complete(Status.OK, 'ok');
/**
 * A slow handler, not a wait: the elapsed time IS what every case here asserts
 * on — whether the middleware's budget expires before the handler resolves.  A
 * poll has nothing to poll for, because the awaited thing is meant not to happen.
 */
const delay = <T>(ms: number, value: T): Promise<T> => new Promise((r) => setTimeout(() => r(value), ms));

describe('requestTimeout', () => {
  test('options that name no deadline arm the named default', async () => {
    // Waiting out 30 s is not a test, so the timer is read where it is armed:
    // the delay handed to setTimeout is the deadline the middleware holds.
    const armed: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, delayMs?: number) => {
      armed.push(delayMs ?? 0);
      return realSetTimeout(handler, delayMs);
    }) as typeof setTimeout;
    try {
      await requestTimeout({})(request, async () => ({ status: Status.OK, body: 'fast' }));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(armed).toEqual([DEFAULT_REQUEST_TIMEOUT_DEADLINE_MS]);
    expect(DEFAULT_REQUEST_TIMEOUT_DEADLINE_MS).toBe(30_000);
  });

  test('a fast handler passes through untouched', async () => {
    const response = await requestTimeout(100)(request, async () => ({ status: Status.OK, body: 'fast' }));
    expect(response.status).toBe(Status.OK);
    expect(response.body).toBe('fast');
  });

  test('a slow handler yields 503', async () => {
    const response = await requestTimeout(20)(request, async () => delay(200, { status: Status.OK, body: 'slow' }));
    expect(response.status).toBe(Status.ServiceUnavailable);
  });

  test('honours a custom onTimeout', async () => {
    const timeoutOptions = TimeoutOptions.create()
      .withDeadlineMs(10)
      .withOnTimeout(() => ({ status: Status.BadGateway, body: 'gone' }));
    const mw = requestTimeout(timeoutOptions);
    const response = await mw(request, async () => delay(100, { status: Status.OK, body: 'slow' }));
    expect(response.status).toBe(Status.BadGateway);
  });

  test('a late handler rejection after timeout does not surface as unhandled', async () => {
    const response = await requestTimeout(10)(request, async () => { await delay(50, null); throw new Error('late'); });
    expect(response.status).toBe(Status.ServiceUnavailable);
    // give the late rejection time to fire; the middleware swallows it.
    await delay(80, null);
  });

  test('a deadline past what a timer can hold is refused, not turned into an instant 503', () => {
    // `setTimeout` arms anything above 2^31 - 1 ms as 1 ms, so such a deadline
    // answered every request 503 within milliseconds — the opposite of the
    // "effectively never" it was written as (#1463).  Refused where the merged
    // deadline is known: when the route tree is compiled, inside bind().
    expect(() => compile(withMiddleware(requestTimeout(MAX_TIMER_DELAY_MS + 1), get(ok)))).toThrow(OptionsError);
    const monthLong = TimeoutOptions.create().withDeadlineMs(2_592_000_000);
    expect(() => compile(withMiddleware(requestTimeout(monthLong), get(ok)))).toThrow(/deadlineMs must be at most/);
  });

  test('the deadline is validated on the merge, not when requestTimeout() is called', () => {
    // The configuration file is a layer of the same merge, and it does not
    // exist until the tree is compiled; validating the options alone first
    // would be a second, earlier verdict on half the answer.
    expect(() => requestTimeout(-1)).not.toThrow();
    expect(() => compile(withMiddleware(requestTimeout(-1), get(ok)))).toThrow(/deadlineMs/);
  });

  test('requestTimeout() takes no argument at all — the deadline then comes from the config or the default', async () => {
    const endpoint = compile(withMiddleware(requestTimeout(), get(ok)))[0]!;
    if (endpoint.kind !== 'http') throw new Error(`expected an http route, got ${endpoint.kind}`);
    expect((await endpoint.handler(request)).status).toBe(Status.OK);
  });

  test('the ceiling itself is a deadline that does not fire early', async () => {
    // The inclusive side of the bound: the largest value a timer holds is a
    // real deadline, so a handler well inside it answers for itself.
    const response = await requestTimeout(MAX_TIMER_DELAY_MS)(request, async () => delay(30, { status: Status.OK, body: 'in time' }));
    expect(response.status).toBe(Status.OK);
  });
});

/**
 * #1487 — the middleware the resolve hook returns says what deadline it holds,
 * so `compile()` can record it on the endpoint and the server can keep its
 * connection open at least that long.  It is the *resolved* middleware that
 * knows: options, the configuration and the built-in default are only merged
 * there.
 */
describe('requestTimeout — the deadline it answers at, once compile() resolved it (#1487)', () => {
  const endpointDeadline = (route: Route, config?: Config): number | undefined => compile(route, [], config)[0]!.requestDeadlineMs;

  test('the resolved middleware carries the merged deadline: options over the configuration over the built-in', () => {
    const config = Config.parseString('actor-ts.http.request-timeout.deadline = 2s');

    expect(endpointDeadline(withMiddleware(requestTimeout(), get(ok)), config)).toBe(2_000);
    expect(endpointDeadline(withMiddleware(requestTimeout(14_000), get(ok)), config)).toBe(14_000);
    const timeoutOptions = TimeoutOptions.create().withDeadlineMs(9_000);
    expect(endpointDeadline(withMiddleware(requestTimeout(timeoutOptions), get(ok)), config)).toBe(9_000);
    expect(endpointDeadline(withMiddleware(requestTimeout(), get(ok)))).toBe(DEFAULT_REQUEST_TIMEOUT_DEADLINE_MS);
  });

  test('the value requestTimeout() returns carries none — it has not merged anything yet', () => {
    expect(requestDeadlineOf(requestTimeout(5_000))).toBeUndefined();
    expect(requestDeadlineOf(requestTimeout())).toBeUndefined();
  });

  test('no other middleware can claim one — not by a registered symbol, not by a field', () => {
    const plain: Middleware = (_request, next) => next();
    const registered = Object.assign((_request: HttpRequest, next: () => Promise<HttpResponse>) => next(), {
      [Symbol.for('actor-ts.request-deadline')]: 999_000,
    }) as Middleware;
    const named = Object.assign((_request: HttpRequest, next: () => Promise<HttpResponse>) => next(), {
      requestDeadlineMs: 999_000,
      deadlineMs: 999_000,
    }) as Middleware;

    for (const middleware of [plain, registered, named]) {
      expect(requestDeadlineOf(middleware)).toBeUndefined();
      expect(endpointDeadline(withMiddleware(middleware, get(ok)))).toBeUndefined();
    }
  });
});
