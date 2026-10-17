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

  test('the refusal names a path pattern, not the block that happened to write it', () => {
    // Two blocks share the grammar (actor-ts.parallelism.offload and
    // actor-ts.deployment, #868), so "offload pattern" was wrong for one of
    // them; each block names itself in the error it wraps around this one.
    expect(() => compilePathPattern('user/*')).toThrow(/^path pattern "user\/\*" must start with '\/'$/);
  });

  /**
   * Every pattern and path the cases above assert, with the answer they
   * assert — the table the segment matcher is held to.
   */
  const ASSERTED_CASES: ReadonlyArray<readonly [string, string, boolean]> = [
    ['/user/*', '/user/a', true],
    ['/user/*', '/user/$anonymous-1', true],
    ['/user/*', '/user/a/b', false],
    ['/user/*', '/user', false],
    ['/user/*', '/system/a', false],
    ['/user/resize-*', '/user/resize-1', true],
    ['/user/resize-*', '/user/resize-', true],
    ['/user/resize-*', '/user/resizer', false],
    ['/user/resize-*', '/user/resize-1/child', false],
    ['/user/**', '/user/a', true],
    ['/user/**', '/user/a/b/c', true],
    ['/user/**', '/user', false],
    ['/user/**', '/system/a', false],
    ['/user/a.b+c', '/user/a.b+c', true],
    ['/user/a.b+c', '/user/aXbbc', false],
  ];

  test('the segment matcher answers every case above exactly as matches() does', () => {
    for (const [source, path, expected] of ASSERTED_CASES) {
      const pattern = compilePathPattern(source);
      const segments = path.split('/').filter((segment) => segment.length > 0);
      expect({ source, path, matches: pattern.matches(path), matchesSegments: pattern.matchesSegments(segments) })
        .toEqual({ source, path, matches: expected, matchesSegments: expected });
    }
  });

  test('a literal segment is its whole name, never a name it prefixes or is prefixed by', () => {
    expect(compilePathPattern('/user/a').matches('/user/ab')).toBe(false);
    expect(compilePathPattern('/user/ab').matches('/user/a')).toBe(false);
    expect(compilePathPattern('/user/pool/*').matches('/user/poolside/worker-1')).toBe(false);
    expect(compilePathPattern('/system/**').matches('/systemd/x')).toBe(false);
    expect(compilePathPattern('/user/$anonymous-1').matches('/user/$anonymous-1')).toBe(true);
  });

  test('the segment count rules a pattern out before any segment is compared, and never rules a match out', () => {
    // Without `**` a pattern takes exactly as many segments as it has; with
    // it, at least as many, since `**` takes one or more.
    expect(compilePathPattern('/user/*').matchesSegments(['user'])).toBe(false);
    expect(compilePathPattern('/user/*').matchesSegments(['user', 'a', 'b'])).toBe(false);
    expect(compilePathPattern('/user/*/**').matchesSegments(['user', 'a'])).toBe(false);
    expect(compilePathPattern('/user/*/**').matchesSegments(['user', 'a', 'b'])).toBe(true);
    expect(compilePathPattern('/user/**/inbox').matchesSegments(['user', 'a', 'b', 'inbox'])).toBe(true);
    expect(compilePathPattern('/user/**/inbox').matchesSegments(['user', 'inbox'])).toBe(false);
  });

  test('the segment matcher takes its segments as already split, and the root as none', () => {
    // A caller that holds an actor's segments tests them against every
    // pattern in a block, so splitting again per pattern is the cost this
    // entry point exists to avoid — a segment is one name, never re-split.
    expect(compilePathPattern('/user/a').matchesSegments(['user/a'])).toBe(false);
    expect(compilePathPattern('/user/a').matchesSegments(['user', 'a'])).toBe(true);
    // `**` is one or more segments here too: the root, with none, is not matched.
    expect(compilePathPattern('/**').matchesSegments([])).toBe(false);
    expect(compilePathPattern('/user/**').matchesSegments(['user'])).toBe(false);
    expect(compilePathPattern('/user/**').matchesSegments(['user', 'pool', 'worker-1'])).toBe(true);
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
