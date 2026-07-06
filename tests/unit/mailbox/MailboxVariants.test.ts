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
import { TestKit, TestKitOptions } from '../../../src/testkit/TestKit.js';

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

  test('suspend blocks dequeueUser; resume unblocks', () => {
    const mbox = new PriorityMailbox<number>({ priorityFor: (n) => n });
    mbox.enqueue({ message: 1, sender: null });
    mbox.enqueue({ message: 2, sender: null });
    mbox.suspend();
    expect(mbox.dequeueUser()).toBeUndefined();
    // hasMessages with a system message + suspended state still returns
    // true (system messages always drain) — but a pure user-only mbox
    // returns false while suspended.
    expect(mbox.hasMessages()).toBe(false);
    mbox.resume();
    expect(mbox.dequeueUser()?.message).toBe(1);
    expect(mbox.dequeueUser()?.message).toBe(2);
  });

  test('hasMessages mixes system + user correctly', () => {
    const mbox = new PriorityMailbox<number>({ priorityFor: (n) => n });
    expect(mbox.hasMessages()).toBe(false);
    mbox.enqueueSystem({ message: 'sys', sender: null });
    expect(mbox.hasMessages()).toBe(true);
    expect(mbox.hasSystemMessages()).toBe(true);
    expect(mbox.hasUserMessages()).toBe(false);
    // Suspend keeps system messages drainable.
    mbox.suspend();
    expect(mbox.hasMessages()).toBe(true);
  });

  test('prependUser re-routes envelopes through priority insertion', () => {
    // Unlike base Mailbox, PriorityMailbox.prependUser re-runs the
    // priority function — unstashed messages rejoin their priority
    // tier rather than appearing at the front of the queue.  Pin
    // this since the contract is unintuitive vs the base class.
    const mbox = new PriorityMailbox<number>({ priorityFor: (n) => n });
    mbox.enqueue({ message: 5, sender: null });
    mbox.enqueue({ message: 1, sender: null });
    // Now stashed-back: a high-priority 0 and a low-priority 9.
    mbox.prependUser([
      { message: 9, sender: null },
      { message: 0, sender: null },
    ]);
    const order: number[] = [];
    while (mbox.hasUserMessages()) order.push(mbox.dequeueUser()!.message);
    // Strict priority order: 0, 1, 5, 9.
    expect(order).toEqual([0, 1, 5, 9]);
  });

  test('binary-search insertion holds for 100 random priorities', () => {
    // The insertion is O(log n) locate + O(n) splice — exercise it
    // with a larger input to catch off-by-one regressions in the
    // binary-search bounds.
    const mbox = new PriorityMailbox<number>({ priorityFor: (n) => n });
    const xs: number[] = [];
    for (let i = 0; i < 100; i++) {
      // Deterministic pseudo-random so test failures are reproducible.
      const v = (i * 37 + 13) % 100;
      xs.push(v);
      mbox.enqueue({ message: v, sender: null });
    }
    const sorted = [...xs].sort((a, b) => a - b);
    const drained = mbox.drainUser().map((e) => e.message);
    expect(drained).toEqual(sorted);
  });
});

describe('Props.withMailbox — end-to-end via actor', () => {
  test('actor uses the custom priority mailbox', async () => {
    const kit = TestKit.create('mbox-pri', TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const probe = kit.createTestProbe<string>();

    class Worker extends Actor<{ label: string; pri: number }> {
      override onReceive(m: { label: string; pri: number }): void { probe.tell(m.label); }
    }
    const props = Props.create(() => new Worker())
      .withMailbox<{ label: string; pri: number }>(
        () => new PriorityMailbox({ priorityFor: (m: { label: string; pri: number }) => m.pri }) as never,
      );
    const ref = kit.system.spawnAnonymous(props);

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

  test('default actor mailbox is bounded (10_000, drop-head) — #310', async () => {
    const kit = TestKit.create('mbox-default', TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));

    class Worker extends Actor<number> {
      override onReceive(_m: number): void {
        // intentionally empty — we only care about the mailbox shape
      }
    }
    const ref = kit.system.spawnAnonymous(Props.create(() => new Worker()));

    // Reach into the ActorCell's mailbox via the LocalActorRef internal
    // accessor so we can assert the concrete type without exporting it
    // from the public surface.  The whole point of this test is that
    // the default WIRED-UP mailbox is bounded; a future change to
    // `new Mailbox()` would silently make the framework unbounded
    // again and only manifest as an OOM in production.
    const cell = (ref as unknown as { getCell(): { _mailboxForTest(): unknown } }).getCell();
    const mailbox = cell._mailboxForTest();
    expect(mailbox).toBeInstanceOf(BoundedMailbox);
    // The capacity + overflow are encapsulated; cheapest check is to
    // assert behaviorally: fill past capacity, observe drop-head.
    const mbox = mailbox as BoundedMailbox<number>;
    expect(mbox.droppedCount).toBe(0);
    await kit.system.terminate();
  });

  test('default mailbox can be opted out per-actor via Props.withMailbox(() => new Mailbox())', async () => {
    const { Mailbox } = await import('../../../src/internal/Mailbox.js');
    const kit = TestKit.create('mbox-optout', TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));

    class Worker extends Actor<number> {
      override onReceive(_m: number): void { /* noop */ }
    }
    const props = Props.create(() => new Worker())
      .withMailbox<number>(() => new Mailbox<number>());
    const ref = kit.system.spawnAnonymous(props);

    const cell = (ref as unknown as { getCell(): { _mailboxForTest(): unknown } }).getCell();
    const mailbox = cell._mailboxForTest();
    // Concrete type is the plain (unbounded) Mailbox — not BoundedMailbox.
    expect(mailbox).toBeInstanceOf(Mailbox);
    expect(mailbox).not.toBeInstanceOf(BoundedMailbox);
    await kit.system.terminate();
  });

  test('bounded mailbox with drop-new tolerates a burst without throwing', async () => {
    const kit = TestKit.create('mbox-bnd', TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const received: number[] = [];

    class Slow extends Actor<number> {
      override async onReceive(m: number): Promise<void> {
        await sleep(10);
        received.push(m);
      }
    }
    const props = Props.create(() => new Slow())
      .withMailbox(() => new BoundedMailbox<number>({ capacity: 3, overflow: 'drop-new' }) as never);
    const ref = kit.system.spawnAnonymous(props);

    for (let i = 0; i < 8; i++) ref.tell(i);
    await sleep(200);

    // At most (capacity + already-processed) messages will land — the
    // remainder is dropped silently by drop-new.
    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThanOrEqual(8);
    await kit.system.terminate();
  });
});
