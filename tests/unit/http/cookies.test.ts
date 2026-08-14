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
    expect(serializeCookie('t', 'aB9-_.xY')).toBe('t=aB9-_.xY; Path=/; HttpOnly; Secure; SameSite=Lax');
  });

  // #626 — the two-argument call is the one an application reaches for
  // first, so it has to be the safe one rather than a bare `name=value`.
  test('defaults to Secure, HttpOnly, SameSite=Lax and Path=/', () => {
    expect(serializeCookie('session', 'abc')).toBe('session=abc; Path=/; HttpOnly; Secure; SameSite=Lax');
  });

  test('the strict defaults satisfy the __Host- prefix with no attributes at all', () => {
    expect(serializeCookie('__Host-session', 'abc')).toBe('__Host-session=abc; Path=/; HttpOnly; Secure; SameSite=Lax');
  });

  test('each strict default is opt-out-able with an explicit false / value', () => {
    const out = serializeCookie('dev', 'v', { secure: false, httpOnly: false, sameSite: 'strict', path: '/app' });
    expect(out).toBe('dev=v; Path=/app; SameSite=Strict');
  });

  test('rejects an invalid cookie name', () => {
    expect(() => serializeCookie('bad name', 'v')).toThrow(/invalid cookie name/);
  });

  test('rejects a value with a header-injection attempt', () => {
    expect(() => serializeCookie('a', 'x\r\nSet-Cookie: y=z')).toThrow(/illegal character/);
    expect(() => serializeCookie('a', 'has;semicolon')).toThrow(/illegal character/);
    expect(() => serializeCookie('a', 'quote"here')).toThrow(/illegal character/);
  });

  // The Secure-related throws now fire only on an explicit `secure: false`:
  // omitting the attribute resolves to Secure, so there is no cookie left
  // for them to catch.
  test('SameSite=None requires Secure', () => {
    expect(() => serializeCookie('a', 'b', { sameSite: 'none', secure: false })).toThrow(/SameSite=None requires Secure/);
    expect(serializeCookie('a', 'b', { sameSite: 'none' })).toContain('SameSite=None');
  });

  test('__Secure- prefix requires Secure', () => {
    expect(() => serializeCookie('__Secure-x', 'v', { secure: false })).toThrow(/__Secure-/);
    expect(serializeCookie('__Secure-x', 'v')).toContain('Secure');
  });

  test('__Host- prefix requires Secure, Path=/, and no Domain', () => {
    expect(() => serializeCookie('__Host-x', 'v', { secure: false })).toThrow(/__Host-/);
    expect(() => serializeCookie('__Host-x', 'v', { path: '/nested' })).toThrow(/__Host-/);
    expect(() => serializeCookie('__Host-x', 'v', { domain: 'x.com' })).toThrow(/__Host-/);
    expect(serializeCookie('__Host-x', 'v', { secure: true, path: '/' }))
      .toBe('__Host-x=v; Path=/; HttpOnly; Secure; SameSite=Lax');
  });

  test('rejects a non-integer Max-Age', () => {
    expect(() => serializeCookie('a', 'b', { maxAgeSeconds: 1.5 })).toThrow(/integer/);
  });

  test('rejects an invalid expires Date', () => {
    expect(() => serializeCookie('a', 'b', { expires: new Date('nonsense') })).toThrow(/valid Date/);
    expect(serializeCookie('a', 'b', { expires: new Date(0) })).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });

  // #626 — Path and Domain reach the header verbatim, so an unvalidated one
  // appends a second attribute rather than a second header.  RFC 6265 §5.3
  // keeps the LAST Domain, and `Domain=` is emitted before `Path=`, so a
  // Domain smuggled through `path` would override a legitimate one.
  describe('attribute-injection guards', () => {
    const smuggledDomain = '/;Domain=evil.example';

    test('a Path smuggling a second attribute is rejected', () => {
      expect(() => serializeCookie('a', 'b', { path: smuggledDomain })).toThrow(/invalid cookie path/);
      expect(() => serializeCookie('a', 'b', { path: '/ok', domain: 'good.example' })).not.toThrow();
    });

    test.each([
      ['a smuggled Domain attribute', '/;Domain=evil.example'],
      ['a smuggled flag', '/; Secure'],
      ['a comma (header-list delimiter)', '/a,b'],
      ['a CRLF header-injection attempt', '/x\r\nSet-Cookie: y=z'],
      ['a bare newline', '/x\ny'],
      ['no leading slash', 'relative'],
      ['an empty path', ''],
      ['a raw non-ASCII character', '/café'],
    ])('rejects a Path with %s', (_label, path) => {
      expect(() => serializeCookie('a', 'b', { path })).toThrow(/invalid cookie path/);
    });

    test.each([
      ['the root', '/'],
      ['a nested path', '/api/v1/things'],
      ['a percent-encoded segment', '/caf%C3%A9/menu'],
      ['a query-ish suffix some apps set', '/app~1'],
    ])('accepts a Path that is %s', (_label, path) => {
      expect(serializeCookie('a', 'b', { path })).toContain(`Path=${path}`);
    });

    test.each([
      ['a smuggled attribute', 'evil.example; Path=/'],
      ['a smuggled attribute without a space', 'evil.example;Path=/'],
      ['a comma-separated second host', 'a.example,b.example'],
      ['a CRLF header-injection attempt', 'evil.example\r\nSet-Cookie: y=z'],
      ['an empty string', ''],
      ['a leading hyphen label', '-bad.example'],
      ['a trailing dot', 'example.com.'],
      ['an empty label', 'a..example'],
      ['a raw internationalised name', 'bücher.example'],
      ['a whole URL', 'https://example.com'],
    ])('rejects a Domain with %s', (_label, domain) => {
      expect(() => serializeCookie('a', 'b', { domain })).toThrow(/invalid cookie domain/);
    });

    test.each([
      ['a plain host', 'example.com'],
      ['the legacy leading dot', '.example.com'],
      ['a single label', 'localhost'],
      ['punycode', 'xn--bcher-kva.example'],
      ['hyphens inside labels', 'sub.a-b.example.co.uk'],
    ])('accepts a Domain that is %s', (_label, domain) => {
      expect(serializeCookie('a', 'b', { domain })).toContain(`Domain=${domain}`);
    });

    test('Domain is emitted before Path, so neither can be appended after the other', () => {
      const out = serializeCookie('a', 'b', { domain: 'example.com', path: '/x' });
      expect(out).toBe('a=b; Domain=example.com; Path=/x; HttpOnly; Secure; SameSite=Lax');
      expect(out.match(/Domain=/g)).toHaveLength(1);
    });
  });
});
