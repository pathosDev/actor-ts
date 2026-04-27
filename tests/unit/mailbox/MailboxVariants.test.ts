import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Props } from '../../../src/Props.js';
import {
  BoundedMailbox,
  MailboxFullError,
  PriorityMailbox,
} from '../../../src/mailbox/index.js';
import { TestKit } from '../../../src/testkit/TestKit.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('BoundedMailbox — overflow policies', () => {
  test('drop-head replaces the oldest queued message', () => {
    const mbox = new BoundedMailbox<string>({ capacity: 3, overflow: 'drop-head' });
    for (const s of ['a', 'b', 'c', 'd', 'e']) mbox.enqueue({ message: s, sender: null });
    expect(mbox.size).toBe(3);
    const drained = mbox.drainUser().map(e => e.message);
    expect(drained).toEqual(['c', 'd', 'e']);
    expect(mbox.droppedCount).toBe(2);
  });

  test('drop-new discards the incoming message when full', () => {
    const mbox = new BoundedMailbox<string>({ capacity: 2, overflow: 'drop-new' });
    for (const s of ['a', 'b', 'c', 'd']) mbox.enqueue({ message: s, sender: null });
    const drained = mbox.drainUser().map(e => e.message);
    expect(drained).toEqual(['a', 'b']);
    expect(mbox.droppedCount).toBe(2);
  });

  test('reject throws MailboxFullError (default)', () => {
    const mbox = new BoundedMailbox<string>({ capacity: 2 });
    mbox.enqueue({ message: 'a', sender: null });
    mbox.enqueue({ message: 'b', sender: null });
    expect(() => mbox.enqueue({ message: 'c', sender: null })).toThrow(MailboxFullError);
  });

  test('capacity < 1 throws in constructor', () => {
    expect(() => new BoundedMailbox({ capacity: 0 })).toThrow(/capacity/);
  });
});

describe('PriorityMailbox', () => {
  test('higher priority (lower number) dequeues first', () => {
    const mbox = new PriorityMailbox<{ kind: string }>({
      priorityFor: (m) => m.kind === 'urgent' ? 0 : m.kind === 'normal' ? 10 : 20,
    });
    for (const m of [
      { kind: 'low' }, { kind: 'normal' }, { kind: 'urgent' },
      { kind: 'low' }, { kind: 'urgent' },
    ]) {
      mbox.enqueue({ message: m, sender: null });
    }
    const order: string[] = [];
    while (mbox.hasUserMessages()) order.push(mbox.dequeueUser()!.message.kind);
    expect(order).toEqual(['urgent', 'urgent', 'normal', 'low', 'low']);
  });

  test('equal-priority messages stay FIFO', () => {
    const mbox = new PriorityMailbox<string>({ priorityFor: () => 5 });
    for (const s of ['1', '2', '3', '4']) mbox.enqueue({ message: s, sender: null });
    const order: string[] = [];
    while (mbox.hasUserMessages()) order.push(mbox.dequeueUser()!.message);
    expect(order).toEqual(['1', '2', '3', '4']);
  });

  test('drainUser returns all messages in priority order', () => {
    const mbox = new PriorityMailbox<number>({ priorityFor: (n) => n });
    for (const n of [5, 1, 3, 2, 4]) mbox.enqueue({ message: n, sender: null });
    const drained = mbox.drainUser().map(e => e.message);
    expect(drained).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('Props.withMailbox — end-to-end via actor', () => {
  test('actor uses the custom priority mailbox', async () => {
    const kit = TestKit.create('mbox-pri', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = kit.createTestProbe<string>();

    class Worker extends Actor<{ label: string; pri: number }> {
      override onReceive(m: { label: string; pri: number }): void { probe.tell(m.label); }
    }
    const props = Props.create(() => new Worker())
      .withMailbox<{ label: string; pri: number }>(
        () => new PriorityMailbox({ priorityFor: (m: { label: string; pri: number }) => m.pri }) as never,
      );
    const ref = kit.system.actorOf(props);

    // Send burst while the actor is still being initialised so multiple
    // messages sit in the mailbox at once.
    for (const m of [
      { label: 'c', pri: 5 },
      { label: 'a', pri: 1 },
      { label: 'd', pri: 9 },
      { label: 'b', pri: 3 },
    ]) ref.tell(m);

    // Give the scheduler time to drain.
    await sleep(50);
    const got: string[] = [];
    while (true) {
      try { got.push(await probe.receiveOne(100) as string); }
      catch { break; }
    }
    // Priorities 1,3,5,9 → labels a,b,c,d.
    expect(got).toEqual(['a', 'b', 'c', 'd']);
    await kit.system.terminate();
  });

  test('bounded mailbox with drop-new tolerates a burst without throwing', async () => {
    const kit = TestKit.create('mbox-bnd', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const received: number[] = [];

    class Slow extends Actor<number> {
      override async onReceive(m: number): Promise<void> {
        await sleep(10);
        received.push(m);
      }
    }
    const props = Props.create(() => new Slow())
      .withMailbox(() => new BoundedMailbox<number>({ capacity: 3, overflow: 'drop-new' }) as never);
    const ref = kit.system.actorOf(props);

    for (let i = 0; i < 8; i++) ref.tell(i);
    await sleep(200);

    // At most (capacity + already-processed) messages will land — the
    // remainder is dropped silently by drop-new.
    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThanOrEqual(8);
    await kit.system.terminate();
  });
});
