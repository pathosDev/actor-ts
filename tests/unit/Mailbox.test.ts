import { describe, expect, test } from 'bun:test';
import { Mailbox, type Envelope } from '../../src/internal/Mailbox.js';

function env<T>(message: T): Envelope<T> {
  return { message, sender: null };
}

describe('Mailbox', () => {
  test('starts empty', () => {
    const mailbox = new Mailbox<string>();
    expect(mailbox.hasMessages()).toBe(false);
    expect(mailbox.hasUserMessages()).toBe(false);
    expect(mailbox.hasSystemMessages()).toBe(false);
    expect(mailbox.size).toBe(0);
    expect(mailbox.suspended).toBe(false);
  });

  test('enqueue → dequeueUser preserves FIFO order', () => {
    const mailbox = new Mailbox<number>();
    mailbox.enqueue(env(1)); mailbox.enqueue(env(2)); mailbox.enqueue(env(3));
    expect(mailbox.size).toBe(3);
    expect(mailbox.dequeueUser()?.message).toBe(1);
    expect(mailbox.dequeueUser()?.message).toBe(2);
    expect(mailbox.dequeueUser()?.message).toBe(3);
    expect(mailbox.dequeueUser()).toBeUndefined();
  });

  test('enqueueSystem → dequeueSystem preserves FIFO order', () => {
    const mailbox = new Mailbox<string>();
    mailbox.enqueueSystem(env('a')); mailbox.enqueueSystem(env('b'));
    expect(mailbox.dequeueSystem()?.message).toBe('a');
    expect(mailbox.dequeueSystem()?.message).toBe('b');
    expect(mailbox.dequeueSystem()).toBeUndefined();
  });

  test('hasMessages reflects either queue but respects suspend', () => {
    const mailbox = new Mailbox<string>();
    mailbox.enqueue(env('x'));
    expect(mailbox.hasMessages()).toBe(true);
    mailbox.suspend();
    expect(mailbox.hasMessages()).toBe(false); // user messages gated
    mailbox.enqueueSystem(env('sys'));
    expect(mailbox.hasMessages()).toBe(true); // system bypasses suspend
  });

  test('suspend → dequeueUser returns undefined even with messages', () => {
    const mailbox = new Mailbox<string>();
    mailbox.enqueue(env('x'));
    mailbox.suspend();
    expect(mailbox.dequeueUser()).toBeUndefined();
    expect(mailbox.hasUserMessages()).toBe(true); // queue itself is unchanged
    mailbox.resume();
    expect(mailbox.dequeueUser()?.message).toBe('x');
  });

  test('suspend never blocks dequeueSystem', () => {
    const mailbox = new Mailbox<string>();
    mailbox.enqueueSystem(env('sys'));
    mailbox.suspend();
    expect(mailbox.dequeueSystem()?.message).toBe('sys');
  });

  test('drainUser returns and clears the user queue', () => {
    const mailbox = new Mailbox<number>();
    mailbox.enqueue(env(1)); mailbox.enqueue(env(2));
    const drained = mailbox.drainUser();
    expect(drained.map(e => e.message)).toEqual([1, 2]);
    expect(mailbox.hasUserMessages()).toBe(false);
    expect(mailbox.size).toBe(0);
  });

  test('drainSystem returns and clears the system queue', () => {
    const mailbox = new Mailbox<string>();
    mailbox.enqueueSystem(env('a')); mailbox.enqueueSystem(env('b'));
    const drained = mailbox.drainSystem();
    expect(drained.map(e => e.message)).toEqual(['a', 'b']);
    expect(mailbox.hasSystemMessages()).toBe(false);
  });

  test('resume re-opens user dequeue path', () => {
    const mailbox = new Mailbox<string>();
    mailbox.enqueue(env('a'));
    mailbox.suspend();
    expect(mailbox.dequeueUser()).toBeUndefined();
    mailbox.resume();
    expect(mailbox.suspended).toBe(false);
    expect(mailbox.dequeueUser()?.message).toBe('a');
  });

  test('size tracks user queue only', () => {
    const mailbox = new Mailbox<string>();
    mailbox.enqueue(env('u')); mailbox.enqueueSystem(env('s'));
    expect(mailbox.size).toBe(1);
    mailbox.dequeueUser();
    expect(mailbox.size).toBe(0);
  });

  test('sender is carried through dequeue', () => {
    const fakeSender = { path: { toString: () => 'actor-ts://x/y' } } as never;
    const mailbox = new Mailbox<string>();
    mailbox.enqueue({ message: 'hello', sender: fakeSender });
    const out = mailbox.dequeueUser()!;
    expect(out.sender).toBe(fakeSender);
    expect(out.message).toBe('hello');
  });
});
