import { describe, expect, test } from 'bun:test';
import { requestTimeout } from '../../../../src/http/middleware/Timeout.js';
import { TimeoutOptions } from '../../../../src/http/middleware/TimeoutOptions.js';
import { Status, type HttpRequest } from '../../../../src/http/types.js';

const request: HttpRequest = { method: 'GET', path: '/', headers: {}, query: {}, params: {}, body: null };
const delay = <T>(ms: number, value: T): Promise<T> => new Promise((r) => setTimeout(() => r(value), ms));

describe('requestTimeout', () => {
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
    const mw = requestTimeout(TimeoutOptions.create().withMs(10).withOnTimeout(() => ({ status: Status.BadGateway, body: 'gone' })));
    const response = await mw(request, async () => delay(100, { status: Status.OK, body: 'slow' }));
    expect(response.status).toBe(Status.BadGateway);
  });

  test('a late handler rejection after timeout does not surface as unhandled', async () => {
    const response = await requestTimeout(10)(request, async () => { await delay(50, null); throw new Error('late'); });
    expect(response.status).toBe(Status.ServiceUnavailable);
    // give the late rejection time to fire; the middleware swallows it.
    await delay(80, null);
  });
});
