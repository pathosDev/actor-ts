import { describe, expect, test } from 'bun:test';
import { ActorPath } from '../../src/ActorPath.js';
import { ActorRef, Nobody, NobodyRef } from '../../src/ActorRef.js';
import { Kill, PoisonPill } from '../../src/SystemMessages.js';

class RecordingRef<T = unknown> extends ActorRef<T> {
  readonly path: ActorPath;
  readonly received: Array<{ message: T; sender: ActorRef | null | undefined }> = [];
  constructor(name: string) {
    super();
    this.path = new ActorPath('', null, 'test').child(name);
  }
  tell(message: T, sender?: ActorRef | null): void {
    this.received.push({ message, sender });
  }
}

describe('ActorRef base', () => {
  test('send forwards to tell with null sender', () => {
    const r = new RecordingRef<string>('r');
    r.send('hi');
    expect(r.received).toEqual([{ message: 'hi', sender: null }]);
  });

  test('stop sends PoisonPill', () => {
    const r = new RecordingRef<unknown>('r');
    r.stop();
    expect(r.received.length).toBe(1);
    expect(r.received[0]!.message).toBe(PoisonPill.instance);
    expect(r.received[0]!.sender).toBeNull();
  });

  test('kill sends Kill', () => {
    const r = new RecordingRef<unknown>('r');
    r.kill();
    expect(r.received.length).toBe(1);
    expect(r.received[0]!.message).toBe(Kill.instance);
  });

  test('toString matches path.toString()', () => {
    const r = new RecordingRef('r');
    expect(r.toString()).toBe(r.path.toString());
  });

  test('equals compares by path string, not object identity', () => {
    const a = new RecordingRef('same');
    const b = new RecordingRef('same');
    const c = new RecordingRef('different');
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});

describe('NobodyRef', () => {
  test('Nobody is the NobodyRef singleton', () => {
    expect(Nobody).toBe(NobodyRef.instance);
  });

  test('tell drops silently', () => {
    expect(() => Nobody.tell('anything')).not.toThrow();
  });

  test('has a dedicated path under "<nobody>" system', () => {
    expect(Nobody.path.systemName).toBe('<nobody>');
    expect(Nobody.path.name).toBe('nobody');
  });

  test('stop and kill also drop silently', () => {
    expect(() => Nobody.stop()).not.toThrow();
    expect(() => Nobody.kill()).not.toThrow();
  });

  test('equals two Nobody references (both map to the same path)', () => {
    expect(Nobody.equals(Nobody)).toBe(true);
    expect(Nobody.equals(NobodyRef.instance)).toBe(true);
  });
});
