import { describe, expect, test } from 'bun:test';
import { requestId } from '../../../../src/http/middleware/RequestId.js';
import { RequestIdOptions } from '../../../../src/http/middleware/RequestIdOptions.js';
import { HttpError, Status, type HttpRequest, type HttpResponse } from '../../../../src/http/types.js';

const request = (headers: Record<string, string> = {}): HttpRequest => ({
  method: 'GET', path: '/', headers, query: {}, params: {}, body: null,
});

describe('requestId', () => {
  test('generates an id, forwards it to the handler, and echoes it on the response', async () => {
    let seen: string | undefined;
    const response = await requestId()(request(), async (enriched) => {
      seen = enriched?.headers['x-request-id'];
      return { status: Status.OK, body: 'x' };
    });
    expect(seen).toBeTruthy();
    expect(response.headers?.['x-request-id']).toBe(seen!);
  });

  test('accepts a well-formed incoming id', async () => {
    const response = await requestId()(request({ 'x-request-id': 'trace-abc_123' }), async () => ({ status: Status.OK, body: 'x' }));
    expect(response.headers?.['x-request-id']).toBe('trace-abc_123');
  });

  test('replaces a hostile incoming id', async () => {
    const hostile = 'x\r\nSet-Cookie: y=z';
    const response = await requestId()(request({ 'x-request-id': hostile }), async () => ({ status: Status.OK, body: 'x' }));
    expect(response.headers?.['x-request-id']).not.toBe(hostile);
    expect(response.headers?.['x-request-id']).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  });

  test('trustIncoming=false always generates', async () => {
    const mw = requestId(RequestIdOptions.create().withTrustIncoming(false).withGenerate(() => 'fixed'));
    const response = await mw(request({ 'x-request-id': 'client-supplied' }), async () => ({ status: Status.OK, body: 'x' }));
    expect(response.headers?.['x-request-id']).toBe('fixed');
  });

  test('does not overwrite a handler-set id header', async () => {
    const response: HttpResponse = await requestId()(request(), async () => ({ status: Status.OK, body: 'x', headers: { 'x-request-id': 'handler' } }));
    expect(response.headers?.['x-request-id']).toBe('handler');
  });

  test('echoes the id on a thrown HttpError short-circuit (#606)', async () => {
    // A rejection is precisely the response whose id an operator later
    // needs to find the log line for.
    const mw = requestId(RequestIdOptions.create().withGenerate(() => 'fixed'));
    let seen: string | undefined;
    const rethrown: unknown = await Promise.resolve(mw(request(), async (enriched) => {
      seen = enriched?.headers['x-request-id'];
      throw new HttpError(Status.Forbidden, 'CSRF verification failed');
    })).then(() => null, (error: unknown) => error);
    expect(seen).toBe('fixed');
    expect(rethrown).toBeInstanceOf(HttpError);
    expect((rethrown as HttpError).headers?.['x-request-id']).toBe('fixed');
  });

  test('a non-HttpError throw is rethrown untouched — the generic 500 carries no id', async () => {
    const boom = new Error('kaboom');
    const rethrown: unknown = await Promise.resolve(requestId()(request(), () => Promise.reject(boom)))
      .then(() => null, (error: unknown) => error);
    expect(rethrown).toBe(boom);
  });
});
