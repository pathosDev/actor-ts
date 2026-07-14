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
