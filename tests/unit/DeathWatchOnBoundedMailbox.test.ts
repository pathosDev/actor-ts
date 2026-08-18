/**
 * A watcher cannot be blinded (#729).
 *
 * A death-watch `Terminated` rides the watcher's **user** queue — deliberately,
 * because death-watch documents FIFO ordering against prior `tell`s — and every
 * load-shedding policy in the framework used to be allowed to destroy it there.
 * The framework sends it once: `finalizeTermination` clears `_watchers`
 * immediately afterwards, so there is no retry, and before #729 there was not
 * even a dead letter.  A watcher that lost one believed a dead actor was alive
 * for the rest of its life, and every consumer built on the notification —
 * `BackoffSupervisor`'s respawn, `Router`'s routee pruning, `ShardRegion`,
 * `ClusterSingletonManager`, `GracefulStop` — stalls with it.
 *
 * Five shedding policies reached it, one per test below:
 *
 *   - `BoundedMailbox` `drop-head` — evicted it *after* it was safely queued;
 *   - `BoundedMailbox` `drop-new` — discarded it on arrival, the likelier of the
 *     two, since a death arrives late relative to the flood that filled the queue;
 *   - `PriorityMailbox` `drop-lowest-priority` — shed it as least important;
 *   - `throttle({ onExcess: 'drop' })` — consumed it one layer above the queue;
 *   - `BoundedMailbox` `reject` — worse than losing it: the throw landed on the
 *     *dying* actor's stack and aborted its termination.
 *
 * Every test here parks the watcher inside a handler first.  That is what makes
 * the queue fill at all, and it is the situation the defect needs: a watcher
 * keeping up with its producers never overflows.  The `droppedCount` and depth
 * assertions are not decoration either — they prove the bound was genuinely
 * active, so a change that quietly unbounded the mailbox would fail these tests
 * rather than pass them vacuously.
 *
 * The ordering test is the counterweight.  It fails if anyone closes this by
 * moving the notification onto the system queue, where it would overtake queued
 * user messages and — under `watchWith` — make a *domain* message jump the queue.
 */
import { describe, expect, test } from 'bun:test';
import { match, P } from 'ts-pattern';
import { Actor } from '../../src/Actor.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { ActorOptions } from '../../src/ActorOptions.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { DeadLetter, Terminated } from '../../src/SystemMessages.js';
import {
  BoundedMailbox,
  Mailbox,
  PriorityMailbox,
  type Envelope,
} from '../../src/mailbox/index.js';
import { awaitCondition } from '../util/AwaitCondition.js';

const newSystem = (name: string): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

/* ----------------------------- test protocol ------------------------------ */

type DieMessage = { readonly kind: 'die' };
type TargetMessage = DieMessage;

type NoopMessage = { readonly kind: 'noop' };

type WatchMessage = { readonly kind: 'watch'; readonly target: ActorRef<TargetMessage> };
type BlockMessage = { readonly kind: 'block' };
type FillerMessage = { readonly kind: 'filler'; readonly index: number };
type WatcherMessage = WatchMessage | BlockMessage | FillerMessage | Terminated;

/** A promise the test opens by hand — how a watcher is parked mid-handler. */
type Gate = { readonly opened: Promise<void>; readonly open: () => void };

const newGate = (): Gate => {
  let resolveOpened = (): void => {};
  const opened = new Promise<void>((resolve) => { resolveOpened = resolve; });
  return { opened, open: (): void => resolveOpened() };
};

/**
 * What one test observes about its watcher.
 *
 * Module-level and reassigned per test rather than closed over inside each one:
 * the actor classes below are written once and every test needs the same four
 * handles.  Safe because `bun test` runs a file's tests one after another.
 */
type WatcherProbe = {
  readonly seen: string[];
  readonly gate: Gate;
  readonly blocked: { value: boolean };
  readonly watched: { value: boolean };
};

const newProbe = (): WatcherProbe => ({
  seen: [],
  gate: newGate(),
  blocked: { value: false },
  watched: { value: false },
});

let probe: WatcherProbe = newProbe();

/** The child whose death is watched, and whether its parent finished stopping. */
type ParentProbe = {
  child: ActorRef<TargetMessage> | null;
  readonly stopped: { value: boolean };
};

const newParentProbe = (): ParentProbe => ({ child: null, stopped: { value: false } });

let parentProbe: ParentProbe = newParentProbe();

class DyingTarget extends Actor<TargetMessage> {
  override onReceive(m: TargetMessage): void {
    match(m)
      .with({ kind: 'die' }, () => this.onDie())
      .exhaustive();
  }

  private onDie(): void {
    this.self.stop();
  }
}

/**
 * Holds the dying actor as a child so its teardown becomes observable: a parent
 * drops a child from `_children` only when that child's `childTerminated`
 * reaches it, and finishes stopping only once the map is empty.  So this
 * actor's `postStop` running *is* the assertion that the child completed its
 * own termination.
 */
class TargetParent extends Actor<NoopMessage> {
  override preStart(): void {
    parentProbe.child = this.context.spawn(DyingTarget, 'target');
  }

  override onReceive(m: NoopMessage): void {
    match(m)
      .with({ kind: 'noop' }, () => this.onNoop())
      .exhaustive();
  }

  private onNoop(): void {}

  override postStop(): void {
    parentProbe.stopped.value = true;
  }
}

/** Watches on demand, then parks in a handler so its queue backs up. */
class BlockingWatcher extends Actor<WatcherMessage> {
  override async onReceive(m: WatcherMessage): Promise<void> {
    await match(m)
      .with(P.instanceOf(Terminated), (signal) => this.onTerminated(signal))
      .with({ kind: 'watch' }, (message) => this.onWatch(message))
      .with({ kind: 'block' }, () => this.onBlock())
      .with({ kind: 'filler' }, (message) => this.onFiller(message))
      .exhaustive();
  }

  private onTerminated(signal: Terminated): void {
    probe.seen.push(`terminated:${signal.actor.path.name}`);
  }

  private onWatch(message: WatchMessage): void {
    this.context.watch(message.target);
    probe.watched.value = true;
  }

  private async onBlock(): Promise<void> {
    probe.blocked.value = true;
    await probe.gate.opened;
  }

  private onFiller(message: FillerMessage): void {
    probe.seen.push(`filler:${message.index}`);
  }
}

/**
 * Registers its watch in `preStart`, so nothing is ever told to it.
 *
 * Needed for the mailbox that refuses every user message: telling such an actor
 * even once throws on the test's own stack, so the watch cannot be installed
 * through a message.
 */
class PreStartWatcher extends Actor<Terminated> {
  override preStart(): void {
    const child = parentProbe.child;
    if (child !== null) this.context.watch(child);
    probe.watched.value = true;
  }

  override onReceive(m: Terminated): void {
    probe.seen.push(`terminated:${m.actor.path.name}`);
  }
}

/**
 * A caller's own queue that refuses everything — the shape `_notifyWatcher`'s
 * guard exists for, and deliberately *not* an override of `enqueueSignal`: the
 * framework cannot police an arbitrary subclass, so what it owes is a visible
 * failure rather than a silent one.
 */
class RefusingMailbox<T> extends Mailbox<T> {
  override enqueue(_env: Envelope<T>): void {
    throw new Error('this mailbox refuses every user message');
  }
}

/* -------------------------------- helpers --------------------------------- */

/** The actor's queue, through the cell's test seam. */
const mailboxOf = <TMessage>(ref: ActorRef<TMessage>): Mailbox<unknown> => {
  const cell = (ref as unknown as {
    getCell(): { _mailboxForTest(): Mailbox<unknown> };
  }).getCell();
  return cell._mailboxForTest();
};

/** The same queue, read for its drop bookkeeping. */
const boundedMailboxOf = <TMessage>(ref: ActorRef<TMessage>): BoundedMailbox<unknown> =>
  mailboxOf(ref) as BoundedMailbox<unknown>;

/**
 * Spawn a watcher, register the watch, and park it with an empty queue.
 *
 * Returns once the handler has genuinely blocked — every caller's next step
 * depends on nothing draining, and `blocked` is set by the handler itself
 * rather than inferred from a delay.
 */
const parkedWatcher = async (
  sys: ActorSystem,
  target: ActorRef<TargetMessage>,
  options?: ActorOptions<WatcherMessage>,
): Promise<ActorRef<WatcherMessage>> => {
  const watcher = sys.spawn(BlockingWatcher, 'watcher', options);
  watcher.tell({ kind: 'watch', target });
  await awaitCondition(() => probe.watched.value, {
    timeoutMs: 4_000,
    label: 'the watcher registered its death watch',
  });
  watcher.tell({ kind: 'block' });
  await awaitCondition(() => probe.blocked.value, {
    timeoutMs: 4_000,
    label: 'the watcher parked inside its handler',
  });
  return watcher;
};

/* ------------------------------ the invariant ----------------------------- */

describe('a bounded watcher still learns about a death — #729', () => {
  test('drop-head cannot evict a Terminated that is already queued', async () => {
    probe = newProbe();
    const sys = newSystem('729-drop-head');
    const target = sys.spawn(DyingTarget, 'target');
    const watcherOptions = ActorOptions.create<WatcherMessage>()
      .withMailboxCapacity(4)
      .withMailboxOverflow('drop-head');
    const watcher = await parkedWatcher(sys, target, watcherOptions);
    const mailbox = boundedMailboxOf(watcher);

    target.tell({ kind: 'die' });
    await awaitCondition(() => mailbox.size >= 1, {
      timeoutMs: 4_000,
      label: 'the Terminated reached the watcher queue',
    });

    // Twice the capacity of newer traffic on top of it.  `drop-head` evicts the
    // oldest queued message and the notification is now the oldest — the
    // eviction an exempt enqueue on its own would not have prevented.
    for (let index = 0; index < 8; index++) watcher.tell({ kind: 'filler', index });
    expect(mailbox.droppedCount).toBeGreaterThan(0);
    expect(mailbox.size).toBe(4);

    probe.gate.open();
    await awaitCondition(() => probe.seen.includes('terminated:target'), {
      timeoutMs: 4_000,
      label: 'the watcher received Terminated despite the drop-head bound',
    });
    await sys.terminate();
  });

  test('drop-new cannot discard an arriving Terminated', async () => {
    probe = newProbe();
    const sys = newSystem('729-drop-new');
    const target = sys.spawn(DyingTarget, 'target');
    const watcherOptions = ActorOptions.create<WatcherMessage>()
      .withMailboxCapacity(3)
      .withMailboxOverflow('drop-new');
    const watcher = await parkedWatcher(sys, target, watcherOptions);
    const mailbox = boundedMailboxOf(watcher);

    // Full and shedding *before* the death, so the notification is the arriving
    // message `drop-new` throws away.
    for (let index = 0; index < 5; index++) watcher.tell({ kind: 'filler', index });
    expect(mailbox.droppedCount).toBe(2);
    expect(mailbox.size).toBe(3);

    target.tell({ kind: 'die' });
    // Admitted past a queue that is already at capacity — the depth is the
    // claim, and it is checked before the watcher is allowed to drain.
    await awaitCondition(() => mailbox.size === 4, {
      timeoutMs: 4_000,
      label: 'the Terminated was admitted past the full drop-new bound',
    });

    probe.gate.open();
    await awaitCondition(() => probe.seen.includes('terminated:target'), {
      timeoutMs: 4_000,
      label: 'the watcher received Terminated despite the drop-new bound',
    });
    await sys.terminate();
  });

  test('a drop-lowest-priority PriorityMailbox cannot shed a Terminated', async () => {
    probe = newProbe();
    const sys = newSystem('729-priority');
    const target = sys.spawn(DyingTarget, 'target');
    // The priority function ranks a death *last*, the adversarial case: the
    // notification is exactly what `drop-lowest-priority` would shed.
    const priorityMailbox = (): PriorityMailbox<WatcherMessage> => new PriorityMailbox<WatcherMessage>({
      priorityFor: (message) => (message instanceof Terminated ? 9 : 0),
      capacity: 2,
      overflow: 'drop-lowest-priority',
    });
    const watcherOptions = ActorOptions.create<WatcherMessage>().withMailbox(priorityMailbox);
    const watcher = await parkedWatcher(sys, target, watcherOptions);
    const mailbox = mailboxOf(watcher);

    for (let index = 0; index < 2; index++) watcher.tell({ kind: 'filler', index });
    expect(mailbox.size).toBe(2);

    target.tell({ kind: 'die' });
    await awaitCondition(() => mailbox.size === 3, {
      timeoutMs: 4_000,
      label: 'the Terminated was admitted past the full priority bound',
    });

    probe.gate.open();
    await awaitCondition(() => probe.seen.includes('terminated:target'), {
      timeoutMs: 4_000,
      label: 'the watcher received Terminated despite the priority bound',
    });
    await sys.terminate();
  });

  test("throttle onExcess 'drop' does not consume a Terminated", async () => {
    probe = newProbe();
    const sys = newSystem('729-throttle');
    const target = sys.spawn(DyingTarget, 'target');

    // One token, refilling once a second: the `watch` message spends it and
    // nothing refills within the milliseconds this test needs, so the
    // notification meets an empty bucket.  `ActorContext.throttle` has always
    // documented a `Terminated` as exempt; before #729 the code dropped it.
    class ThrottledWatcher extends Actor<WatcherMessage> {
      override preStart(): void {
        this.context.throttle({ qps: 1, burst: 1, onExcess: 'drop' });
      }

      override onReceive(m: WatcherMessage): void {
        match(m)
          .with(P.instanceOf(Terminated), (signal) => this.onTerminated(signal))
          .with({ kind: 'watch' }, (message) => this.onWatch(message))
          .with({ kind: 'block' }, () => this.onBlock())
          .with({ kind: 'filler' }, (message) => this.onFiller(message))
          .exhaustive();
      }

      private onTerminated(signal: Terminated): void {
        probe.seen.push(`terminated:${signal.actor.path.name}`);
      }

      private onWatch(message: WatchMessage): void {
        this.context.watch(message.target);
        probe.watched.value = true;
      }

      private onBlock(): void {}

      private onFiller(message: FillerMessage): void {
        probe.seen.push(`filler:${message.index}`);
      }
    }

    const watcher = sys.spawn(ThrottledWatcher, 'watcher');
    watcher.tell({ kind: 'watch', target });
    await awaitCondition(() => probe.watched.value, {
      timeoutMs: 4_000,
      label: 'the throttled watcher registered its death watch',
    });

    target.tell({ kind: 'die' });
    await awaitCondition(() => probe.seen.includes('terminated:target'), {
      timeoutMs: 4_000,
      label: 'the watcher received Terminated with an empty throttle bucket',
    });
    expect(probe.seen).toEqual(['terminated:target']);
    await sys.terminate();
  });
});

/**
 * A parent holding the dying child, plus a parked watcher whose `reject`
 * mailbox is exactly full.
 *
 * `reject` is `BoundedMailbox`'s constructor default, so the documented
 * bring-your-own-mailbox shape reaches it without naming it — and filling the
 * queue means the next arrival throws `MailboxFullError` at whoever sends it,
 * which for the death notification is the dying cell itself.
 */
const fullRejectingSetup = async (sys: ActorSystem): Promise<{
  readonly parent: ActorRef<NoopMessage>;
  readonly target: ActorRef<TargetMessage>;
  readonly mailbox: Mailbox<unknown>;
}> => {
  const parent = sys.spawn(TargetParent, 'parent');
  await awaitCondition(() => parentProbe.child !== null, {
    timeoutMs: 4_000,
    label: 'the parent spawned its child',
  });
  const target = parentProbe.child!;
  const rejectingMailbox = (): BoundedMailbox<WatcherMessage> =>
    new BoundedMailbox<WatcherMessage>({ capacity: 2 });
  const watcherOptions = ActorOptions.create<WatcherMessage>().withMailbox(rejectingMailbox);
  const watcher = await parkedWatcher(sys, target, watcherOptions);
  const mailbox = mailboxOf(watcher);
  // Exactly capacity and no more: the sender of a filler is this test, and a
  // `reject` mailbox would throw here.
  for (let index = 0; index < 2; index++) watcher.tell({ kind: 'filler', index });
  expect(mailbox.size).toBe(2);
  return { parent, target, mailbox };
};

describe("a watcher's full mailbox cannot abort the dying actor — #729", () => {
  test('reject admits the notification instead of throwing at the dying actor', async () => {
    probe = newProbe();
    parentProbe = newParentProbe();
    const sys = newSystem('729-reject-delivery');
    const { target, mailbox } = await fullRejectingSetup(sys);

    target.tell({ kind: 'die' });
    await awaitCondition(() => mailbox.size === 3, {
      timeoutMs: 4_000,
      label: 'the Terminated was admitted past the full reject bound',
    });

    probe.gate.open();
    await awaitCondition(() => probe.seen.includes('terminated:target'), {
      timeoutMs: 4_000,
      label: 'the watcher received Terminated from a full reject mailbox',
    });
    await sys.terminate();
  });

  test('a full reject mailbox does not strand the dying actor in its parent', async () => {
    probe = newProbe();
    parentProbe = newParentProbe();
    const sys = newSystem('729-reject-teardown');
    const { parent, target } = await fullRejectingSetup(sys);

    // The half that is worse than the lost notification.  `MailboxFullError`
    // used to escape `finalizeTermination` ahead of the parent's
    // `childTerminated`, so the parent kept a dead child in `_children` forever
    // and any teardown waiting on `_children.size === 0` never fired — one
    // watcher's full mailbox hanging `terminate()` for the whole tree.
    //
    // The watcher stays parked for this assertion on purpose: a child's
    // termination must not depend on its watchers draining.
    target.tell({ kind: 'die' });
    parent.stop();
    await awaitCondition(() => parentProbe.stopped.value, {
      timeoutMs: 4_000,
      label: "the dead child's parent finished its own termination",
    });

    // Released only now, so `sys.terminate()` can drain the parked watcher.
    probe.gate.open();
    await sys.terminate();
  });

  test('a mailbox that refuses everything yields a dead letter, not silence', async () => {
    probe = newProbe();
    parentProbe = newParentProbe();
    const deadLetters: DeadLetter[] = [];
    const subscribed = { value: false };
    class Listener extends Actor<DeadLetter> {
      override preStart(): void {
        this.system.eventStream.subscribe(this.self, DeadLetter);
        subscribed.value = true;
      }

      override onReceive(m: DeadLetter): void {
        deadLetters.push(m);
      }
    }

    const sys = newSystem('729-refusing');
    sys.spawn(Listener, 'listener');
    await awaitCondition(() => subscribed.value, {
      timeoutMs: 4_000,
      label: 'the dead-letter listener subscribed',
    });
    const parent = sys.spawn(TargetParent, 'parent');
    await awaitCondition(() => parentProbe.child !== null, {
      timeoutMs: 4_000,
      label: 'the parent spawned its child',
    });

    const refusingMailbox = (): RefusingMailbox<Terminated> => new RefusingMailbox<Terminated>();
    const watcherOptions = ActorOptions.create<Terminated>().withMailbox(refusingMailbox);
    sys.spawn(PreStartWatcher, 'watcher', watcherOptions);
    await awaitCondition(() => probe.watched.value, {
      timeoutMs: 4_000,
      label: 'the refusing watcher registered its death watch',
    });

    parentProbe.child!.tell({ kind: 'die' });
    await awaitCondition(
      () => deadLetters.some((letter) => letter.message instanceof Terminated),
      { timeoutMs: 4_000, label: 'the refused Terminated became a dead letter' },
    );

    parent.stop();
    await awaitCondition(() => parentProbe.stopped.value, {
      timeoutMs: 4_000,
      label: "the dead child's parent finished its own termination",
    });
    await sys.terminate();
  });
});

/* ------------------------- the ordering counterweight --------------------- */

describe('the notification keeps its place in the user queue — #729', () => {
  test('tells queued before the death are handled before the Terminated', async () => {
    probe = newProbe();
    const sys = newSystem('729-ordering');
    const target = sys.spawn(DyingTarget, 'target');
    const watcher = await parkedWatcher(sys, target);
    const mailbox = mailboxOf(watcher);

    for (let index = 0; index < 3; index++) watcher.tell({ kind: 'filler', index });
    expect(mailbox.size).toBe(3);

    target.tell({ kind: 'die' });
    await awaitCondition(() => mailbox.size === 4, {
      timeoutMs: 4_000,
      label: 'the Terminated joined the queue behind them',
    });

    probe.gate.open();
    await awaitCondition(() => probe.seen.length === 4, {
      timeoutMs: 4_000,
      label: 'the watcher drained its queue',
    });
    // `fundamentals/death-watch.mdx` promises exactly this order.  A fix that
    // moved the notification onto the system queue would deliver it first —
    // and under `watchWith` that is a *domain* message overtaking user traffic.
    expect(probe.seen).toEqual(['filler:0', 'filler:1', 'filler:2', 'terminated:target']);
    await sys.terminate();
  });
});

/* --------------------------- the lane, per mailbox ------------------------ */

describe('Mailbox.enqueueSignal — the exempt lane itself', () => {
  const signal = (label: string): Envelope<string> => ({
    message: label,
    sender: null,
    undroppable: true,
  });

  test('the base queue treats it as an ordinary tail append', () => {
    const mailbox = new Mailbox<string>();
    mailbox.enqueue({ message: 'first', sender: null });
    mailbox.enqueueSignal(signal('death'));
    expect(mailbox.drainUser().map((env) => env.message)).toEqual(['first', 'death']);
  });

  test('drop-head steps over it and evicts the oldest droppable instead', () => {
    const mailbox = new BoundedMailbox<string>({ capacity: 3, overflow: 'drop-head' });
    mailbox.enqueueSignal(signal('death'));
    for (const label of ['a', 'b', 'c', 'd']) mailbox.enqueue({ message: label, sender: null });
    expect(mailbox.drainUser().map((env) => env.message)).toEqual(['death', 'c', 'd']);
    expect(mailbox.droppedCount).toBe(2);
  });

  test('drop-new admits it even though the queue is full', () => {
    const mailbox = new BoundedMailbox<string>({ capacity: 2, overflow: 'drop-new' });
    for (const label of ['a', 'b']) mailbox.enqueue({ message: label, sender: null });
    mailbox.enqueueSignal(signal('death'));
    expect(mailbox.drainUser().map((env) => env.message)).toEqual(['a', 'b', 'death']);
    expect(mailbox.droppedCount).toBe(0);
  });

  test('reject does not throw for it', () => {
    const mailbox = new BoundedMailbox<string>({ capacity: 1 });
    mailbox.enqueue({ message: 'a', sender: null });
    expect(() => mailbox.enqueue({ message: 'b', sender: null })).toThrow();
    expect(() => mailbox.enqueueSignal(signal('death'))).not.toThrow();
    expect(mailbox.drainUser().map((env) => env.message)).toEqual(['a', 'death']);
  });

  test('a queue of nothing but signals overshoots its bound rather than losing one', () => {
    const mailbox = new BoundedMailbox<string>({ capacity: 2, overflow: 'drop-head' });
    mailbox.enqueueSignal(signal('death-1'));
    mailbox.enqueueSignal(signal('death-2'));
    mailbox.enqueue({ message: 'a', sender: null });
    // Overshoot bounded by the number of notifications, which is bounded by the
    // watch set.  The alternative is losing one of them.
    expect(mailbox.size).toBe(3);
    expect(mailbox.droppedCount).toBe(0);
    expect(mailbox.drainUser().map((env) => env.message)).toEqual(['death-1', 'death-2', 'a']);
  });

  test('a priority bound sheds the least important droppable entry, never a signal', () => {
    const mailbox = new PriorityMailbox<string>({
      // The signal ranks last, so it is exactly what the policy would shed.
      priorityFor: (message) => (message.startsWith('death') ? 9 : 0),
      capacity: 2,
      overflow: 'drop-lowest-priority',
    });
    for (const label of ['a', 'b']) mailbox.enqueue({ message: label, sender: null });
    mailbox.enqueueSignal(signal('death'));
    expect(mailbox.size).toBe(3);
    mailbox.enqueue({ message: 'c', sender: null });
    expect(mailbox.drainUser().map((env) => env.message)).toEqual(['a', 'b', 'death']);
    expect(mailbox.droppedCount).toBe(1);
  });
});
