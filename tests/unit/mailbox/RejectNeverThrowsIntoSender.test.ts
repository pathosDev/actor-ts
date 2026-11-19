/**
 * #919 — `tell()` is fire-and-forget and typed `void`, and under the `reject`
 * overflow policy it threw `MailboxFullError` into the *sender*.  For an actor
 * that throw escaped `onReceive`, so the sender was failed and restarted
 * because the actor it sent to was slow — failure flowing backwards along the
 * message flow.  From outside an actor nothing absorbed it at all.
 *
 * `reject` now refuses the arrival without throwing: the message is not
 * admitted, it is counted as `drop-new` (what happened to it), and it is
 * dead-lettered by default — `reject` is the policy that promises a refusal
 * is never silent, so its `deadLetterDrops` defaults to on.
 *
 * The other half of the issue: every bounded mailbox class shares one default
 * overflow policy whoever constructs it — the cell's capacity-built queue and
 * a hand-built `BoundedMailbox` / `ControlAwareMailbox` both shed the oldest,
 * and a `PriorityMailbox` sheds its least important.  `reject` is never a
 * default anywhere.
 *
 * No latch is needed for the bursts below, for the reason
 * `MailboxDropDeadLetters.test.ts` gives: a synchronous loop of tells meets a
 * queue nothing has dequeued from, and the letters it causes are already
 * queued at the listener when the loop returns — so a fence published after
 * it is strictly behind every one of them.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { BoundedMailbox } from '../../../src/mailbox/BoundedMailbox.js';
import { ControlAwareMailbox } from '../../../src/mailbox/ControlAwareMailbox.js';
import { PriorityMailbox } from '../../../src/mailbox/PriorityMailbox.js';
import type { Envelope, MailboxDropReason } from '../../../src/internal/Mailbox.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const FENCE = 'fence — every earlier letter is already queued';

const systems: ActorSystem[] = [];

afterEach(async () => {
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

function startSystem(name: string): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  return system;
}

/** Collects every dead letter; `settle` returns once all earlier ones are in. */
async function captureDeadLetters(system: ActorSystem): Promise<{ letters: DeadLetter[]; settle: () => Promise<unknown[]> }> {
  const letters: DeadLetter[] = [];
  const subscribed = { value: false };
  class Listener extends Actor<DeadLetter> {
    override preStart(): void {
      this.system.eventStream.subscribe(this.self, DeadLetter);
      subscribed.value = true;
    }
    override onReceive(letter: DeadLetter): void { letters.push(letter); }
  }
  system.spawn(Listener, 'dead-letter-listener');
  await awaitCondition(() => subscribed.value, { timeoutMs: 4_000, label: 'the dead-letter listener subscribed' });
  return {
    letters,
    settle: async () => {
      system.deadLetters.tell(FENCE);
      await awaitCondition(() => letters.some((l) => l.message === FENCE), {
        timeoutMs: 4_000,
        label: 'the fence letter came back',
      });
      return letters.filter((l) => l.message !== FENCE).map((l) => l.message);
    },
  };
}

class Sink extends Actor<unknown> {
  override onReceive(): void { /* the mailbox is the unit under test */ }
}

const envelope = <T>(message: T): Envelope<T> => ({ message, sender: null });

describe('reject refuses without throwing into the sender (#919)', () => {
  test('a plain tell from outside an actor does not throw, and the refusals are dead letters', async () => {
    const system = startSystem('919-outside');
    const capture = await captureDeadLetters(system);
    const sinkOptions = ActorOptions.create<unknown>()
      .withMailboxCapacity(2)
      .withMailboxOverflow('reject');
    const sink = system.spawn(Sink, 'sink', sinkOptions);

    expect(() => { for (let n = 1; n <= 6; n++) sink.tell(n); }).not.toThrow();
    expect(await capture.settle()).toEqual([3, 4, 5, 6]);
  });

  test('an actor flooding a full reject mailbox is not failed or restarted for it', async () => {
    const system = startSystem('919-actor-sender');
    const capture = await captureDeadLetters(system);
    const sinkOptions = ActorOptions.create<unknown>()
      .withMailboxCapacity(2)
      .withMailboxOverflow('reject');
    const sink = system.spawn(Sink, 'slow', sinkOptions);
    const restarts = { count: 0 };

    type FloodCommand = { readonly kind: 'flood'; readonly replyTo: ActorRef<number> };
    class Flooder extends Actor<FloodCommand> {
      override preRestart(): void { restarts.count++; }
      override onReceive(command: FloodCommand): void {
        for (let n = 1; n <= 20; n++) sink.tell(n, this.self);
        command.replyTo.tell(20);
      }
    }
    const flooder = system.spawn(Flooder, 'flooder');

    expect(await flooder.ask<number>({ kind: 'flood' }, 4_000)).toBe(20);
    const refused = await capture.settle();
    expect(restarts.count).toBe(0);
    expect(refused).toHaveLength(18);
    const letter = capture.letters.find((l) => l.message === 3)!;
    expect(letter.sender?.path.toString()).toBe(flooder.path.toString());
    expect(letter.recipient.path.toString()).toBe(sink.path.toString());
  });

  test('BoundedMailbox: reject reports the arrival as drop-new and admits nothing', () => {
    const reasons: MailboxDropReason[] = [];
    const mailbox = new BoundedMailbox<string>({
      capacity: 2,
      overflow: 'reject',
      onDrop: (reason) => { reasons.push(reason); },
    });
    for (const s of ['a', 'b', 'c']) mailbox.enqueue(envelope(s));
    expect(mailbox.drainUser().map((e) => e.message)).toEqual(['a', 'b']);
    expect(reasons).toEqual(['drop-new']);
    expect(mailbox.droppedCount).toBe(1);
  });

  test('ControlAwareMailbox and PriorityMailbox: reject does not throw either', () => {
    const controlAware = new ControlAwareMailbox<string>({
      isControl: (m) => m === 'control',
      capacity: 1,
      overflow: 'reject',
    });
    controlAware.enqueue(envelope('a'));
    expect(() => controlAware.enqueue(envelope('b'))).not.toThrow();
    expect(controlAware.droppedCount).toBe(1);

    const priority = new PriorityMailbox<number>({ priorityFor: (m) => m, capacity: 1, overflow: 'reject' });
    priority.enqueue(envelope(1));
    expect(() => priority.enqueue(envelope(2))).not.toThrow();
    expect(priority.droppedCount).toBe(1);
  });

  test('reject dead-letters by default; an explicit deadLetterDrops: false is honoured', () => {
    expect(new BoundedMailbox({ capacity: 1, overflow: 'reject' }).deadLetterDrops).toBe(true);
    expect(new BoundedMailbox({ capacity: 1, overflow: 'reject', deadLetterDrops: false }).deadLetterDrops).toBe(false);
    expect(new BoundedMailbox({ capacity: 1, overflow: 'drop-new' }).deadLetterDrops).toBe(false);
    expect(new ControlAwareMailbox({ isControl: () => false, capacity: 1, overflow: 'reject' }).deadLetterDrops).toBe(true);
    expect(new PriorityMailbox<number>({ priorityFor: (m) => m, capacity: 1, overflow: 'reject' }).deadLetterDrops).toBe(true);
  });
});

describe('one default overflow policy, whoever builds the mailbox (#919)', () => {
  test('a hand-built BoundedMailbox sheds the oldest, as the cell-built one does', () => {
    const mailbox = new BoundedMailbox<string>({ capacity: 2 });
    for (const s of ['a', 'b', 'c']) mailbox.enqueue(envelope(s));
    expect(mailbox.drainUser().map((e) => e.message)).toEqual(['b', 'c']);
  });

  test('a bounded ControlAwareMailbox sheds the oldest ordinary message', () => {
    const mailbox = new ControlAwareMailbox<string>({ isControl: () => false, capacity: 2 });
    for (const s of ['a', 'b', 'c']) mailbox.enqueue(envelope(s));
    expect(mailbox.drainUser().map((e) => e.message)).toEqual(['b', 'c']);
  });

  test('a bounded PriorityMailbox sheds its least important message', () => {
    // Lower number = more important, so 9 is the one a full queue gives up.
    const mailbox = new PriorityMailbox<number>({ priorityFor: (m) => m, capacity: 2 });
    for (const n of [9, 1, 2]) mailbox.enqueue(envelope(n));
    expect(mailbox.drainUser().map((e) => e.message)).toEqual([1, 2]);
  });
});
