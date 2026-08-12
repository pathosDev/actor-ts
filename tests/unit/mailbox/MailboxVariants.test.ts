import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import {
  BoundedMailbox,
  BoundedMailboxOptions,
  MailboxFullError,
  PriorityMailbox,
} from '../../../src/mailbox/index.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

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

  test('drop-head still enforces the bound while suspended — #407', () => {
    const mbox = new BoundedMailbox<string>({ capacity: 3, overflow: 'drop-head' });
    for (const s of ['a', 'b', 'c']) mbox.enqueue({ message: s, sender: null });
    expect(mbox.size).toBe(3);

    // Suspension is the supervision window — the actor has failed and is
    // waiting on its parent's decision while messages keep arriving, which is
    // when a bound matters most.  `dequeueUser` refuses while suspended, so
    // the drop-head arm used to remove nothing, grow the queue past capacity,
    // and count the phantom drop anyway.
    mbox.suspend();
    for (const s of ['d', 'e', 'f']) mbox.enqueue({ message: s, sender: null });
    expect(mbox.size).toBe(3);

    mbox.resume();
    expect(mbox.drainUser().map(e => e.message)).toEqual(['d', 'e', 'f']);
  });

  test('drop-head counts only drops that really happened — #407', () => {
    // droppedCount and onDrop feed actor_mailbox_dropped_total, so they have to
    // match the number of messages actually evicted, suspended or not.
    const drops: string[] = [];
    const mbox = new BoundedMailbox<string>({
      capacity: 2,
      overflow: 'drop-head',
      onDrop: (reason) => drops.push(reason),
    });
    for (const s of ['a', 'b']) mbox.enqueue({ message: s, sender: null });
    mbox.suspend();
    for (const s of ['c', 'd', 'e']) mbox.enqueue({ message: s, sender: null });
    mbox.resume();

    const survivors = mbox.drainUser().map(e => e.message);
    expect(survivors).toEqual(['d', 'e']);
    expect(mbox.droppedCount).toBe(3);
    expect(drops).toEqual(['drop-head', 'drop-head', 'drop-head']);
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

// Options plumbing: builder parity + OptionsError validation, replacing the
// old bare-Error capacity guard and covering the previously-unvalidated
// overflow enum and missing capacity.
describe('BoundedMailbox — options validation', () => {
  test('builder form is equivalent to a plain object', () => {
    const mbox = new BoundedMailbox<string>(BoundedMailboxOptions.create()
      .withCapacity(2)
      .withOverflow('drop-new'));
    for (const s of ['a', 'b', 'c']) mbox.enqueue({ message: s, sender: null });
    expect(mbox.size).toBe(2);
    expect(mbox.droppedCount).toBe(1);
  });

  test('rejects a non-positive / non-integer capacity with OptionsError', () => {
    expect(() => new BoundedMailbox({ capacity: 0 })).toThrow(OptionsError);
    expect(() => new BoundedMailbox({ capacity: -3 })).toThrow(/capacity/);
    expect(() => new BoundedMailbox({ capacity: 1.5 })).toThrow(/capacity/);
  });

  test('rejects an unknown overflow policy with OptionsError', () => {
    expect(() => new BoundedMailbox({ capacity: 1, overflow: 'drop-all' as never })).toThrow(OptionsError);
    expect(() => new BoundedMailbox({ capacity: 1, overflow: 'drop-all' as never })).toThrow(/overflow/);
  });

  test('rejects a missing capacity with OptionsError (builder path)', () => {
    expect(() => new BoundedMailbox(BoundedMailboxOptions.create().withOverflow('reject'))).toThrow(OptionsError);
    expect(() => new BoundedMailbox({})).toThrow(/capacity/);
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
      const value = (i * 37 + 13) % 100;
      xs.push(value);
      mbox.enqueue({ message: value, sender: null });
    }
    const sorted = [...xs].sort((a, b) => a - b);
    const drained = mbox.drainUser().map((e) => e.message);
    expect(drained).toEqual(sorted);
  });
});

describe('ActorOptions.withMailbox — end-to-end via actor', () => {
  test('actor uses the custom priority mailbox', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('mbox-pri', kitOptions);
    const probe = kit.createTestProbe<string>();

    class Worker extends Actor<{ label: string; pri: number }> {
      override onReceive(m: { label: string; pri: number }): void { probe.tell(m.label); }
    }
    const options = ActorOptions.create<{ label: string; pri: number }>()
      .withMailbox(
        () => new PriorityMailbox({ priorityFor: (m: { label: string; pri: number }) => m.pri }) as never,
      );
    const ref = kit.system.spawnAnonymous(Worker, options);

    // Send burst while the actor is still being initialised so multiple
    // messages sit in the mailbox at once.
    for (const m of [
      { label: 'c', pri: 5 },
      { label: 'a', pri: 1 },
      { label: 'd', pri: 9 },
      { label: 'b', pri: 3 },
    ]) ref.tell(m);

    // Wait for the actor to have drained all four into the probe.  The loop
    // below then reads them out with a short per-item timeout, which was the
    // real hazard: a slow run could truncate `got` and the ordering assertion
    // would fail on a short array rather than on a wrong order.
    await awaitCondition(() => probe.messageCount === 4, {
      timeoutMs: 4_000,
      label: 'all four prioritised messages reached the probe',
    });
    const got: string[] = [];
    while (true) {
      try { got.push(await probe.receiveOne(100) as string); }
      catch { break; }
    }
    // Priorities 1,3,5,9 → labels a,b,c,d.
    expect(got).toEqual(['a', 'b', 'c', 'd']);
    await kit.system.terminate();
  });

  test('withMailboxOverflow reaches the mailbox — reject throws at the tell site', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('mbox-overflow-option', kitOptions);

    class Slow extends Actor<number> {
      override async onReceive(_m: number): Promise<void> { await sleep(50); }
    }
    const options = ActorOptions.create<number>()
      .withMailboxCapacity(2)
      .withMailboxOverflow('reject');
    const ref = kit.system.spawnAnonymous(Slow, options);

    // Capacity 2 and a handler that will not keep up: the third tell finds a
    // full mailbox.  `reject` surfaces synchronously at the sender rather
    // than discarding quietly, which is the whole reason to choose it.
    expect(() => { for (let i = 0; i < 32; i++) ref.tell(i); }).toThrow(MailboxFullError);
    await kit.system.terminate();
  });

  test('the default mailbox is unbounded — 20 000 queued, every one delivered in order (#1148)', async () => {
    // The #310 guard this replaces asserted `instanceof BoundedMailbox` and
    // `droppedCount === 0` on a mailbox nothing had been sent to, so it
    // stayed green for any default at all — capacity 3 with drop-new
    // included (#1020).  This one asserts on DELIVERED MESSAGES, which no
    // bounded default can fake: the actor is wedged on a latch, twice the
    // old 10 000 ceiling is queued behind it, and then every message is
    // required back in order.  Capacity 3 / drop-new fails it, 10 000 /
    // drop-head fails it, and a PriorityMailbox fails the ordering.
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('mbox-default', kitOptions);

    let release: () => void = () => {};
    const latch = new Promise<void>((resolve) => { release = resolve; });
    const handled: number[] = [];

    class Sink extends Actor<number> {
      override async onReceive(n: number): Promise<void> {
        if (n === 0) await latch;
        handled.push(n);
      }
    }
    const ref = kit.system.spawnAnonymous(Sink);

    const COUNT = 20_000;
    for (let i = 0; i < COUNT; i++) ref.tell(i);

    const cell = (ref as unknown as {
      getCell(): { _mailboxForTest(): { size: number } };
    }).getCell();
    const mailbox = cell._mailboxForTest();
    // Read the depth BEFORE releasing the latch: message 0 cannot complete,
    // so the queue genuinely holds the rest.  Past the old ceiling is the
    // whole claim.
    expect(mailbox.size).toBeGreaterThan(10_000);
    expect(mailbox).not.toBeInstanceOf(BoundedMailbox);

    release();
    await awaitCondition(() => handled.length === COUNT, {
      timeoutMs: 30_000,
      label: 'every queued message was delivered',
    });
    expect(handled.length).toBe(COUNT);
    expect(handled[0]).toBe(0);
    expect(handled[COUNT - 1]).toBe(COUNT - 1);
    await kit.system.terminate();
  });

  test('a bound is opt-in via withMailboxCapacity, and its drops reach onDrop', async () => {
    // The inverse of the guard above, and the only non-Docker coverage of
    // the `onDrop` -> `actor_mailbox_dropped_total` chain: the cell wires
    // the callback only for the capacity path, never for `withMailbox`.
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('mbox-optin', kitOptions);

    let release: () => void = () => {};
    const latch = new Promise<void>((resolve) => { release = resolve; });

    class Sink extends Actor<number> {
      override async onReceive(n: number): Promise<void> { if (n === 0) await latch; }
    }
    const options = ActorOptions.create<number>().withMailboxCapacity(4);
    const ref = kit.system.spawnAnonymous(Sink, options);

    for (let i = 0; i < 64; i++) ref.tell(i);

    const cell = (ref as unknown as { getCell(): { _mailboxForTest(): unknown } }).getCell();
    const mailbox = cell._mailboxForTest();
    expect(mailbox).toBeInstanceOf(BoundedMailbox);
    const bounded = mailbox as BoundedMailbox<number>;
    expect(bounded.size).toBeLessThanOrEqual(4);
    expect(bounded.droppedCount).toBeGreaterThan(0);

    release();
    await kit.system.terminate();
  });

  test('bounded mailbox with drop-new tolerates a burst without throwing', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('mbox-bnd', kitOptions);
    const received: number[] = [];

    class Slow extends Actor<number> {
      override async onReceive(m: number): Promise<void> {
        await sleep(10);
        received.push(m);
      }
    }
    const options = ActorOptions.create<number>()
      .withMailbox(() => new BoundedMailbox<number>({ capacity: 3, overflow: 'drop-new' }) as never);
    const ref = kit.system.spawnAnonymous(Slow, options);

    for (let i = 0; i < 8; i++) ref.tell(i);
    await sleep(200);

    // At most (capacity + already-processed) messages will land — the
    // remainder is dropped silently by drop-new.
    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThanOrEqual(8);
    await kit.system.terminate();
  });
});
