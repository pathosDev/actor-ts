import { describe, expect, test } from 'bun:test';
import { requestTimeout } from '../../../../src/http/middleware/Timeout.js';
import { DEFAULT_REQUEST_TIMEOUT_DEADLINE_MS, TimeoutOptions } from '../../../../src/http/middleware/TimeoutOptions.js';
import { Status, type HttpRequest } from '../../../../src/http/Types.js';
import { MAX_TIMER_DELAY_MS } from '../../../../src/util/Constants.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';

const request: HttpRequest = { method: 'GET', path: '/', headers: {}, query: {}, params: {}, body: null };
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
    // "effectively never" it was written as (#1463).
    expect(() => requestTimeout(MAX_TIMER_DELAY_MS + 1)).toThrow(OptionsError);
    const monthLong = TimeoutOptions.create().withDeadlineMs(2_592_000_000);
    expect(() => requestTimeout(monthLong)).toThrow(/deadlineMs must be at most/);
  });

  test('the ceiling itself is a deadline that does not fire early', async () => {
    // The inclusive side of the bound: the largest value a timer holds is a
    // real deadline, so a handler well inside it answers for itself.
    const response = await requestTimeout(MAX_TIMER_DELAY_MS)(request, async () => delay(30, { status: Status.OK, body: 'in time' }));
    expect(response.status).toBe(Status.OK);
  });
});
