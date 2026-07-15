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
});
