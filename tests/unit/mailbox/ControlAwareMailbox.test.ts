/**
 * A mailbox that lets a control message overtake queued bulk traffic, opt-in
 * (#1431).
 *
 * The framework keeps one rule for its own exempt door: an envelope that comes
 * through `ActorCell.postSignalEnvelope` is undroppable, and that says nothing
 * about its position — it queues at the tail like any `tell`.  Overtaking is
 * something a *mailbox type* offers, by classifying messages, and this is the
 * type that offers it: two FIFO classes, control dequeued first, a bound that
 * applies to the ordinary class only.
 *
 * The cases below are grouped by the door they exercise — `enqueue`,
 * `enqueueSignal`, `prependUser`, and the delivery side — because a bound has
 * several doors and each one has to answer the classification on its own.  The
 * last group runs the mailbox under a real actor, where the death-watch order
 * and the drop telemetry are what a caller actually observes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match, P } from 'ts-pattern';
import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  ControlAwareMailbox,
  ControlAwareMailboxOptions,
  ControlAwareMailboxOptionsBuilder,
  ControlAwareMailboxOptionsValidator,
  DeadLetter,
  Kill,
  MailboxFullError,
  OptionsError,
  PoisonPill,
  Terminated,
} from '../../../src/index.js';
import type {
  ControlAwareMailboxOptionsType,
  Envelope,
  MailboxDropReason,
} from '../../../src/index.js';
import * as mailboxBarrel from '../../../src/mailbox/index.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import type { MetricSample } from '../../../src/metrics/Metrics.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/* --------------------------------- helpers -------------------------------- */

/** The unit cases classify by prefix, so every message says which class it is in. */
const isControl = (message: string): boolean => message.startsWith('control');

const ordinary = (message: string): Envelope<string> => ({ message, sender: null });

/** What the exempt door builds — the marker is the only difference. */
const signal = (message: string): Envelope<string> => ({ message, sender: null, undroppable: true });

const messagesOf = <T>(envelopes: ReadonlyArray<Envelope<T>>): T[] =>
  envelopes.map((envelope) => envelope.message);

/** Dequeue until empty — the order an actor would be handed the messages in. */
const deliveryOrder = <T>(mailbox: ControlAwareMailbox<T>): T[] => {
  const delivered: T[] = [];
  for (let envelope = mailbox.dequeueUser(); envelope !== undefined; envelope = mailbox.dequeueUser()) {
    delivered.push(envelope.message);
  }
  return delivered;
};

type RecordedDrop = { readonly reason: MailboxDropReason; readonly message: string };

/** A bounded mailbox plus the drops its `onDrop` saw, in order. */
const boundedMailbox = (
  capacity: number,
  overflow?: 'drop-head' | 'drop-new' | 'reject',
): { readonly mailbox: ControlAwareMailbox<string>; readonly drops: RecordedDrop[] } => {
  const drops: RecordedDrop[] = [];
  const mailbox = new ControlAwareMailbox<string>({
    isControl,
    capacity,
    ...(overflow === undefined ? {} : { overflow }),
    onDrop: (reason, envelope) => { drops.push({ reason, message: envelope.message }); },
  });
  return { mailbox, drops };
};

/* ------------------------------ the public surface ------------------------- */

describe('the type and its options family are public (#1431)', () => {
  test('both barrels export the same class and options family', () => {
    expect(mailboxBarrel.ControlAwareMailbox).toBe(ControlAwareMailbox);
    expect(mailboxBarrel.ControlAwareMailboxOptions).toBe(ControlAwareMailboxOptions);
    expect(mailboxBarrel.ControlAwareMailboxOptionsBuilder).toBe(ControlAwareMailboxOptionsBuilder);
    expect(mailboxBarrel.ControlAwareMailboxOptionsValidator).toBe(ControlAwareMailboxOptionsValidator);
    // The value alias is the builder, so `ControlAwareMailboxOptions.create()` resolves.
    expect(ControlAwareMailboxOptions).toBe(ControlAwareMailboxOptionsBuilder);
  });

  test('the plain object, the builder and the validator describe one shape', () => {
    // Typed through the root barrel's type export, so the compiler checks that
    // `ControlAwareMailboxOptionsType` left the package too.
    const plain: ControlAwareMailboxOptionsType<string> = { isControl, capacity: 4, overflow: 'drop-new' };
    const mailboxOptions = ControlAwareMailboxOptions.create<string>()
      .withIsControl(isControl)
      .withCapacity(4)
      .withOverflow('drop-new');

    expect(mailboxOptions.build()).toEqual(plain);
    expect(() => new ControlAwareMailboxOptionsValidator<string>().validate(plain)).not.toThrow();
    expect(new ControlAwareMailbox<string>(mailboxOptions)).toBeInstanceOf(ControlAwareMailbox);
  });
});

/* ------------------------------- the two classes --------------------------- */

describe('control first, FIFO inside each class (#1431)', () => {
  test('with interleaved arrivals every control message is dequeued before every ordinary one', () => {
    const mailbox = new ControlAwareMailbox<string>({ isControl });
    for (const message of ['bulk-1', 'control-1', 'bulk-2', 'bulk-3', 'control-2', 'bulk-4', 'control-3']) {
      mailbox.enqueue(ordinary(message));
    }

    expect(mailbox.size).toBe(7);
    expect(mailbox.hasUserMessages()).toBe(true);
    expect(deliveryOrder(mailbox)).toEqual([
      'control-1', 'control-2', 'control-3',
      'bulk-1', 'bulk-2', 'bulk-3', 'bulk-4',
    ]);
    expect(mailbox.size).toBe(0);
    expect(mailbox.hasUserMessages()).toBe(false);
  });

  test('a control message that arrives after delivery has started still goes next', () => {
    const mailbox = new ControlAwareMailbox<string>({ isControl });
    for (const message of ['bulk-1', 'bulk-2', 'bulk-3']) mailbox.enqueue(ordinary(message));
    expect(mailbox.dequeueUser()?.message).toBe('bulk-1');

    mailbox.enqueue(ordinary('control-late'));
    expect(deliveryOrder(mailbox)).toEqual(['control-late', 'bulk-2', 'bulk-3']);
  });

  test('an unbounded mailbox sheds nothing, whatever the depth', () => {
    const mailbox = new ControlAwareMailbox<string>({ isControl });
    for (let index = 0; index < 1_000; index++) mailbox.enqueue(ordinary(`bulk-${index}`));
    mailbox.enqueue(ordinary('control-1'));

    expect(mailbox.size).toBe(1_001);
    expect(mailbox.droppedCount).toBe(0);
    expect(mailbox.dequeueUser()?.message).toBe('control-1');
  });
});

/* ----------------------- the bound, policy by policy ----------------------- */

describe('a bound applies to the ordinary class only (#1431)', () => {
  test('control messages do not count against the capacity', () => {
    const { mailbox, drops } = boundedMailbox(2, 'drop-new');
    for (let index = 0; index < 5; index++) mailbox.enqueue(ordinary(`control-${index}`));
    mailbox.enqueue(ordinary('bulk-1'));
    mailbox.enqueue(ordinary('bulk-2'));

    // Seven queued against a capacity of two, and nothing shed: the two ordinary
    // messages are exactly the capacity.
    expect(mailbox.size).toBe(7);
    expect(drops).toEqual([]);
    mailbox.enqueue(ordinary('bulk-3'));
    expect(drops).toEqual([{ reason: 'drop-new', message: 'bulk-3' }]);
  });

  test('drop-head evicts the oldest ordinary message and never a control one', () => {
    const { mailbox, drops } = boundedMailbox(2, 'drop-head');
    mailbox.enqueue(ordinary('control-early'));
    mailbox.enqueue(ordinary('bulk-1'));
    mailbox.enqueue(ordinary('bulk-2'));
    mailbox.enqueue(ordinary('bulk-3'));
    // A full queue, and control arrivals at every depth after it.
    for (let index = 0; index < 3; index++) mailbox.enqueue(ordinary(`control-${index}`));
    mailbox.enqueue(ordinary('bulk-4'));

    // `control-early` was the oldest message in the mailbox when `bulk-3`
    // arrived; an eviction that ignored the classes would have taken it.
    expect(drops).toEqual([
      { reason: 'drop-head', message: 'bulk-1' },
      { reason: 'drop-head', message: 'bulk-2' },
    ]);
    expect(mailbox.droppedCount).toBe(2);
    expect(messagesOf(mailbox.drainUser())).toEqual([
      'control-early', 'control-0', 'control-1', 'control-2', 'bulk-3', 'bulk-4',
    ]);
  });

  test('drop-new refuses the ordinary arrival and admits every control one', () => {
    const { mailbox, drops } = boundedMailbox(2, 'drop-new');
    mailbox.enqueue(ordinary('bulk-1'));
    mailbox.enqueue(ordinary('bulk-2'));
    mailbox.enqueue(ordinary('control-1'));
    mailbox.enqueue(ordinary('bulk-3'));
    mailbox.enqueue(ordinary('control-2'));

    expect(drops).toEqual([{ reason: 'drop-new', message: 'bulk-3' }]);
    expect(messagesOf(mailbox.drainUser())).toEqual(['control-1', 'control-2', 'bulk-1', 'bulk-2']);
  });

  test('reject — the default when constructed directly — throws for ordinary traffic only', () => {
    const { mailbox, drops } = boundedMailbox(2);
    mailbox.enqueue(ordinary('bulk-1'));
    mailbox.enqueue(ordinary('bulk-2'));

    expect(() => mailbox.enqueue(ordinary('bulk-3'))).toThrow(MailboxFullError);
    expect(() => mailbox.enqueue(ordinary('control-1'))).not.toThrow();
    expect(() => mailbox.enqueue(ordinary('control-2'))).not.toThrow();
    // A refusal is not a drop: the sender was told, so nothing is counted.
    expect(drops).toEqual([]);
    expect(mailbox.droppedCount).toBe(0);
    expect(messagesOf(mailbox.drainUser())).toEqual(['control-1', 'control-2', 'bulk-1', 'bulk-2']);
  });
});

/* ------------------------------- enqueueSignal ----------------------------- */

describe('enqueueSignal classifies too (#1431, #729)', () => {
  test('an undroppable ordinary envelope is admitted past the bound and stays at the ordinary tail', () => {
    for (const overflow of ['drop-new', 'reject'] as const) {
      const { mailbox, drops } = boundedMailbox(2, overflow);
      mailbox.enqueue(ordinary('bulk-1'));
      mailbox.enqueue(ordinary('bulk-2'));

      // A `Terminated` for a watcher, a `close` for a connection actor: both
      // arrive late relative to the backlog, and neither may be lost to it.
      expect(() => mailbox.enqueueSignal(signal('terminated'))).not.toThrow();
      expect(() => mailbox.enqueueSignal(signal('close'))).not.toThrow();
      mailbox.enqueue(ordinary('control-1'));

      expect(mailbox.size).toBe(5);
      expect(drops).toEqual([]);
      expect(messagesOf(mailbox.drainUser())).toEqual(['control-1', 'bulk-1', 'bulk-2', 'terminated', 'close']);
    }
  });

  test('drop-head steps over an undroppable ordinary envelope on its way to the next droppable one', () => {
    const { mailbox, drops } = boundedMailbox(2, 'drop-head');
    mailbox.enqueue(ordinary('bulk-1'));
    mailbox.enqueueSignal(signal('terminated'));
    for (const message of ['bulk-2', 'bulk-3', 'bulk-4']) mailbox.enqueue(ordinary(message));

    // The notification occupies a place in the ordinary class, as it does on
    // `BoundedMailbox`, so one droppable slot is left and each arrival evicts
    // its predecessor — never the notification sitting at the head.
    expect(drops.map((drop) => drop.message)).toEqual(['bulk-1', 'bulk-2', 'bulk-3']);
    expect(messagesOf(mailbox.drainUser())).toEqual(['terminated', 'bulk-4']);
  });

  test('an undroppable control envelope joins the control class', () => {
    const { mailbox, drops } = boundedMailbox(1);
    mailbox.enqueue(ordinary('bulk-1'));
    mailbox.enqueue(ordinary('control-1'));

    expect(() => mailbox.enqueueSignal(signal('control-accept'))).not.toThrow();
    expect(drops).toEqual([]);
    expect(deliveryOrder(mailbox)).toEqual(['control-1', 'control-accept', 'bulk-1']);
  });
});

/* -------------------------------- prependUser ------------------------------ */

describe('prependUser puts each envelope back at the head of its own class (#1431, #772)', () => {
  test('a stash replay is partitioned, and each class keeps the batch order', () => {
    const mailbox = new ControlAwareMailbox<string>({ isControl });
    mailbox.enqueue(ordinary('bulk-late'));
    mailbox.enqueue(ordinary('control-late'));

    mailbox.prependUser([
      ordinary('bulk-stashed-1'),
      ordinary('control-stashed-1'),
      ordinary('bulk-stashed-2'),
      ordinary('control-stashed-2'),
    ]);

    expect(mailbox.size).toBe(6);
    expect(deliveryOrder(mailbox)).toEqual([
      'control-stashed-1', 'control-stashed-2', 'control-late',
      'bulk-stashed-1', 'bulk-stashed-2', 'bulk-late',
    ]);
  });

  test('the throttle re-park: a control envelope put back is the next one out again', () => {
    // `ActorCell.handleThrottleExcess` hands the envelope it just dequeued back
    // through `prependUser`.  Back at the head of the ordinary class would let
    // the bulk traffic it overtook overtake it in turn.
    const mailbox = new ControlAwareMailbox<string>({ isControl });
    mailbox.enqueue(ordinary('bulk-1'));
    mailbox.enqueue(ordinary('control-1'));
    mailbox.enqueue(ordinary('control-2'));

    const parked = mailbox.dequeueUser()!;
    expect(parked.message).toBe('control-1');
    mailbox.prependUser([parked]);

    expect(deliveryOrder(mailbox)).toEqual(['control-1', 'control-2', 'bulk-1']);
  });

  test('drop-head sheds the newest ordinary message to make room, never a control one', () => {
    const { mailbox, drops } = boundedMailbox(2, 'drop-head');
    mailbox.enqueue(ordinary('bulk-1'));
    mailbox.enqueue(ordinary('bulk-2'));
    mailbox.enqueue(ordinary('control-1'));

    mailbox.prependUser([ordinary('bulk-stashed-1'), ordinary('control-stashed'), ordinary('bulk-stashed-2')]);

    // The replay lands at the head, so the room comes from the far end: the
    // newest ordinary message first.  `control-1` is newer than either and is
    // not a candidate at all.
    expect(drops).toEqual([
      { reason: 'drop-head', message: 'bulk-2' },
      { reason: 'drop-head', message: 'bulk-1' },
    ]);
    expect(messagesOf(mailbox.drainUser())).toEqual([
      'control-stashed', 'control-1', 'bulk-stashed-1', 'bulk-stashed-2',
    ]);
  });

  test('drop-new refuses the ordinary envelopes that do not fit, never a control one', () => {
    const { mailbox, drops } = boundedMailbox(2, 'drop-new');
    mailbox.enqueue(ordinary('bulk-1'));

    mailbox.prependUser([ordinary('bulk-stashed-1'), ordinary('bulk-stashed-2'), ordinary('control-stashed')]);

    expect(drops).toEqual([{ reason: 'drop-new', message: 'bulk-stashed-2' }]);
    expect(messagesOf(mailbox.drainUser())).toEqual(['control-stashed', 'bulk-stashed-1', 'bulk-1']);
  });

  test('reject refuses the whole batch before admitting any of it — the control half included', () => {
    const { mailbox, drops } = boundedMailbox(2, 'reject');
    mailbox.enqueue(ordinary('bulk-1'));
    mailbox.enqueue(ordinary('bulk-2'));

    // `ActorCell.unstashAll` puts a refused batch back into the stash, so a
    // control envelope admitted on the way to the throw would be queued *and*
    // stashed — delivered twice.
    expect(() => mailbox.prependUser([ordinary('control-stashed'), ordinary('bulk-stashed')]))
      .toThrow(MailboxFullError);
    expect(mailbox.size).toBe(2);
    expect(drops).toEqual([]);

    // Nothing the bound applies to: admitted, whatever the policy says.
    expect(() => mailbox.prependUser([ordinary('control-stashed'), signal('terminated')])).not.toThrow();
    expect(messagesOf(mailbox.drainUser())).toEqual(['control-stashed', 'terminated', 'bulk-1', 'bulk-2']);
  });

  test('the room a replay needs is counted in the ordinary class — queued control messages take none of it', () => {
    for (const overflow of ['drop-head', 'drop-new', 'reject'] as const) {
      const { mailbox, drops } = boundedMailbox(2, overflow);
      for (let index = 0; index < 3; index++) mailbox.enqueue(ordinary(`control-${index}`));
      mailbox.enqueue(ordinary('bulk-1'));

      // One ordinary message queued against a capacity of two: there is room,
      // however many control messages sit beside it.
      expect(() => mailbox.prependUser([ordinary('bulk-stashed')])).not.toThrow();

      expect(drops).toEqual([]);
      expect(messagesOf(mailbox.drainUser())).toEqual([
        'control-0', 'control-1', 'control-2', 'bulk-stashed', 'bulk-1',
      ]);
    }
  });

  test('an undroppable ordinary envelope in a replay is admitted past the bound and not counted', () => {
    for (const overflow of ['drop-head', 'drop-new'] as const) {
      const { mailbox, drops } = boundedMailbox(1, overflow);
      mailbox.enqueueSignal(signal('close'));

      mailbox.prependUser([signal('terminated')]);

      expect(drops).toEqual([]);
      expect(messagesOf(mailbox.drainUser())).toEqual(['terminated', 'close']);
    }
  });
});

/* -------------------------- suspension and draining ------------------------ */

describe('suspension and the termination drain (#1431)', () => {
  test('while suspended dequeueUser returns undefined, and the bound still evicts', () => {
    const { mailbox, drops } = boundedMailbox(2, 'drop-head');
    mailbox.suspend();
    for (const message of ['bulk-1', 'control-1', 'bulk-2', 'bulk-3']) mailbox.enqueue(ordinary(message));

    expect(mailbox.dequeueUser()).toBeUndefined();
    expect(mailbox.hasMessages()).toBe(false);
    expect(mailbox.hasUserMessages()).toBe(true);
    // Evicting is not delivery: a suspended actor is one awaiting its
    // supervisor, which is exactly when a lapsed bound would hurt most.
    expect(drops).toEqual([{ reason: 'drop-head', message: 'bulk-1' }]);
    expect(mailbox.size).toBe(3);

    mailbox.resume();
    expect(mailbox.hasMessages()).toBe(true);
    expect(deliveryOrder(mailbox)).toEqual(['control-1', 'bulk-2', 'bulk-3']);
  });

  test('a queue holding only control messages still reports work, and a suspended one does not', () => {
    const mailbox = new ControlAwareMailbox<string>({ isControl });
    mailbox.enqueue(ordinary('control-1'));
    expect(mailbox.hasMessages()).toBe(true);
    expect(mailbox.hasUserMessages()).toBe(true);
    mailbox.suspend();
    expect(mailbox.hasMessages()).toBe(false);
    mailbox.enqueueSystem({ message: { kind: 'resume' }, sender: null });
    // System traffic overtakes both classes, suspended or not.
    expect(mailbox.hasMessages()).toBe(true);
    expect(mailbox.hasSystemMessages()).toBe(true);
  });

  test('drainUser hands back control, then ordinary — the order they would have been delivered in', () => {
    const mailbox = new ControlAwareMailbox<string>({ isControl });
    for (const message of ['bulk-1', 'control-1', 'bulk-2', 'control-2']) mailbox.enqueue(ordinary(message));
    mailbox.enqueueSignal(signal('terminated'));

    expect(messagesOf(mailbox.drainUser())).toEqual(['control-1', 'control-2', 'bulk-1', 'bulk-2', 'terminated']);
    expect(mailbox.size).toBe(0);
    expect(mailbox.hasUserMessages()).toBe(false);
    expect(mailbox.drainUser()).toEqual([]);
  });
});

/* ------------------------- the predicate is contained ---------------------- */

type DieMessage = { readonly kind: 'die' };
type WatchMessage = { readonly kind: 'watch'; readonly target: ActorRef<DieMessage> };
type BlockMessage = { readonly kind: 'block' };
type UrgentMessage = { readonly kind: 'urgent'; readonly index: number };
type WorkMessage = { readonly kind: 'work'; readonly index: number };
/** What the actor cases below are told — and what their predicates are written against. */
type ParkedMessage = WatchMessage | BlockMessage | UrgentMessage | WorkMessage | Terminated;

/**
 * Written for the actor's own protocol only, the way an exhaustive matcher
 * reads — and therefore throwing on anything else, `PoisonPill` and `Kill`
 * included.
 */
const exhaustiveIsUrgent = (message: ParkedMessage): boolean =>
  match(message)
    .with(P.instanceOf(Terminated), () => false)
    .with({ kind: 'watch' }, () => false)
    .with({ kind: 'block' }, () => false)
    .with({ kind: 'urgent' }, () => true)
    .with({ kind: 'work' }, () => false)
    .exhaustive();

describe('the predicate runs on the sender\'s stack and cannot escape it (#1431)', () => {
  test('a predicate that throws classes the message ordinary, and enqueue does not throw', () => {
    const mailbox = new ControlAwareMailbox<string>({
      isControl: (message) => {
        if (message === 'boom') throw new Error('cannot classify boom');
        return isControl(message);
      },
    });

    expect(() => mailbox.enqueue(ordinary('boom'))).not.toThrow();
    expect(() => mailbox.enqueueSignal(signal('boom'))).not.toThrow();
    expect(() => mailbox.prependUser([ordinary('boom')])).not.toThrow();
    mailbox.enqueue(ordinary('control-1'));

    expect(deliveryOrder(mailbox)).toEqual(['control-1', 'boom', 'boom', 'boom']);
  });

  test('any answer but true classes the message ordinary', () => {
    const answers: ReadonlyMap<string, unknown> = new Map<string, unknown>([
      ['one', 1],
      ['yes', 'yes'],
      ['object', {}],
      ['nothing', undefined],
      ['null', null],
      ['control', true],
    ]);
    const mailbox = new ControlAwareMailbox<string>({ isControl: (message) => answers.get(message) as boolean });
    for (const message of answers.keys()) mailbox.enqueue(ordinary(message));

    expect(deliveryOrder(mailbox)).toEqual(['control', 'one', 'yes', 'object', 'nothing', 'null']);
  });

  test('PoisonPill and Kill are classed ordinary by a predicate written for application traffic', () => {
    const mailbox = new ControlAwareMailbox<ParkedMessage>({ isControl: exhaustiveIsUrgent });
    // What `ActorRef.stop()` and `.kill()` post — user messages with no fields,
    // outside the protocol the predicate was written for.
    expect(() => mailbox.enqueue({ message: PoisonPill.instance as never, sender: null })).not.toThrow();
    expect(() => mailbox.enqueue({ message: Kill.instance as never, sender: null })).not.toThrow();
    mailbox.enqueue({ message: { kind: 'urgent', index: 0 }, sender: null });

    expect(deliveryOrder(mailbox) as unknown[]).toEqual([
      { kind: 'urgent', index: 0 },
      PoisonPill.instance,
      Kill.instance,
    ]);
  });
});

/* -------------------------------- validation ------------------------------- */

describe('construction validates the options (#1431)', () => {
  const rejected = (options: Partial<ControlAwareMailboxOptionsType<string>>): OptionsError => {
    try {
      new ControlAwareMailbox<string>(options);
    } catch (error) {
      expect(error).toBeInstanceOf(OptionsError);
      return error as OptionsError;
    }
    throw new Error(`accepted ${JSON.stringify(options)}`);
  };

  test('a missing predicate is refused', () => {
    expect(rejected({}).field).toBe('isControl');
  });

  test('a predicate that is not callable is refused', () => {
    expect(rejected({ isControl: true as never }).field).toBe('isControl');
    expect(rejected({ isControl: 'control' as never }).field).toBe('isControl');
  });

  test('a capacity that is not a positive integer is refused', () => {
    for (const capacity of [0, -1, 1.5, Number.NaN]) {
      expect(rejected({ isControl, capacity }).field).toBe('capacity');
    }
  });

  test('an unknown overflow policy is refused — including the priority mailbox\'s own', () => {
    expect(rejected({ isControl, capacity: 4, overflow: 'drop-oldest' as never }).field).toBe('overflow');
    expect(rejected({ isControl, capacity: 4, overflow: 'drop-lowest-priority' as never }).field).toBe('overflow');
  });

  test('an overflow policy without a capacity is refused rather than ignored', () => {
    expect(rejected({ isControl, overflow: 'drop-head' }).field).toBe('overflow');
  });

  test('dead-lettering drops without a capacity is refused rather than ignored', () => {
    expect(rejected({ isControl, deadLetterDrops: true }).field).toBe('deadLetterDrops');
  });

  test('the builder reaches the same rules', () => {
    const mailboxOptions = ControlAwareMailboxOptions.create<string>()
      .withIsControl(isControl)
      .withCapacity(0);
    expect(() => new ControlAwareMailbox<string>(mailboxOptions)).toThrow(OptionsError);
  });
});

/* -------------------------------- on an actor ------------------------------ */

const systems: ActorSystem[] = [];

afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.terminate().catch(() => {})));
});

const startSystem = (name: string, metrics = false): ActorSystem => {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  if (metrics) system.extension(MetricsExtensionId).enable();
  return system;
};

/** A promise the test opens by hand — how an actor is parked mid-handler. */
type Gate = { readonly opened: Promise<void>; readonly open: () => void };

const newGate = (): Gate => {
  let resolveOpened = (): void => {};
  const opened = new Promise<void>((resolve) => { resolveOpened = resolve; });
  return { opened, open: (): void => resolveOpened() };
};

/** What one actor case observes.  Reassigned per test; bun runs a file's tests in order. */
type ActorProbe = {
  readonly seen: string[];
  readonly gate: Gate;
  readonly parked: { value: boolean };
  readonly watched: { value: boolean };
  readonly stopped: { value: boolean };
};

const newActorProbe = (): ActorProbe => ({
  seen: [],
  gate: newGate(),
  parked: { value: false },
  watched: { value: false },
  stopped: { value: false },
});

let actorProbe: ActorProbe = newActorProbe();

class DyingTarget extends Actor<DieMessage> {
  override onReceive(m: DieMessage): void {
    match(m)
      .with({ kind: 'die' }, () => this.onDie())
      .exhaustive();
  }

  private onDie(): void {
    this.self.stop();
  }
}

/** Watches on demand, parks inside a handler, and records what it is handed. */
class ParkingActor extends Actor<ParkedMessage> {
  override async onReceive(m: ParkedMessage): Promise<void> {
    await match(m)
      .with(P.instanceOf(Terminated), (message) => this.onTerminated(message))
      .with({ kind: 'watch' }, (message) => this.onWatch(message))
      .with({ kind: 'block' }, () => this.onBlock())
      .with({ kind: 'urgent' }, (message) => this.onUrgent(message))
      .with({ kind: 'work' }, (message) => this.onWork(message))
      .exhaustive();
  }

  override postStop(): void {
    actorProbe.stopped.value = true;
  }

  private onTerminated(message: Terminated): void {
    actorProbe.seen.push(`terminated:${message.actor.path.name}`);
  }

  private onWatch(message: WatchMessage): void {
    this.context.watch(message.target);
    actorProbe.watched.value = true;
  }

  private async onBlock(): Promise<void> {
    actorProbe.parked.value = true;
    await actorProbe.gate.opened;
  }

  private onUrgent(message: UrgentMessage): void {
    actorProbe.seen.push(`urgent:${message.index}`);
  }

  private onWork(message: WorkMessage): void {
    actorProbe.seen.push(`work:${message.index}`);
  }
}

/** The control class of the actor cases: `urgent`, and nothing the framework sends. */
const isUrgent = (message: ParkedMessage): boolean => 'kind' in message && message.kind === 'urgent';

const mailboxOf = <TMessage>(ref: ActorRef<TMessage>): ControlAwareMailbox<unknown> => {
  const cell = (ref as unknown as {
    getCell(): { _mailboxForTest(): ControlAwareMailbox<unknown> };
  }).getCell();
  return cell._mailboxForTest();
};

const park = async (ref: ActorRef<ParkedMessage>): Promise<void> => {
  ref.tell({ kind: 'block' });
  await awaitCondition(() => actorProbe.parked.value, {
    timeoutMs: 4_000,
    label: 'the actor parked inside its handler',
  });
};

/** Subscribe to the dead-letter stream; `settle` resolves once everything published so far arrived. */
const captureDeadLetters = async (
  system: ActorSystem,
): Promise<{ readonly letters: DeadLetter[]; readonly settle: () => Promise<void> }> => {
  const fence = 'fence — every earlier letter is already queued';
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
      system.deadLetters.tell(fence);
      await awaitCondition(() => letters.some((letter) => letter.message === fence), {
        timeoutMs: 4_000,
        label: 'the fence letter came back',
      });
      letters.splice(letters.findIndex((letter) => letter.message === fence), 1);
    },
  };
};

const dropSamples = (system: ActorSystem): ReadonlyArray<MetricSample> =>
  system.extension(MetricsExtensionId).get().collect()
    .filter((sample) => sample.name === 'actor_mailbox_dropped_total');

describe('under a real actor (#1431)', () => {
  test('a parked actor handles a later control message first, and a watched death after its backlog', async () => {
    actorProbe = newActorProbe();
    const system = startSystem('1431-overtake');
    const target = system.spawn(DyingTarget, 'target');
    const actorOptions = ActorOptions.create<ParkedMessage>()
      .withMailbox(() => new ControlAwareMailbox<ParkedMessage>({ isControl: isUrgent }));
    const actor = system.spawn(ParkingActor, 'actor', actorOptions);
    actor.tell({ kind: 'watch', target });
    await awaitCondition(() => actorProbe.watched.value, {
      timeoutMs: 4_000,
      label: 'the actor registered its death watch',
    });
    await park(actor);
    const mailbox = mailboxOf(actor);
    expect(mailbox).toBeInstanceOf(ControlAwareMailbox);

    for (let index = 0; index < 3; index++) actor.tell({ kind: 'work', index });
    target.tell({ kind: 'die' });
    await awaitCondition(() => mailbox.size === 4, {
      timeoutMs: 4_000,
      label: 'the Terminated joined the queue behind the work',
    });
    actor.tell({ kind: 'urgent', index: 0 });

    actorProbe.gate.open();
    await awaitCondition(() => actorProbe.seen.length === 5, {
      timeoutMs: 4_000,
      label: 'the actor drained its queue',
    });
    // The control message overtook the whole backlog; the `Terminated`, which
    // this predicate leaves ordinary, kept the place death watch promises it.
    expect(actorProbe.seen).toEqual(['urgent:0', 'work:0', 'work:1', 'work:2', 'terminated:target']);
  });

  test('its drops reach the counter and onDrop, and become dead letters when asked', async () => {
    actorProbe = newActorProbe();
    const system = startSystem('1431-drops', true);
    const capture = await captureDeadLetters(system);
    const reasons: MailboxDropReason[] = [];
    const mailboxOptions = ControlAwareMailboxOptions.create<ParkedMessage>()
      .withIsControl(isUrgent)
      .withCapacity(2)
      .withOverflow('drop-new')
      .withOnDrop((reason) => { reasons.push(reason); })
      .withDeadLetterDrops(true);
    const actorOptions = ActorOptions.create<ParkedMessage>()
      .withMailbox(() => new ControlAwareMailbox<ParkedMessage>(mailboxOptions));
    const actor = system.spawn(ParkingActor, 'actor', actorOptions);
    await park(actor);

    for (let index = 1; index <= 5; index++) {
      actor.tell({ kind: 'work', index });
      actor.tell({ kind: 'urgent', index });
    }
    await capture.settle();

    // Three ordinary arrivals over a capacity of two, and not one control
    // message among the losses.
    expect(capture.letters.map((letter) => letter.message)).toEqual([
      { kind: 'work', index: 3 },
      { kind: 'work', index: 4 },
      { kind: 'work', index: 5 },
    ]);
    expect(reasons).toEqual(['drop-new', 'drop-new', 'drop-new']);
    const samples = dropSamples(system);
    expect(samples.length).toBe(1);
    expect(samples[0]!.labels).toEqual({ class: 'ParkingActor', reason: 'drop-new' });
    expect(samples[0]!.value).toBe(3);

    actorProbe.gate.open();
    await awaitCondition(() => actorProbe.seen.length === 7, {
      timeoutMs: 4_000,
      label: 'the actor drained what survived',
    });
    expect(actorProbe.seen).toEqual(['urgent:1', 'urgent:2', 'urgent:3', 'urgent:4', 'urgent:5', 'work:1', 'work:2']);
  });

  test('a predicate that throws on PoisonPill costs neither the tell nor the stop', async () => {
    actorProbe = newActorProbe();
    const system = startSystem('1431-contained');
    const actorOptions = ActorOptions.create<ParkedMessage>()
      .withMailbox(() => new ControlAwareMailbox<ParkedMessage>({ isControl: exhaustiveIsUrgent }));
    const actor = system.spawn(ParkingActor, 'actor', actorOptions);
    await park(actor);

    expect(() => actor.tell({ kind: 'work', index: 0 })).not.toThrow();
    // `stop()` posts `PoisonPill`, which the predicate's exhaustive match throws
    // on: contained, it is ordinary and keeps its place behind the work.
    expect(() => actor.stop()).not.toThrow();
    expect(() => actor.tell({ kind: 'urgent', index: 0 })).not.toThrow();

    actorProbe.gate.open();
    await awaitCondition(() => actorProbe.stopped.value, {
      timeoutMs: 4_000,
      label: 'the actor drained its queue and stopped',
    });
    expect(actorProbe.seen).toEqual(['urgent:0', 'work:0']);
  });
});
