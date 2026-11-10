import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { remoteActorPath } from '../../../src/cluster/RemoteActorRef.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { PendingRemoteActorRef, type PendingBufferAccount } from '../../../src/parallelism/PendingRemoteActorRef.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { TestProbe } from '../../../src/testkit/TestProbe.js';

/**
 * The pending ref on its own (#1563): what it holds, in what order it lets
 * go, and where the rest ends up.  The target is a probe rather than a
 * worker, because nothing here is about the thread.
 */

function account(capacity: number): PendingBufferAccount & { held: number } {
  const state = {
    held: 0,
    reserve(): boolean {
      if (state.held >= capacity) return false;
      state.held++;
      return true;
    },
    release(count: number): void { state.held -= count; },
  };
  return state;
}

async function withSystem(body: (system: ActorSystem) => Promise<void>): Promise<void> {
  const system = ActorSystem.create('pending', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
  try { await body(system); } finally { await system.terminate(); }
}

describe('PendingRemoteActorRef', () => {
  test('identity is settled from the start, and delivery switches on resolve — in order', () => withSystem(async (system) => {
    const path = remoteActorPath('actor-ts://pending/user/x', 'pending');
    const bookkeeping = account(100);
    const ref = new PendingRemoteActorRef<string>(path, system, bookkeeping);
    expect(ref.path.toString()).toBe('actor-ts://pending/user/x');
    expect(ref.toString()).toBe('actor-ts://pending/user/x');
    expect(ref.equals({ path } as ActorRef)).toBe(true);
    expect(ref.isResolved).toBe(false);

    ref.tell('one');
    ref.tell('two', system.deadLetters);
    expect(bookkeeping.held).toBe(2);

    const target = new TestProbe(system);
    ref._resolve(target as unknown as ActorRef<string>);
    expect(ref.isResolved).toBe(true);
    expect(bookkeeping.held).toBe(0);
    expect(await target.receiveOne()).toBe('one');
    expect(await target.receiveOne()).toBe('two');
    ref.tell('three');
    expect(await target.receiveOne()).toBe('three');
    expect(ref.toString()).toBe(target.toString());
    // A second resolve or a late failure changes nothing.
    ref._fail();
    ref.tell('four');
    expect(await target.receiveOne()).toBe('four');
  }));

  test('past the account’s cap a message is a dead letter naming this ref', () => withSystem(async (system) => {
    const probe = new TestProbe(system);
    system.eventStream.subscribe(probe, DeadLetter);
    const ref = new PendingRemoteActorRef<string>(remoteActorPath('actor-ts://pending/user/y', 'pending'), system, account(1));
    ref.tell('fits');
    ref.tell('does not');
    const letter = await probe.receiveOne() as DeadLetter;
    expect(letter.message).toBe('does not');
    expect(letter.recipient).toBe(ref);
  }));

  test('a failed ref dead-letters what it held, in order, and everything after', () => withSystem(async (system) => {
    const probe = new TestProbe(system);
    system.eventStream.subscribe(probe, DeadLetter);
    const bookkeeping = account(10);
    const ref = new PendingRemoteActorRef<string>(remoteActorPath('actor-ts://pending/user/z', 'pending'), system, bookkeeping);
    ref.tell('a');
    ref.tell('b');
    ref._fail();
    expect(bookkeeping.held).toBe(0);
    expect(ref.isResolved).toBe(false);
    ref.tell('c');
    const letters = await probe.receiveN(3) as DeadLetter[];
    expect(letters.map((letter) => letter.message)).toEqual(['a', 'b', 'c']);
    // Resolving after a failure is a no-op: the ref stays failed.
    ref._resolve(new TestProbe(system) as unknown as ActorRef<string>);
    expect(ref.isResolved).toBe(false);
  }));

  test('an ask through a pending ref arms its deadline from the system, like any ref that can see one', () => withSystem(async (system) => {
    const ref = new PendingRemoteActorRef<{ replyTo?: ActorRef }>(remoteActorPath('actor-ts://pending/user/w', 'pending'), system, account(10));
    expect(ref._defaultAskTimeoutMs()).toBe(system._defaultAskTimeoutMs);
    expect(ref._virtualScheduler()).toBe(system._virtualScheduler);
    const target = new TestProbe(system);
    const answer = ref.ask<string>({});
    ref._resolve(target as unknown as ActorRef<{ replyTo?: ActorRef }>);
    const asked = await target.receiveOne() as { replyTo: ActorRef<string> };
    asked.replyTo.tell('answered');
    expect(await answer).toBe('answered');
  }));
});
