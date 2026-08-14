import { describe, expect, test } from 'bun:test';
import { contentTypeFor, DEFAULT_MIME_TYPES } from '../../../src/http/MimeTypes.js';

describe('contentTypeFor', () => {
  test('adds a UTF-8 charset to text-ish types', () => {
    expect(contentTypeFor('app.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('style.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('data.json')).toBe('application/json; charset=utf-8');
    expect(contentTypeFor('logo.svg')).toBe('image/svg+xml; charset=utf-8');
  });

  test('leaves binary types without a charset', () => {
    expect(contentTypeFor('logo.png')).toBe('image/png');
    expect(contentTypeFor('movie.mp4')).toBe('video/mp4');
    expect(contentTypeFor('font.woff2')).toBe('font/woff2');
  });

  test('is case-insensitive on the extension', () => {
    expect(contentTypeFor('IMG.PNG')).toBe('image/png');
  });

  test('accepts a bare extension, with or without a dot', () => {
    expect(contentTypeFor('css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('.css')).toBe('text/css; charset=utf-8');
  });

  test('uses the last extension of a multi-dot name', () => {
    expect(contentTypeFor('bundle.min.js')).toBe('text/javascript; charset=utf-8');
  });

  test('falls back to octet-stream for unknown or missing extensions', () => {
    expect(contentTypeFor('archive.xyz')).toBe('application/octet-stream');
    expect(contentTypeFor('/some/dir/noext')).toBe('application/octet-stream');
  });

  test('overrides win verbatim (charset included by the caller)', () => {
    expect(contentTypeFor('weird.dat', { dat: 'application/x-custom' })).toBe('application/x-custom');
  });

  test('the default map is frozen', () => {
    expect(Object.isFrozen(DEFAULT_MIME_TYPES)).toBe(true);
  });

  // An extension is attacker-controlled — it comes off the request path — and a
  // bare `MAP[ext]` read resolves through Object.prototype.  Only `constructor`
  // and `__proto__` are reachable: every other inherited member is mixed-case
  // and cannot survive the lowercasing in extensionOf.
  test('an extension naming a prototype member falls back to octet-stream', () => {
    expect(contentTypeFor('report.constructor')).toBe('application/octet-stream');
    expect(contentTypeFor('payload.__proto__')).toBe('application/octet-stream');
    expect(contentTypeFor('/static/report.CONSTRUCTOR')).toBe('application/octet-stream');
    expect(contentTypeFor('constructor')).toBe('application/octet-stream');
    expect(contentTypeFor('__proto__')).toBe('application/octet-stream');
  });

  // The override map is a *second*, separate read that never reaches the
  // default-map path, so it needs its own case: before the fix this one
  // returned the `Object` function itself out of a `: string` signature,
  // and `__proto__` returned Object.prototype, neither of them throwing.
  test('an override map cannot leak a prototype member either', () => {
    const overrides = { dat: 'application/x-custom' };
    expect(contentTypeFor('report.constructor', overrides)).toBe('application/octet-stream');
    expect(contentTypeFor('payload.__proto__', overrides)).toBe('application/octet-stream');
    expect(contentTypeFor('weird.dat', overrides)).toBe('application/x-custom');
  });

  // The guard is own-property, not a refusal list — a caller who deliberately
  // maps one of those names gets it back, exactly like any other extension.
  test('an own override key with a prototype-member name still wins', () => {
    expect(contentTypeFor('report.constructor', { constructor: 'application/x-own' })).toBe('application/x-own');
    // A literal `{ __proto__: … }` sets the prototype instead of an own key;
    // JSON.parse is the way to get a genuine own `__proto__` data property.
    const ownProtoOverrides = JSON.parse('{"__proto__":"application/x-own-proto"}') as Record<string, string>;
    expect(Object.hasOwn(ownProtoOverrides, '__proto__')).toBe(true);
    expect(contentTypeFor('payload.__proto__', ownProtoOverrides)).toBe('application/x-own-proto');
  });

  // The `: string` return type was only TypeScript's word: overrides arrive
  // from the caller, so an untyped or deserialized map can carry anything.
  test('always returns a string, whatever an override map holds', () => {
    const nonStringOverrides = { dat: 42 } as unknown as Record<string, string>;
    expect(contentTypeFor('weird.dat', nonStringOverrides)).toBe('application/octet-stream');
    const emptyOverrides = { css: '' };
    expect(contentTypeFor('style.css', emptyOverrides)).toBe('text/css; charset=utf-8');
    for (const path of ['report.constructor', 'payload.__proto__', 'archive.xyz', 'app.js']) {
      expect(typeof contentTypeFor(path)).toBe('string');
    }
  });

  // Defence in depth for downstream callers: DEFAULT_MIME_TYPES is public API,
  // and `DEFAULT_MIME_TYPES[ext]` in someone else's file is the same defect.
  test('the default map has no prototype, so a direct read is safe too', () => {
    expect(Object.getPrototypeOf(DEFAULT_MIME_TYPES)).toBeNull();
    expect(DEFAULT_MIME_TYPES['constructor']).toBeUndefined();
    expect(DEFAULT_MIME_TYPES['__proto__']).toBeUndefined();
    expect(DEFAULT_MIME_TYPES['toString']).toBeUndefined();
    // …and the table itself is intact.
    expect(DEFAULT_MIME_TYPES['css']).toBe('text/css');
    expect(Object.keys(DEFAULT_MIME_TYPES).length).toBeGreaterThan(40);
  });
});
