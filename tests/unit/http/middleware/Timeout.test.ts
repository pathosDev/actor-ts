import { describe, expect, test } from 'bun:test';
import { requestTimeout } from '../../../../src/http/middleware/Timeout.js';
import { TimeoutOptions } from '../../../../src/http/middleware/TimeoutOptions.js';
import { Status, type HttpRequest } from '../../../../src/http/types.js';

const req: HttpRequest = { method: 'GET', path: '/', headers: {}, query: {}, params: {}, body: null };
const delay = <T>(ms: number, value: T): Promise<T> => new Promise((r) => setTimeout(() => r(value), ms));

describe('requestTimeout', () => {
  test('a fast handler passes through untouched', async () => {
    const res = await requestTimeout(100)(req, async () => ({ status: Status.OK, body: 'fast' }));
    expect(res.status).toBe(Status.OK);
    expect(res.body).toBe('fast');
  });

  test('a slow handler yields 503', async () => {
    const res = await requestTimeout(20)(req, async () => delay(200, { status: Status.OK, body: 'slow' }));
    expect(res.status).toBe(Status.ServiceUnavailable);
  });

  test('honours a custom onTimeout', async () => {
    const mw = requestTimeout(TimeoutOptions.create().withMs(10).withOnTimeout(() => ({ status: Status.BadGateway, body: 'gone' })));
    const res = await mw(req, async () => delay(100, { status: Status.OK, body: 'slow' }));
    expect(res.status).toBe(Status.BadGateway);
  });

  test('a late handler rejection after timeout does not surface as unhandled', async () => {
    const res = await requestTimeout(10)(req, async () => { await delay(50, null); throw new Error('late'); });
    expect(res.status).toBe(Status.ServiceUnavailable);
    // give the late rejection time to fire; the middleware swallows it.
    await delay(80, null);
  });
});
