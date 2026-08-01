import { describe, expect, test } from 'bun:test';
import { applyHeaders, appendVary } from '../../../../src/http/middleware/headers.js';
import { Status, type HttpResponse } from '../../../../src/http/types.js';

const response = (headers?: Record<string, string>): HttpResponse => ({ status: Status.OK, body: 'x', headers });

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

  test('does not mutate the original response', () => {
    const original = response({ 'x-a': '1' });
    applyHeaders(original, { 'x-b': '2' });
    expect(original.headers).toEqual({ 'x-a': '1' });
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
