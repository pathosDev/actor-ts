import { describe, expect, test } from 'bun:test';
import { Mailbox, type Envelope } from '../../src/internal/Mailbox.js';

function env<T>(message: T): Envelope<T> {
  return { message, sender: null };
}

describe('Mailbox', () => {
  test('starts empty', () => {
    const m = new Mailbox<string>();
    expect(m.hasMessages()).toBe(false);
    expect(m.hasUserMessages()).toBe(false);
    expect(m.hasSystemMessages()).toBe(false);
    expect(m.size).toBe(0);
    expect(m.suspended).toBe(false);
  });

  test('enqueue → dequeueUser preserves FIFO order', () => {
    const m = new Mailbox<number>();
    m.enqueue(env(1)); m.enqueue(env(2)); m.enqueue(env(3));
    expect(m.size).toBe(3);
    expect(m.dequeueUser()?.message).toBe(1);
    expect(m.dequeueUser()?.message).toBe(2);
    expect(m.dequeueUser()?.message).toBe(3);
    expect(m.dequeueUser()).toBeUndefined();
  });

  test('enqueueSystem → dequeueSystem preserves FIFO order', () => {
    const m = new Mailbox<string>();
    m.enqueueSystem(env('a')); m.enqueueSystem(env('b'));
    expect(m.dequeueSystem()?.message).toBe('a');
    expect(m.dequeueSystem()?.message).toBe('b');
    expect(m.dequeueSystem()).toBeUndefined();
  });

  test('hasMessages reflects either queue but respects suspend', () => {
    const m = new Mailbox<string>();
    m.enqueue(env('x'));
    expect(m.hasMessages()).toBe(true);
    m.suspend();
    expect(m.hasMessages()).toBe(false); // user messages gated
    m.enqueueSystem(env('sys'));
    expect(m.hasMessages()).toBe(true); // system bypasses suspend
  });

  test('suspend → dequeueUser returns undefined even with messages', () => {
    const m = new Mailbox<string>();
    m.enqueue(env('x'));
    m.suspend();
    expect(m.dequeueUser()).toBeUndefined();
    expect(m.hasUserMessages()).toBe(true); // queue itself is unchanged
    m.resume();
    expect(m.dequeueUser()?.message).toBe('x');
  });

  test('suspend never blocks dequeueSystem', () => {
    const m = new Mailbox<string>();
    m.enqueueSystem(env('sys'));
    m.suspend();
    expect(m.dequeueSystem()?.message).toBe('sys');
  });

  test('drainUser returns and clears the user queue', () => {
    const m = new Mailbox<number>();
    m.enqueue(env(1)); m.enqueue(env(2));
    const drained = m.drainUser();
    expect(drained.map(e => e.message)).toEqual([1, 2]);
    expect(m.hasUserMessages()).toBe(false);
    expect(m.size).toBe(0);
  });

  test('drainSystem returns and clears the system queue', () => {
    const m = new Mailbox<string>();
    m.enqueueSystem(env('a')); m.enqueueSystem(env('b'));
    const drained = m.drainSystem();
    expect(drained.map(e => e.message)).toEqual(['a', 'b']);
    expect(m.hasSystemMessages()).toBe(false);
  });

  test('resume re-opens user dequeue path', () => {
    const m = new Mailbox<string>();
    m.enqueue(env('a'));
    m.suspend();
    expect(m.dequeueUser()).toBeUndefined();
    m.resume();
    expect(m.suspended).toBe(false);
    expect(m.dequeueUser()?.message).toBe('a');
  });

  test('size tracks user queue only', () => {
    const m = new Mailbox<string>();
    m.enqueue(env('u')); m.enqueueSystem(env('s'));
    expect(m.size).toBe(1);
    m.dequeueUser();
    expect(m.size).toBe(0);
  });

  test('sender is carried through dequeue', () => {
    const fakeSender = { path: { toString: () => 'akka://x/y' } } as never;
    const m = new Mailbox<string>();
    m.enqueue({ message: 'hello', sender: fakeSender });
    const out = m.dequeueUser()!;
    expect(out.sender).toBe(fakeSender);
    expect(out.message).toBe('hello');
  });
});
