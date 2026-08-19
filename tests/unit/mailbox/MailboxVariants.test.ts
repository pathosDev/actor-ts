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
  PriorityMailboxOptions,
  type MailboxDropReason,
} from '../../../src/mailbox/index.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

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

// #647 — a priority mailbox could not be bounded at all, and `ActorOptions`
// forbids `withMailbox` + `withMailboxCapacity`, so there was no route to one.
describe('PriorityMailbox — capacity and overflow', () => {
  test('unbounded by default — a capacity is something you ask for', () => {
    const mbox = new PriorityMailbox<number>({ priorityFor: (n) => n });
    for (let i = 0; i < 20_000; i++) mbox.enqueue({ message: i, sender: null });
    expect(mbox.size).toBe(20_000);
    expect(mbox.droppedCount).toBe(0);
  });

  test('drop-lowest-priority sheds the tail, not the head', () => {
    // The head is the message the priority function called most important —
    // dropping it would defeat the reason for choosing this mailbox.
    const mbox = new PriorityMailbox<number>({
      priorityFor: (n) => n,
      capacity: 3,
      overflow: 'drop-lowest-priority',
    });
    for (const n of [1, 2, 3]) mbox.enqueue({ message: n, sender: null });
    mbox.enqueue({ message: 0, sender: null });
    expect(mbox.size).toBe(3);
    expect(mbox.drainUser().map((e) => e.message)).toEqual([0, 1, 2]);
    expect(mbox.droppedCount).toBe(1);
  });

  test('drop-lowest-priority reports drop-new when the arrival is the least important', () => {
    // Insert-then-evict lets the arrival compete on the same terms, and the
    // identity check then reports honestly rather than claiming a queued
    // message was destroyed.
    const reasons: MailboxDropReason[] = [];
    const mbox = new PriorityMailbox<number>({
      priorityFor: (n) => n,
      capacity: 2,
      overflow: 'drop-lowest-priority',
      onDrop: (reason) => reasons.push(reason),
    });
    for (const n of [1, 2]) mbox.enqueue({ message: n, sender: null });
    mbox.enqueue({ message: 9, sender: null });   // worse than everything queued
    mbox.enqueue({ message: 0, sender: null });   // better than everything queued
    expect(mbox.drainUser().map((e) => e.message)).toEqual([0, 1]);
    expect(reasons).toEqual(['drop-new', 'drop-head']);
  });

  test('drop-lowest-priority keeps the older of an equal-priority pair', () => {
    const mbox = new PriorityMailbox<string>({
      priorityFor: () => 5,
      capacity: 2,
      overflow: 'drop-lowest-priority',
    });
    for (const s of ['a', 'b', 'c']) mbox.enqueue({ message: s, sender: null });
    expect(mbox.drainUser().map((e) => e.message)).toEqual(['a', 'b']);
  });

  test('drop-new discards the arrival whatever priority it was given', () => {
    const mbox = new PriorityMailbox<number>({
      priorityFor: (n) => n,
      capacity: 2,
      overflow: 'drop-new',
    });
    for (const n of [5, 6]) mbox.enqueue({ message: n, sender: null });
    mbox.enqueue({ message: 0, sender: null });   // urgent, and dropped anyway
    expect(mbox.drainUser().map((e) => e.message)).toEqual([5, 6]);
    expect(mbox.droppedCount).toBe(1);
  });

  test('reject is the default once a capacity is named', () => {
    const mbox = new PriorityMailbox<number>({ priorityFor: (n) => n, capacity: 2 });
    mbox.enqueue({ message: 1, sender: null });
    mbox.enqueue({ message: 2, sender: null });
    expect(() => mbox.enqueue({ message: 0, sender: null })).toThrow(MailboxFullError);
    expect(mbox.droppedCount).toBe(0);   // refusing is not dropping
  });

  test('the bound holds while the actor is suspended — #407 parity', () => {
    // Suspension is the supervision window: the actor has failed and messages
    // keep arriving.  `dequeueUser` refuses then, so the eviction goes through
    // `removeOldest`, which does not.
    const mbox = new PriorityMailbox<number>({
      priorityFor: (n) => n,
      capacity: 2,
      overflow: 'drop-lowest-priority',
    });
    for (const n of [5, 6]) mbox.enqueue({ message: n, sender: null });
    mbox.suspend();
    for (const n of [1, 2, 3]) mbox.enqueue({ message: n, sender: null });
    expect(mbox.size).toBe(2);
    mbox.resume();
    expect(mbox.drainUser().map((e) => e.message)).toEqual([1, 2]);
    expect(mbox.droppedCount).toBe(3);
  });

  test('the bound applies to the unstash path too', () => {
    // `prependUser` re-enters `enqueue` here, unlike BoundedMailbox — so
    // `unstashAll()` on a full priority mailbox can drop, which is worth
    // knowing before it surprises someone.
    const mbox = new PriorityMailbox<number>({
      priorityFor: (n) => n,
      capacity: 2,
      overflow: 'drop-lowest-priority',
    });
    for (const n of [1, 2]) mbox.enqueue({ message: n, sender: null });
    mbox.prependUser([{ message: 9, sender: null }, { message: 0, sender: null }]);
    expect(mbox.drainUser().map((e) => e.message)).toEqual([0, 1]);
    expect(mbox.droppedCount).toBe(2);
  });

  test('drops reach observeDrops alongside the caller onDrop', () => {
    // The additive contract the cell relies on: wiring the stock counter must
    // not unhook a metric the caller wired at construction.
    const mine: MailboxDropReason[] = [];
    const framework: MailboxDropReason[] = [];
    const mbox = new PriorityMailbox<number>({
      priorityFor: (n) => n,
      capacity: 1,
      overflow: 'drop-lowest-priority',
      onDrop: (reason) => mine.push(reason),
    });
    mbox.observeDrops((reason) => framework.push(reason));
    for (const n of [3, 1, 2]) mbox.enqueue({ message: n, sender: null });
    expect(mine.length).toBe(2);
    expect(framework).toEqual(mine);
    expect(mbox.droppedCount).toBe(2);
  });
});

// #733 — `priorityFor` is user code running on the SENDER's stack, and the
// framework itself hands it messages no application wrote (`PoisonPill` /
// `Kill` go out as user messages).  Before this, a callback that could not
// answer put its message at the HEAD — the highest-priority slot — and a
// callback that threw took out whoever called `tell`.
describe('PriorityMailbox — a priority the callback cannot produce', () => {
  type Tagged = { readonly label: string; readonly priority?: number };
  const drain = (mbox: PriorityMailbox<Tagged>): string[] =>
    mbox.drainUser().map((envelope) => envelope.message.label);

  test('an undefined priority sorts LAST, not first', () => {
    const mbox = new PriorityMailbox<Tagged>({ priorityFor: (m) => m.priority as number });
    for (const message of [
      { label: 'urgent', priority: 0 },
      { label: 'normal', priority: 5 },
      { label: 'unrankable-a' },
      { label: 'unrankable-b' },
    ]) mbox.enqueue({ message, sender: null });
    // The class documents "lower is higher priority", so a priority that
    // could not be determined must not outrank one that was stated.
    expect(drain(mbox)).toEqual(['urgent', 'normal', 'unrankable-a', 'unrankable-b']);
  });

  test('a NaN priority sorts last, and unrankable messages keep FIFO among themselves', () => {
    // NaN needs no cast to get here: `Number(m.priority)` is a type-correct
    // callback over an optional field.  It also broke the `sequence`
    // tie-break, for the same reason it broke the comparison — so the two
    // unrankable messages used to come out reversed.
    const mbox = new PriorityMailbox<Tagged>({ priorityFor: (m) => Number(m.priority) });
    for (const message of [
      { label: 'unrankable-a' },
      { label: 'ranked', priority: 7 },
      { label: 'unrankable-b' },
    ]) mbox.enqueue({ message, sender: null });
    expect(drain(mbox)).toEqual(['ranked', 'unrankable-a', 'unrankable-b']);
  });

  test('a non-number priority sorts last — a string compares false exactly like NaN', () => {
    const mbox = new PriorityMailbox<Tagged>({
      priorityFor: (m) => (m.priority ?? ('high' as unknown as number)),
    });
    // The string arrives AFTER the ranked messages on purpose.  Before the
    // guard, an already-queued unrankable entry drifted tailward as later
    // inserts pushed past it, so enqueuing it first happened to produce the
    // right order for the wrong reason — the head-insert only shows when the
    // unrankable message is the arriving one.
    for (const message of [
      { label: 'one', priority: 1 },
      { label: 'nine', priority: 9 },
      { label: 'stringly' },
    ]) mbox.enqueue({ message, sender: null });
    expect(drain(mbox)).toEqual(['one', 'nine', 'stringly']);
  });

  test('±Infinity is a ranking and is respected — it is not treated as unrankable', () => {
    // The recorded decision: `Number.isFinite` is the wrong predicate here.
    // -Infinity is a caller saying "ahead of everything" and the comparison
    // orders it correctly; only NaN and non-numbers are undeterminable.
    const mbox = new PriorityMailbox<Tagged>({ priorityFor: (m) => m.priority as number });
    for (const message of [
      { label: 'last', priority: Number.POSITIVE_INFINITY },
      { label: 'middle', priority: 0 },
      { label: 'first', priority: Number.NEGATIVE_INFINITY },
      { label: 'unrankable' },
    ]) mbox.enqueue({ message, sender: null });
    // An explicit +Infinity still sorts behind the unrankable sentinel, which
    // is MAX_SAFE_INTEGER — "we could not tell" is not worse than a caller's
    // deliberate "absolutely last".
    expect(drain(mbox)).toEqual(['first', 'middle', 'unrankable', 'last']);
  });

  test('placement no longer depends on insertion order', () => {
    // The head-insert broke the sorted-array invariant, so an unrankable
    // entry drifted tailward as later messages arrived: the same four
    // messages came out `neg | five | ten | nan` or `nan | neg | five | ten`
    // depending only on the order they were enqueued in.
    const orders: ReadonlyArray<ReadonlyArray<string>> = [
      ['unrankable', 'minus-one', 'five', 'ten'],
      ['minus-one', 'five', 'ten', 'unrankable'],
      ['minus-one', 'unrankable', 'ten', 'five'],
    ];
    const priorities: Readonly<Record<string, number | undefined>> = {
      'minus-one': -1, five: 5, ten: 10, unrankable: undefined,
    };
    for (const order of orders) {
      const mbox = new PriorityMailbox<Tagged>({ priorityFor: (m) => priorities[m.label] as number });
      for (const label of order) mbox.enqueue({ message: { label }, sender: null });
      expect(drain(mbox)).toEqual(['minus-one', 'five', 'ten', 'unrankable']);
    }
  });

  test('a throwing priorityFor does not reach the enqueue caller, and the message survives', () => {
    // The sender is a bystander to the receiver's mailbox configuration: it
    // has nothing to do about a broken `priorityFor` and no way to tell that
    // from a failure of its own.  Same shape that ruled `reject` out as the
    // framework's default overflow policy (#919).
    const mbox = new PriorityMailbox<Tagged>({
      priorityFor: (m) => {
        if (m.priority === undefined) throw new TypeError('no pattern matches value {}');
        return m.priority;
      },
    });
    expect(() => mbox.enqueue({ message: { label: 'thrower' }, sender: null })).not.toThrow();
    mbox.enqueue({ message: { label: 'ranked', priority: 3 }, sender: null });
    expect(drain(mbox)).toEqual(['ranked', 'thrower']);
  });

  test('onPriorityError reports the throw, with the message it could not rank', () => {
    const failures: Array<{ cause: unknown; label: string }> = [];
    const thrown = new Error('boom');
    const priorityOptions = PriorityMailboxOptions.create<Tagged>()
      .withPriorityFor(() => { throw thrown; })
      .withOnPriorityError((cause, message) => failures.push({ cause, label: message.label }));
    const mbox = new PriorityMailbox<Tagged>(priorityOptions);
    mbox.enqueue({ message: { label: 'thrower' }, sender: null });
    expect(failures).toEqual([{ cause: thrown, label: 'thrower' }]);
    // Contained, not swallowed: the message is still there to be handled.
    expect(drain(mbox)).toEqual(['thrower']);
  });

  test('onPriorityError reports a non-numeric return as a TypeError naming the type', () => {
    const causes: unknown[] = [];
    const mbox = new PriorityMailbox<Tagged>({
      priorityFor: (m) => m.priority as number,
      onPriorityError: (cause) => causes.push(cause),
    });
    mbox.enqueue({ message: { label: 'undefined-priority' }, sender: null });
    mbox.enqueue({ message: { label: 'nan-priority', priority: Number.NaN }, sender: null });
    mbox.enqueue({ message: { label: 'fine', priority: 1 }, sender: null });
    expect(causes.length).toBe(2);
    expect(causes[0]).toBeInstanceOf(TypeError);
    expect((causes[0] as TypeError).message).toContain('type undefined');
    expect((causes[1] as TypeError).message).toContain('NaN');
  });

  test('an unrankable burst no longer evicts the whole backlog under drop-lowest-priority', () => {
    // #647's bound made the head-insert worse rather than better: the arrival
    // went in at the head and the eviction pops the TAIL, so the arrival
    // always survived and a genuine message always died — reported as an
    // ordinary `drop-head`.  A full mailbox lost its entire backlog to four
    // messages the priority function could not rank.
    const reasons: MailboxDropReason[] = [];
    const mbox = new PriorityMailbox<Tagged>({
      priorityFor: (m) => Number(m.priority),
      capacity: 4,
      overflow: 'drop-lowest-priority',
      onDrop: (reason) => reasons.push(reason),
    });
    for (const message of [
      { label: 'urgent', priority: 0 },
      { label: 'command', priority: 1 },
      { label: 'normal', priority: 5 },
      { label: 'bulk', priority: 9 },
    ]) mbox.enqueue({ message, sender: null });
    for (let index = 0; index < 4; index++) {
      mbox.enqueue({ message: { label: `unrankable-${index}` }, sender: null });
    }
    expect(drain(mbox)).toEqual(['urgent', 'command', 'normal', 'bulk']);
    // Each arrival is now the least important thing in the queue, so the
    // honest reason is `drop-new` and not a claim that a queued message died.
    expect(reasons).toEqual(['drop-new', 'drop-new', 'drop-new', 'drop-new']);
  });

  test('a lifecycle notification still reaches the queue when priorityFor throws (#729)', () => {
    // `enqueueSignal` goes straight to the insertion, past the capacity
    // check — so it is the third path through the same unguarded call, and
    // the framework has no second copy of a `Terminated` to send.
    const mbox = new PriorityMailbox<Tagged>({
      priorityFor: () => { throw new Error('cannot rank a Terminated'); },
      capacity: 1,
      overflow: 'drop-lowest-priority',
    });
    expect(() => mbox.enqueueSignal({
      message: { label: 'terminated' },
      sender: null,
      undroppable: true,
    })).not.toThrow();
    expect(mbox.size).toBe(1);
    expect(drain(mbox)).toEqual(['terminated']);
  });
});

describe('PriorityMailbox — options validation', () => {
  test('builder form is equivalent to a plain object', () => {
    const priorityOptions = PriorityMailboxOptions.create<number>()
      .withPriorityFor((n) => n)
      .withCapacity(2)
      .withOverflow('drop-lowest-priority');
    const mbox = new PriorityMailbox<number>(priorityOptions);
    for (const n of [3, 1, 2]) mbox.enqueue({ message: n, sender: null });
    expect(mbox.drainUser().map((e) => e.message)).toEqual([1, 2]);
    expect(mbox.droppedCount).toBe(1);
  });

  test('a missing priorityFor throws OptionsError at construction', () => {
    // It used to type-check (the accepted union includes Partial<...>) and
    // fail as `this.priorityFor is not a function` on the first enqueue —
    // inside the sender's `tell`, a long way from the mistake.
    expect(() => new PriorityMailbox({})).toThrow(OptionsError);
    expect(() => new PriorityMailbox({})).toThrow(/priorityFor/);
    expect(() => new PriorityMailbox(PriorityMailboxOptions.create<number>().withCapacity(2)))
      .toThrow(/priorityFor/);
  });

  test('a non-callable priorityFor throws OptionsError', () => {
    expect(() => new PriorityMailbox({ priorityFor: 7 as never })).toThrow(OptionsError);
    expect(() => new PriorityMailbox({ priorityFor: 7 as never })).toThrow(/priorityFor/);
  });

  test('rejects a non-positive / non-integer capacity', () => {
    const priorityFor = (n: number): number => n;
    expect(() => new PriorityMailbox<number>({ priorityFor, capacity: 0 })).toThrow(OptionsError);
    expect(() => new PriorityMailbox<number>({ priorityFor, capacity: -3 })).toThrow(/capacity/);
    expect(() => new PriorityMailbox<number>({ priorityFor, capacity: 1.5 })).toThrow(/capacity/);
  });

  test('rejects an unknown overflow policy — including BoundedMailbox drop-head', () => {
    // `drop-head` is deliberately absent: the head here is the message the
    // priority function called most important.
    const priorityFor = (n: number): number => n;
    expect(() => new PriorityMailbox<number>({ priorityFor, capacity: 2, overflow: 'drop-head' as never }))
      .toThrow(OptionsError);
    expect(() => new PriorityMailbox<number>({ priorityFor, capacity: 2, overflow: 'drop-head' as never }))
      .toThrow(/overflow/);
  });

  test('rejects an overflow policy without a capacity', () => {
    const priorityFor = (n: number): number => n;
    expect(() => new PriorityMailbox<number>({ priorityFor, overflow: 'drop-new' })).toThrow(OptionsError);
    expect(() => new PriorityMailbox<number>({ priorityFor, overflow: 'drop-new' })).toThrow(/overflow/);
  });
});

describe('ActorOptions.withMailbox — end-to-end via actor', () => {
  test('actor uses the custom priority mailbox', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('mbox-pri', kitOptions);
    const probe = kit.createTestProbe();

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
      // A fixture: the handler has to still be busy while the sends arrive, or the
      // capacity-2 mailbox never overflows and `reject` is never exercised.
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
    // Draining 20 000 messages is what the 30 s budget is for, and under bun's
    // 5 s default cap the run could only ever report a bare timeout — the one
    // reading that looks identical to the bounded-mailbox regression this test
    // exists to catch.
  }, 45_000);

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

  // #733 end to end.  `ActorRef.stop()` posts `PoisonPill` as a *user*
  // message, and `PoisonPill` has no own enumerable properties — so the
  // "field-derived" `priorityFor` the docs recommend sees `{}`, and before
  // this the pill head-inserted and the actor stopped on the spot.  No
  // attacker and no malformed traffic: the framework's own shutdown path.
  test('ref.stop() still drains the backlog first with a field-derived priorityFor', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('mbox-pri-poison-pill', kitOptions);

    let release: () => void = () => {};
    const latch = new Promise<void>((resolve) => { release = resolve; });
    const handled: string[] = [];

    type Work = { readonly label: string; readonly priority: number };
    class Worker extends Actor<Work> {
      override async onReceive(m: Work): Promise<void> {
        if (m.label === 'w0') await latch;
        handled.push(m.label);
      }
      override postStop(): void { handled.push('STOPPED'); }
    }
    // Field-derived is one of the three shapes the mailboxes page recommends,
    // and it is the one that returns `undefined` for a PoisonPill.
    const options = ActorOptions.create<Work>()
      .withMailbox(() => new PriorityMailbox<Work>({ priorityFor: (m) => m.priority }) as never);
    const ref = kit.system.spawnAnonymous(Worker, options);

    // Wedge the actor on w0 so w1..w4 are genuinely queued when the pill
    // arrives — otherwise the drain would be trivially in order.
    for (let index = 0; index < 5; index++) ref.tell({ label: `w${index}`, priority: 5 });
    ref.stop();
    release();

    await awaitCondition(() => handled.includes('STOPPED'), {
      timeoutMs: 4_000,
      label: 'the actor stopped after its PoisonPill was handled',
    });
    // The documented guarantee: a graceful drain-then-stop, not a stop that
    // jumped a five-message queue.
    expect(handled).toEqual(['w0', 'w1', 'w2', 'w3', 'w4', 'STOPPED']);
    await kit.system.terminate();
  });

  test('a throwing priorityFor faults nothing in the sender — the tell returns', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('mbox-pri-throwing-callback', kitOptions);
    const failures: unknown[] = [];
    const handled: string[] = [];

    type Work = { readonly kind: 'work'; readonly label: string };
    class Worker extends Actor<Work> {
      override onReceive(m: Work): void { handled.push(m.label); }
      override postStop(): void { handled.push('STOPPED'); }
    }
    // The shape the repo's own example used: an exhaustive match, which throws
    // on anything it was not written for — including the framework's own
    // PoisonPill.
    const priorityOptions = PriorityMailboxOptions.create<Work>()
      .withPriorityFor((m) => {
        if (m.kind !== 'work') throw new Error(`Pattern matching error: no pattern matches value ${JSON.stringify(m)}`);
        return 5;
      })
      .withOnPriorityError((cause) => failures.push(cause));
    const options = ActorOptions.create<Work>()
      .withMailbox(() => new PriorityMailbox<Work>(priorityOptions) as never);
    const ref = kit.system.spawnAnonymous(Worker, options);

    ref.tell({ kind: 'work', label: 'a' });
    // `stop()` is a `tell` of PoisonPill, so the throw would land here, in
    // this test's own stack — which is exactly where a sender sees it.
    expect(() => ref.stop()).not.toThrow();

    await awaitCondition(() => handled.includes('STOPPED'), {
      timeoutMs: 4_000,
      label: 'the actor drained and then stopped',
    });
    expect(handled).toEqual(['a', 'STOPPED']);
    expect(failures.length).toBe(1);
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
        // A fixture: the handler has to be slow enough that the eight sends below
        // overrun a capacity-3 mailbox, which is the case under test.
        await sleep(10);
        received.push(m);
      }
    }
    const options = ActorOptions.create<number>()
      .withMailbox(() => new BoundedMailbox<number>({ capacity: 3, overflow: 'drop-new' }) as never);
    const ref = kit.system.spawnAnonymous(Slow, options);

    for (let i = 0; i < 8; i++) ref.tell(i);
    // An upper bound, so it cannot be polled: `received.length` has to end up in
    // [1, 8] once the sends are over, and a poll on ">= 1" returns on the first
    // delivery, long before drop-new has decided anything.
    await sleep(200);

    // At most (capacity + already-processed) messages will land — the
    // remainder is dropped silently by drop-new.
    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThanOrEqual(8);
    await kit.system.terminate();
  });
});
