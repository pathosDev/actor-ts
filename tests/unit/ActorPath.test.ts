import { describe, expect, test } from 'bun:test';
import { ActorPath } from '../../src/ActorPath.js';

describe('ActorPath', () => {
  test('root path stringifies to actor-ts://<sys>/', () => {
    const path = new ActorPath('', null, 'demo');
    expect(path.toString()).toBe('actor-ts://demo/');
    expect(path.depth()).toBe(0);
    expect(path.elements()).toEqual(['']);
  });

  test('child path appends segment and bumps depth', () => {
    const root = new ActorPath('', null, 'demo');
    const user = root.child('user');
    const foo = user.child('foo');
    const bar = foo.child('bar');

    expect(user.toString()).toBe('actor-ts://demo/user');
    expect(foo.toString()).toBe('actor-ts://demo/user/foo');
    expect(bar.toString()).toBe('actor-ts://demo/user/foo/bar');
    expect(bar.depth()).toBe(3);
    expect(bar.elements()).toEqual(['', 'user', 'foo', 'bar']);
  });

  test('equals compares by full stringified path', () => {
    const pathA = new ActorPath('', null, 'demo').child('user').child('foo');
    const pathB = new ActorPath('', null, 'demo').child('user').child('foo');
    const pathC = new ActorPath('', null, 'other').child('user').child('foo');
    const pathD = new ActorPath('', null, 'demo').child('user').child('bar');
    expect(pathA.equals(pathB)).toBe(true);
    expect(pathA.equals(pathC)).toBe(false);
    expect(pathA.equals(pathD)).toBe(false);
  });

  test('isAncestorOf true for strict ancestors only', () => {
    const root = new ActorPath('', null, 'demo');
    const user = root.child('user');
    const foo = user.child('foo');
    const bar = foo.child('bar');

    expect(root.isAncestorOf(bar)).toBe(true);
    expect(user.isAncestorOf(bar)).toBe(true);
    expect(foo.isAncestorOf(bar)).toBe(true);
    expect(bar.isAncestorOf(foo)).toBe(false);
    expect(bar.isAncestorOf(bar)).toBe(false); // self is not ancestor of self
  });

  test('child preserves systemName and accepts uid', () => {
    const root = new ActorPath('', null, 'my-system');
    const child = root.child('user', 42);
    expect(child.systemName).toBe('my-system');
    expect(child.uid).toBe(42);
    expect(child.parent).toBe(root);
  });

  test('uid default is 0', () => {
    const root = new ActorPath('root');
    const child = root.child('foo');
    expect(child.uid).toBe(0);
  });

  test('elements walks from root to leaf', () => {
    const path = new ActorPath('', null, 'sys')
      .child('a').child('b').child('c');
    expect(path.elements()).toEqual(['', 'a', 'b', 'c']);
  });

  test('systemName defaults to "default" when unset', () => {
    const path = new ActorPath('root');
    expect(path.systemName).toBe('default');
    expect(path.toString()).toBe('actor-ts://default/');
  });

  test('different systemNames produce non-equal paths', () => {
    const pathA = new ActorPath('', null, 'A').child('user');
    const pathB = new ActorPath('', null, 'B').child('user');
    expect(pathA.toString()).not.toBe(pathB.toString());
    expect(pathA.equals(pathB)).toBe(false);
  });
});

describe('ActorPath — name validation (#126, #134)', () => {
  const root = (): ActorPath => new ActorPath('', null, 'demo');
  // Built from its code point so no source-level escaping is involved:
  // a literal backslash here is exactly the kind of thing a rewriting
  // tool turns into a backspace, which would test the wrong rule.
  const BACKSLASH = String.fromCharCode(92);

  test('rejects a path separator, which would forge path structure', () => {
    // A path is rendered by joining segments with "/" and taken apart again by
    // splitting on "/" (RefCodec.parsePathSegments).  So `child('a/b')` used to
    // produce a path indistinguishable from a child `b` of an actor `a` —
    // a collision, and across the cluster wire an impersonation, since the
    // remote side re-splits the string.
    expect(() => root().child('a/b')).toThrow(/path separator/);
    expect(() => root().child(`a${BACKSLASH}b`)).toThrow(/path separator/);
    expect(() => root().child('/etc/passwd')).toThrow(/path separator/);
  });

  test('rejects traversal segments', () => {
    expect(() => root().child('..')).toThrow(/must not be "\." or "\.\."/);
    expect(() => root().child('.')).toThrow(/must not be "\." or "\.\."/);
    // The separator check fires first for a compound traversal, which is fine —
    // what matters is that it is refused at all.
    expect(() => root().child('../../etc')).toThrow();
  });

  test('rejects control characters, which allow log injection', () => {
    // Paths are written to logs and trace spans, so a newline in a name lets a
    // caller forge log lines.
    expect(() => root().child('a\nb')).toThrow(/control characters/);
    expect(() => root().child('a\rb')).toThrow(/control characters/);
    expect(() => root().child('a\tb')).toThrow(/control characters/);
    expect(() => root().child('a\u0000b')).toThrow(/control characters/);
    expect(() => root().child('a\u007fb')).toThrow(/control characters/);
  });

  test('rejects an empty child, which would render an ambiguous segment', () => {
    // parsePathSegments filters empty segments out, so `a//b` would round-trip
    // as `a/b` — the local and remote renderings of one actor disagreeing.
    expect(() => root().child('')).toThrow(/must not be empty/);
  });

  test('the error names the offending name and where it sat', () => {
    expect(() => root().child('a/b')).toThrow(/"a\/b"/);
    expect(() => root().child('a/b')).toThrow(/child of actor-ts:\/\/demo\//);
  });

  test('an empty name is still legal for a root', () => {
    // Relied upon by deadLetters, nobody, ClusterSingletonProxy and TestProbe.
    expect(() => new ActorPath('', null, 'demo')).not.toThrow();
    expect(new ActorPath('', null, 'demo').toString()).toBe('actor-ts://demo/');
  });

  test('ordinary names the framework and users rely on still work', () => {
    for (const name of [
      'user', 'deadLetters', 'nobody', 'routee-1', 'ws-conn-7',
      'singleton-proxy-Counter', 'shard-reply-region-42', 'my_actor',
      'Order.Placed', 'entity#3', 'a b', 'ünïcode', '日本語',
    ]) {
      expect(() => root().child(name), `rejected ${name}`).not.toThrow();
    }
  });
});
