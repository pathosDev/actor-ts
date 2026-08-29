import { describe, expect, test } from 'bun:test';
import { BoundedMailbox, MailboxFullError, type MailboxDropReason } from '../../../src/mailbox/index.js';
import type { Envelope } from '../../../src/internal/Mailbox.js';

/**
 * #772 — `BoundedMailbox` overrode `enqueue` and nothing else, so every
 * envelope re-entering through `prependUser` (the `unstashAll` replay path)
 * skipped the capacity check, the overflow policy and the drop accounting.
 * A `reject` mailbox never threw, a `drop-head` / `drop-new` mailbox never
 * dropped, and the queue sat at up to `capacity + DEFAULT_STASH_CAPACITY` —
 * `capacity: 10` becoming 1034 is the issue's own example.
 *
 * These are the primitive-level guards.  The end-to-end ones live in
 * `tests/unit/Stash.test.ts` (the OO stash), `tests/unit/typed/Behaviors.test.ts`
 * (the typed `withStash`) and `MailboxDropReporting.test.ts` (the metric), and
 * `MailboxProperties.test.ts` states the bound absolutely under a random walk
 * that now includes `prependUser`.
 */

const envelopeOf = (message: string): Envelope<string> => ({ message, sender: null });

/** A lifecycle notification the framework cannot send again — see `Envelope.undroppable`. */
const undroppableEnvelopeOf = (message: string): Envelope<string> =>
  ({ message, sender: null, undroppable: true });

const messagesIn = (mailbox: BoundedMailbox<string>): string[] =>
  mailbox.drainUser().map((envelope) => envelope.message);

/** A mailbox filled to `messages.length`, plus the drop reasons it reports from then on. */
function filledMailbox(
  capacity: number,
  overflow: 'drop-head' | 'drop-new' | 'reject',
  messages: ReadonlyArray<string>,
): { mailbox: BoundedMailbox<string>; reasons: MailboxDropReason[] } {
  const reasons: MailboxDropReason[] = [];
  const mailbox = new BoundedMailbox<string>({ capacity, overflow });
  for (const message of messages) mailbox.enqueue(envelopeOf(message));
  // Registered after the fill so the arrange step cannot contribute reasons.
  mailbox.observeDrops((reason) => reasons.push(reason));
  return { mailbox, reasons };
}

describe('BoundedMailbox.prependUser respects the bound (#772)', () => {
  test('drop-head makes room at the tail, so the replay wins over fresher traffic', () => {
    const { mailbox, reasons } = filledMailbox(4, 'drop-head', ['a', 'b', 'c', 'd']);

    mailbox.prependUser([envelopeOf('s1'), envelopeOf('s2')]);

    // The two newest queued messages went; the replay sits in front of what
    // is left, in stash order.
    expect(mailbox.size).toBe(4);
    expect(messagesIn(mailbox)).toEqual(['s1', 's2', 'a', 'b']);
    expect(mailbox.droppedCount).toBe(2);
    expect(reasons).toEqual(['drop-head', 'drop-head']);
  });

  test('drop-head reports drop-new once the queue holds nothing left to evict', () => {
    const { mailbox, reasons } = filledMailbox(3, 'drop-head', ['a', 'b', 'c']);

    mailbox.prependUser(['s1', 's2', 's3', 's4', 's5'].map(envelopeOf));

    // Three evictions empty the queue; after that there is no room to make,
    // so the arrival is what goes and the reason follows the fact.
    expect(mailbox.size).toBe(3);
    expect(messagesIn(mailbox)).toEqual(['s1', 's2', 's3']);
    expect(reasons).toEqual(['drop-head', 'drop-head', 'drop-head', 'drop-new', 'drop-new']);
  });

  test('drop-new refuses the part of the replay that does not fit', () => {
    const { mailbox, reasons } = filledMailbox(4, 'drop-new', ['a', 'b', 'c']);

    mailbox.prependUser(['s1', 's2', 's3'].map(envelopeOf));

    // One slot free, so the oldest stashed message takes it — the one whose
    // sender has been waiting longest.
    expect(mailbox.size).toBe(4);
    expect(messagesIn(mailbox)).toEqual(['s1', 'a', 'b', 'c']);
    expect(reasons).toEqual(['drop-new', 'drop-new']);
  });

  test('a replay that fits is admitted whole, with nothing reported', () => {
    const { mailbox, reasons } = filledMailbox(8, 'drop-head', ['a', 'b']);

    mailbox.prependUser(['s1', 's2', 's3'].map(envelopeOf));

    expect(messagesIn(mailbox)).toEqual(['s1', 's2', 's3', 'a', 'b']);
    expect(mailbox.droppedCount).toBe(0);
    expect(reasons).toEqual([]);
  });

  test('reject throws MailboxFullError and admits nothing — all or nothing', () => {
    const { mailbox, reasons } = filledMailbox(4, 'reject', ['a', 'b', 'c']);

    // One slot free and two envelopes offered: the batch is refused whole, so
    // the caller knows every one of them is still its own to account for.
    expect(() => mailbox.prependUser([envelopeOf('s1'), envelopeOf('s2')]))
      .toThrow(MailboxFullError);

    expect(mailbox.size).toBe(3);
    expect(messagesIn(mailbox)).toEqual(['a', 'b', 'c']);
    expect(mailbox.droppedCount).toBe(0);
    expect(reasons).toEqual([]);
  });

  test('reject admits a replay that fits exactly', () => {
    const { mailbox } = filledMailbox(4, 'reject', ['a', 'b', 'c']);

    mailbox.prependUser([envelopeOf('s1')]);

    expect(messagesIn(mailbox)).toEqual(['s1', 'a', 'b', 'c']);
  });

  test('the 1024-envelope replay of the issue no longer overshoots', () => {
    // The issue's probe: capacity 3, filled, then 500 envelopes prepended.
    // Every policy answered `size = 503`.
    for (const overflow of ['drop-head', 'drop-new'] as const) {
      const { mailbox } = filledMailbox(3, overflow, ['a', 'b', 'c']);
      mailbox.prependUser(Array.from({ length: 500 }, (_, i) => envelopeOf(`s${i}`)));
      expect(mailbox.size).toBe(3);
    }
    const { mailbox } = filledMailbox(3, 'reject', ['a', 'b', 'c']);
    expect(() => mailbox.prependUser(Array.from({ length: 500 }, (_, i) => envelopeOf(`s${i}`))))
      .toThrow(MailboxFullError);
    expect(mailbox.size).toBe(3);
  });
});

describe('BoundedMailbox.prependUser keeps undroppable envelopes (#729 + #772)', () => {
  test('a stashed notification is admitted past a full queue under every policy', () => {
    for (const overflow of ['drop-head', 'drop-new', 'reject'] as const) {
      const { mailbox, reasons } = filledMailbox(2, overflow, ['a', 'b']);

      // A `Terminated` that round-tripped through a stash must not become
      // droppable on the way back in — the framework has no second copy.
      mailbox.prependUser([undroppableEnvelopeOf('terminated')]);

      expect(messagesIn(mailbox)).toEqual(['terminated', 'a', 'b']);
      expect(reasons).toEqual([]);
    }
  });

  test('the tail eviction steps over a queued notification', () => {
    const { mailbox, reasons } = filledMailbox(3, 'drop-head', ['a']);
    mailbox.enqueueSignal(undroppableEnvelopeOf('terminated'));
    mailbox.enqueue(envelopeOf('c'));
    expect(mailbox.size).toBe(3);

    mailbox.prependUser([envelopeOf('s1')]);

    // `c` is the newest droppable message, so it goes; the notification stays
    // where it was queued rather than being evicted for sitting behind it.
    expect(messagesIn(mailbox)).toEqual(['s1', 'a', 'terminated']);
    expect(reasons).toEqual(['drop-head']);
  });

  test('a queue of nothing but notifications refuses the arrival rather than shedding one', () => {
    const { mailbox, reasons } = filledMailbox(2, 'drop-head', []);
    mailbox.enqueueSignal(undroppableEnvelopeOf('t1'));
    mailbox.enqueueSignal(undroppableEnvelopeOf('t2'));

    mailbox.prependUser([envelopeOf('s1')]);

    expect(messagesIn(mailbox)).toEqual(['t1', 't2']);
    expect(reasons).toEqual(['drop-new']);
  });

  test('reject counts only the droppable half of a batch', () => {
    const { mailbox } = filledMailbox(3, 'reject', ['a', 'b', 'c']);

    // No room at all, but nothing droppable is being offered either, so there
    // is no bound for this batch to break.
    mailbox.prependUser([undroppableEnvelopeOf('t1'), undroppableEnvelopeOf('t2')]);
    expect(messagesIn(mailbox)).toEqual(['t1', 't2', 'a', 'b', 'c']);
  });
});
