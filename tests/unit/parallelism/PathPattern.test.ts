import { describe, expect, test } from 'bun:test';
import { compilePathPattern, reachesSystemTree } from '../../../src/parallelism/PathPattern.js';

describe('offload path patterns (#1563)', () => {
  test('`*` is one whole segment, so /user/* names top-level actors and nothing below them', () => {
    const pattern = compilePathPattern('/user/*');
    expect(pattern.matches('/user/a')).toBe(true);
    expect(pattern.matches('/user/$anonymous-1')).toBe(true);
    expect(pattern.matches('/user/a/b')).toBe(false);
    expect(pattern.matches('/user')).toBe(false);
    expect(pattern.matches('/system/a')).toBe(false);
  });

  test('`*` inside a segment is a glob over that segment', () => {
    const pattern = compilePathPattern('/user/resize-*');
    expect(pattern.matches('/user/resize-1')).toBe(true);
    expect(pattern.matches('/user/resize-')).toBe(true);
    expect(pattern.matches('/user/resizer')).toBe(false);
    expect(pattern.matches('/user/resize-1/child')).toBe(false);
  });

  test('a segment that is exactly `**` is one or more segments', () => {
    const pattern = compilePathPattern('/user/**');
    expect(pattern.matches('/user/a')).toBe(true);
    expect(pattern.matches('/user/a/b/c')).toBe(true);
    expect(pattern.matches('/user')).toBe(false);
    expect(pattern.matches('/system/a')).toBe(false);
  });

  test('regex characters in a segment are literal', () => {
    const pattern = compilePathPattern('/user/a.b+c');
    expect(pattern.matches('/user/a.b+c')).toBe(true);
    expect(pattern.matches('/user/aXbbc')).toBe(false);
  });

  test('a pattern has to be an absolute path', () => {
    expect(() => compilePathPattern('user/*')).toThrow(/must start with '\/'/);
  });

  test('reachesSystemTree: every spelling that could name a system actor, and none that cannot', () => {
    for (const source of ['/system', '/system/*', '/system/**', '/system/sharding/*', '/*', '/**', '/s*']) {
      expect({ source, reaches: reachesSystemTree(compilePathPattern(source)) }).toEqual({ source, reaches: true });
    }
    for (const source of ['/user/*', '/user/**', '/user/resize-*', '/systemd/*']) {
      expect({ source, reaches: reachesSystemTree(compilePathPattern(source)) }).toEqual({ source, reaches: false });
    }
  });
});
