import { describe, expect, test } from 'bun:test';
import { resolveStaticPath } from '../../../../src/http/static/StaticPath.js';

const ROOT = '/srv/www';
const deny = (rest: string): boolean => resolveStaticPath(ROOT, rest, { dotfiles: 'deny' }).ok === false;
const allow = (rest: string): boolean => resolveStaticPath(ROOT, rest, { dotfiles: 'allow' }).ok === false;

describe('resolveStaticPath — traversal defence', () => {
  test('rejects .. traversal in every encoding', () => {
    for (const vec of [
      '../etc/passwd',
      '..%2fetc',
      '%2e%2e%2fetc',
      '%2e%2e/etc',
      '%252e%252e%252fetc', // double-encoded
      'a/../../b',
      '..\\windows',
      '..%5cwindows',
    ]) {
      expect(deny(vec)).toBe(true);
    }
  });

  test('rejects absolute paths', () => {
    expect(deny('/etc/passwd')).toBe(true);
    expect(deny('\\etc')).toBe(true);
    expect(deny('C:\\windows')).toBe(true);
    expect(deny('C:/windows')).toBe(true);
  });

  test('rejects NUL bytes (raw and encoded)', () => {
    expect(deny('a\0b')).toBe(true);
    expect(deny('a%00b')).toBe(true);
  });

  test('rejects colon segments (NTFS alternate data streams / drives)', () => {
    expect(deny('index.html::$DATA')).toBe(true);
  });

  test('rejects empty interior segments', () => {
    expect(deny('a//b')).toBe(true);
  });

  test('applies the dotfile policy', () => {
    expect(deny('.env')).toBe(true);
    expect(allow('.env')).toBe(false); // allowed under dotfiles:'allow'
    expect(deny('dir/.secret/x')).toBe(true);
  });

  test('accepts a normal nested path', () => {
    const resolved = resolveStaticPath(ROOT, 'css/site.css', { dotfiles: 'deny' });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.fsPath).toContain('site.css');
  });

  test('accepts an empty rest (the directory root)', () => {
    expect(resolveStaticPath(ROOT, '', { dotfiles: 'deny' }).ok).toBe(true);
  });

  test('keeps a literal percent that is not valid encoding', () => {
    // decodeURIComponent('50%.txt') throws → kept verbatim, served as a normal file
    expect(resolveStaticPath(ROOT, '50%.txt', { dotfiles: 'deny' }).ok).toBe(true);
  });
});
