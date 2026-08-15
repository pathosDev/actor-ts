import { describe, expect, test } from 'bun:test';
import { applyHeaders, applyHeadersToError, appendVary, headerDecorator, readHeader } from '../../../../src/http/middleware/Headers.js';
import type { Middleware } from '../../../../src/http/Route.js';
import { HttpError, Status, type HttpRequest, type HttpResponse } from '../../../../src/http/Types.js';

const response = (headers?: Record<string, string>): HttpResponse => ({ status: Status.OK, body: 'x', headers });

const request: HttpRequest = { method: 'GET', path: '/', headers: {}, query: {}, params: {}, body: null };

/** Drive `middleware` over a `next` that throws, and hand back whatever it rethrew. */
const rethrownBy = (middleware: Middleware, error: unknown): Promise<unknown> =>
  Promise.resolve(middleware(request, () => Promise.reject(error))).then(() => null, (rethrown: unknown) => rethrown);

describe('applyHeaders', () => {
  test('adds headers when the response has none', () => {
    expect(applyHeaders(response(), { 'x-a': '1' }).headers).toEqual({ 'x-a': '1' });
  });

  test('does not overwrite a header the response already set (case-insensitive)', () => {
    const out = applyHeaders(response({ 'X-A': 'handler' }), { 'x-a': 'mw' });
    expect(out.headers).toEqual({ 'X-A': 'handler' });
  });

  test('overwrite:true forces the middleware value', () => {
    const out = applyHeaders(response({ 'x-a': 'handler' }), { 'x-a': 'mw' }, { overwrite: true });
    expect(out.headers?.['x-a']).toBe('mw');
  });

  test('overwrite:true replaces a differently-cased key instead of adding a second (#603)', () => {
    const out = applyHeaders(response({ Vary: 'Cookie' }), { vary: 'Cookie, Origin' }, { overwrite: true });
    // Exactly one spelling survives — two would leave the wire bytes to insertion order.
    expect(out.headers).toEqual({ vary: 'Cookie, Origin' });
  });

  test('does not mutate the original response', () => {
    const original = response({ 'x-a': '1' });
    applyHeaders(original, { 'x-b': '2' });
    expect(original.headers).toEqual({ 'x-a': '1' });
  });
});

describe('applyHeadersToError', () => {
  test('an HttpError comes back as a copy carrying the added headers (#606)', () => {
    const thrown = new HttpError(Status.Forbidden, 'CSRF verification failed', { field: 'token' });
    const decorated = applyHeadersToError(thrown, { 'x-frame-options': 'DENY' });
    expect(decorated).toBeInstanceOf(HttpError);
    expect(decorated).not.toBe(thrown);
    const error = decorated as HttpError;
    expect(error.headers).toEqual({ 'x-frame-options': 'DENY' });
    // Everything the error mapping reads must survive the copy.
    expect(error.status).toBe(Status.Forbidden);
    expect(error.message).toBe('CSRF verification failed');
    expect(error.extra).toEqual({ field: 'token' });
  });

  test("the error's own header wins, matched case-insensitively", () => {
    const thrown = new HttpError(Status.Unauthorized, 'no', undefined, { 'WWW-Authenticate': 'Basic', 'X-Frame-Options': 'SAMEORIGIN' });
    const error = applyHeadersToError(thrown, { 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' }) as HttpError;
    expect(error.headers).toEqual({ 'WWW-Authenticate': 'Basic', 'X-Frame-Options': 'SAMEORIGIN', 'referrer-policy': 'no-referrer' });
  });

  test('does not mutate the error it was handed', () => {
    const thrown = new HttpError(Status.Forbidden, 'nope', undefined, { 'retry-after': '1' });
    applyHeadersToError(thrown, { 'x-frame-options': 'DENY' });
    expect(thrown.headers).toEqual({ 'retry-after': '1' });
  });

  test('anything that is not an HttpError comes back untouched', () => {
    const boom = new Error('kaboom');
    expect(applyHeadersToError(boom, { 'x-frame-options': 'DENY' })).toBe(boom);
    expect(applyHeadersToError('a string', { 'x-frame-options': 'DENY' })).toBe('a string');
  });
});

describe('headerDecorator', () => {
  test('stamps its map on a returned response', async () => {
    const decorated = await headerDecorator({ 'x-a': '1' })(request, async () => response());
    expect(decorated.headers?.['x-a']).toBe('1');
  });

  test('stamps its map on a thrown HttpError short-circuit (#606)', async () => {
    const error = await rethrownBy(headerDecorator({ 'x-a': '1' }), new HttpError(Status.Forbidden, 'nope'));
    expect((error as HttpError).headers?.['x-a']).toBe('1');
  });

  test('rethrows a non-HttpError unchanged', async () => {
    const boom = new Error('kaboom');
    expect(await rethrownBy(headerDecorator({ 'x-a': '1' }), boom)).toBe(boom);
  });
});

describe('readHeader', () => {
  test('finds the key whatever case the handler spelled it in (#603)', () => {
    expect(readHeader({ Vary: 'Cookie' }, 'vary')).toBe('Cookie');
    expect(readHeader({ VARY: 'Cookie' }, 'Vary')).toBe('Cookie');
    expect(readHeader({ vary: 'Cookie' }, 'vary')).toBe('Cookie');
  });

  test('returns undefined for a missing header and for an absent record', () => {
    expect(readHeader({ 'x-a': '1' }, 'vary')).toBeUndefined();
    expect(readHeader(undefined, 'vary')).toBeUndefined();
    expect(readHeader({}, 'vary')).toBeUndefined();
  });
});

describe('appendVary', () => {
  test('joins fields when there is no existing value', () => {
    expect(appendVary(undefined, 'Origin', 'Accept')).toBe('Origin, Accept');
  });

  test('merges with an existing value, de-duplicating case-insensitively', () => {
    expect(appendVary('origin', 'Origin', 'Accept-Encoding')).toBe('origin, Accept-Encoding');
  });

  test('ignores empty fields', () => {
    expect(appendVary('  ', 'Origin')).toBe('Origin');
  });
});
