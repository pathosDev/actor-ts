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
    const ref = new RecordingRef<string>('r');
    ref.send('hi');
    expect(ref.received).toEqual([{ message: 'hi', sender: null }]);
  });

  test('stop sends PoisonPill', () => {
    const ref = new RecordingRef<unknown>('r');
    ref.stop();
    expect(ref.received.length).toBe(1);
    expect(ref.received[0]!.message).toBe(PoisonPill.instance);
    expect(ref.received[0]!.sender).toBeNull();
  });

  test('kill sends Kill', () => {
    const ref = new RecordingRef<unknown>('r');
    ref.kill();
    expect(ref.received.length).toBe(1);
    expect(ref.received[0]!.message).toBe(Kill.instance);
  });

  test('toString matches path.toString()', () => {
    const ref = new RecordingRef('r');
    expect(ref.toString()).toBe(ref.path.toString());
  });

  test('equals compares by path string, not object identity', () => {
    const refA = new RecordingRef('same');
    const refB = new RecordingRef('same');
    const refC = new RecordingRef('different');
    expect(refA.equals(refB)).toBe(true);
    expect(refA.equals(refC)).toBe(false);
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
