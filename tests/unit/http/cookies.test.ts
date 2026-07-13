import { describe, expect, test } from 'bun:test';
import { parseCookies, serializeCookie } from '../../../src/http/cookies.js';

describe('parseCookies', () => {
  test('returns an empty map for undefined / empty input', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  test('parses multiple pairs and trims whitespace', () => {
    expect(parseCookies('a=1; b=2;c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });

  test('first occurrence of a name wins', () => {
    expect(parseCookies('x=first; x=second')).toEqual({ x: 'first' });
  });

  test('strips one layer of surrounding double quotes', () => {
    expect(parseCookies('q="quoted value"')).toEqual({ q: 'quoted value' });
  });

  test('percent-decodes values, keeping raw on decode failure', () => {
    expect(parseCookies('e=a%20b')).toEqual({ e: 'a b' });
    expect(parseCookies('bad=%zz')).toEqual({ bad: '%zz' });
  });

  test('skips malformed pairs (no "=")', () => {
    expect(parseCookies('good=1; garbage; also=2')).toEqual({ good: '1', also: '2' });
  });

  test('caps the number of accepted pairs at 128', () => {
    const header = Array.from({ length: 200 }, (_, i) => `k${i}=${i}`).join('; ');
    expect(Object.keys(parseCookies(header))).toHaveLength(128);
  });
});

describe('serializeCookie', () => {
  test('serialises name/value with attributes', () => {
    const out = serializeCookie('sid', 'abc', {
      maxAgeSeconds: 3600,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
    expect(out).toBe('sid=abc; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax');
  });

  test('accepts a base64url-ish value (dots, dashes, underscores)', () => {
    expect(serializeCookie('t', 'aB9-_.xY')).toBe('t=aB9-_.xY');
  });

  test('rejects an invalid cookie name', () => {
    expect(() => serializeCookie('bad name', 'v')).toThrow(/invalid cookie name/);
  });

  test('rejects a value with a header-injection attempt', () => {
    expect(() => serializeCookie('a', 'x\r\nSet-Cookie: y=z')).toThrow(/illegal character/);
    expect(() => serializeCookie('a', 'has;semicolon')).toThrow(/illegal character/);
    expect(() => serializeCookie('a', 'quote"here')).toThrow(/illegal character/);
  });

  test('SameSite=None requires Secure', () => {
    expect(() => serializeCookie('a', 'b', { sameSite: 'none' })).toThrow(/SameSite=None requires Secure/);
    expect(serializeCookie('a', 'b', { sameSite: 'none', secure: true })).toContain('SameSite=None');
  });

  test('__Secure- prefix requires Secure', () => {
    expect(() => serializeCookie('__Secure-x', 'v')).toThrow(/__Secure-/);
    expect(serializeCookie('__Secure-x', 'v', { secure: true })).toContain('Secure');
  });

  test('__Host- prefix requires Secure, Path=/, and no Domain', () => {
    expect(() => serializeCookie('__Host-x', 'v', { secure: true })).toThrow(/__Host-/); // no Path
    expect(() => serializeCookie('__Host-x', 'v', { secure: true, path: '/', domain: 'x.com' })).toThrow(/__Host-/);
    expect(serializeCookie('__Host-x', 'v', { secure: true, path: '/' })).toBe('__Host-x=v; Path=/; Secure');
  });

  test('rejects a non-integer Max-Age', () => {
    expect(() => serializeCookie('a', 'b', { maxAgeSeconds: 1.5 })).toThrow(/integer/);
  });
});
