import { describe, expect, test } from 'bun:test';
import { ActorPath } from '../../src/ActorPath.js';
import { ActorRef } from '../../src/ActorRef.js';
import {
  ActorKilledError,
  AskTimeoutError,
  DeadLetter,
  Kill,
  PoisonPill,
  ReceiveTimeout,
  Terminated,
} from '../../src/SystemMessages.js';

class DummyRef extends ActorRef<unknown> {
  readonly path: ActorPath;
  constructor(name: string) {
    super();
    this.path = new ActorPath('', null, 'sys').child(name);
  }
  tell(): void {}
}

describe('PoisonPill', () => {
  test('is a singleton', () => {
    expect(PoisonPill.instance).toBe(PoisonPill.instance);
  });
  test('toString is "PoisonPill"', () => {
    expect(PoisonPill.instance.toString()).toBe('PoisonPill');
  });
});

describe('Kill', () => {
  test('is a singleton', () => {
    expect(Kill.instance).toBe(Kill.instance);
  });
  test('toString is "Kill"', () => {
    expect(Kill.instance.toString()).toBe('Kill');
  });
});

describe('ReceiveTimeout', () => {
  test('is a singleton', () => {
    expect(ReceiveTimeout.instance).toBe(ReceiveTimeout.instance);
  });
  test('toString is "ReceiveTimeout"', () => {
    expect(ReceiveTimeout.instance.toString()).toBe('ReceiveTimeout');
  });
});

describe('Terminated', () => {
  test('carries the actor ref and defaults for flags', () => {
    const ref = new DummyRef('foo');
    const terminated = new Terminated(ref);
    expect(terminated.actor).toBe(ref);
    expect(terminated.existenceConfirmed).toBe(true);
    expect(terminated.addressTerminated).toBe(false);
  });
  test('toString embeds the actor path', () => {
    const ref = new DummyRef('foo');
    expect(new Terminated(ref).toString()).toContain(ref.path.toString());
  });
  test('flags can be overridden', () => {
    const ref = new DummyRef('foo');
    const terminated = new Terminated(ref, false, true);
    expect(terminated.existenceConfirmed).toBe(false);
    expect(terminated.addressTerminated).toBe(true);
  });
});

describe('DeadLetter', () => {
  test('captures message, sender, recipient', () => {
    const sender = new DummyRef('from');
    const recipient = new DummyRef('to');
    const dl = new DeadLetter({ cmd: 'ping' }, sender, recipient);
    expect(dl.message).toEqual({ cmd: 'ping' });
    expect(dl.sender).toBe(sender);
    expect(dl.recipient).toBe(recipient);
  });

  test('toString renders "none" for null sender', () => {
    const recipient = new DummyRef('to');
    const dl = new DeadLetter('msg', null, recipient);
    expect(dl.toString()).toContain('none');
    expect(dl.toString()).toContain(recipient.path.toString());
  });
});

describe('ActorKilledError', () => {
  test('is an Error with the right name and message', () => {
    const error = new ActorKilledError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ActorKilledError');
    expect(error.message).toBe('Kill');
  });
});

describe('AskTimeoutError', () => {
  test('carries the provided message and is instanceof Error', () => {
    const error = new AskTimeoutError('timed out after 500ms');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AskTimeoutError);
    expect(error.name).toBe('AskTimeoutError');
    expect(error.message).toBe('timed out after 500ms');
  });
});
