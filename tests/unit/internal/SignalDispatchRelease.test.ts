/**
 * A signal envelope may carry a release, and the cell calls it as the message
 * is handed to the behavior (#1468).
 *
 * The sender this exists for coalesces: a latest-value slot keeps at most one
 * notification per subscriber queued and overwrites it in place while it
 * waits, so the subscriber's own mailbox paces the notifications and no timer
 * does.  That only works if the sender learns the moment its queued message
 * stops being overwritable — once the behavior holds it, the next change has
 * to become a fresh message, or the value is merged into a message that is
 * already being handled and is lost.  Nothing else in the tree says when that
 * moment is: a `tell` only enqueues.
 *
 * So most cases here are about *when* the release fires relative to the
 * behavior — and in which order against a microtask queued from inside it,
 * which is what tells "one synchronous step" apart from "soon after" — and
 * about the envelopes it must never fire for: the ones that dead-letter
 * instead of being handled, after which the cell must not keep the callback.
 * The rest pin the seam itself: the cell holds nothing while no release is
 * pending, a release that throws costs neither the message nor the
 * recipient, a mailbox that refuses the envelope leaves nothing behind, and a
 * message still waiting on one release cannot be given a second.
 *
 * Every case runs the recipient's handler on one side of the receive path's
 * fork or both, because the release has to fire before the fork is reached:
 * an implementation that released from the success tail would be right for a
 * synchronous handler and wrong for an asynchronous one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match, P } from 'ts-pattern';
import { Actor } from '../../../src/Actor.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { LocalActorRef } from '../../../src/internal/LocalActorRef.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Mailbox } from '../../../src/mailbox/index.js';
import { Directive, OneForOneStrategy, type SupervisorStrategy } from '../../../src/Supervision.js';
import { DeadLetter, Terminated } from '../../../src/SystemMessages.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/* ----------------------------- test protocol ------------------------------ */

type ChangedMessage = { readonly kind: 'changed'; readonly value: number };
type ProbeMessage = { readonly kind: 'probe'; readonly label: string };
type RecipientMessage = ChangedMessage | ProbeMessage | Terminated;
type StasherMessage = ChangedMessage | ProbeMessage;

const changed = (value: number): ChangedMessage => ({ kind: 'changed', value });
const probe = (label: string): ProbeMessage => ({ kind: 'probe', label });

/** Which side of the receive path's fork a handler returns on. */
type HandlerKind = 'synchronous' | 'asynchronous';
const HANDLER_KINDS: ReadonlyArray<HandlerKind> = ['synchronous', 'asynchronous'];

/** Holds a recipient's turn open until the test opens it, so the queue behind it can be shaped. */
type Gate = { readonly opened: Promise<void>; readonly open: () => void };

/**
 * Every gate a case made, so teardown can open the ones a failing assertion
 * left shut: a turn held open forever also holds `system.terminate()`, and the
 * case would then report a hook timeout instead of its own failure.
 */
const gates: Gate[] = [];

const newGate = (): Gate => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  const gate = { opened, open };
  gates.push(gate);
  return gate;
};

/** A release that writes itself into the journal the recipient writes to, and counts its calls. */
type ReleaseProbe = { readonly calls: { value: number }; readonly release: () => void };

const releaseInto = (journal: string[], label: string, alsoOnRelease?: () => void): ReleaseProbe => {
  const calls = { value: 0 };
  const release = (): void => {
    calls.value++;
    journal.push(`release:${label}`);
    alsoOnRelease?.();
  };
  return { calls, release };
};

/** Where a supervising parent hands out the child it spawned. */
type ChildHandle = { ref: LocalActorRef<RecipientMessage> | null };

/* --------------------------------- actors --------------------------------- */

/**
 * Records what it is handed, at the entry of its handler, into the journal the
 * releases write to — so one array says which of the two happened first.
 */
class Recipient extends Actor<RecipientMessage> {
  constructor(
    private readonly journal: string[],
    private readonly handlerKind: HandlerKind = 'synchronous',
    private readonly gate: Gate | null = null,
  ) { super(); }

  override onReceive(message: RecipientMessage): void | Promise<void> {
    return match(message)
      .with({ kind: 'changed' }, (m) => this.onChanged(m))
      .with({ kind: 'probe' }, (m) => this.onProbe(m))
      .with(P.instanceOf(Terminated), (m) => this.onTerminated(m))
      .exhaustive();
  }

  private onChanged(message: ChangedMessage): void | Promise<void> {
    this.journal.push(`receive:${message.value}`);
    return this.finish();
  }

  private onProbe(message: ProbeMessage): void | Promise<void> {
    this.journal.push(`receive:${message.label}`);
    if (message.label === 'hold' && this.gate !== null) return this.gate.opened;
    return this.finish();
  }

  private onTerminated(message: Terminated): void {
    this.journal.push(`terminated:${message.actor.path.name}`);
  }

  /** Nothing for a synchronous handler, an already-settled promise for an asynchronous one. */
  private finish(): void | Promise<void> {
    return this.handlerKind === 'asynchronous' ? Promise.resolve() : undefined;
  }
}

/** Fails on every `changed`, synchronously or by rejecting, after recording that it was handed it. */
class Thrower extends Actor<RecipientMessage> {
  constructor(
    private readonly journal: string[],
    private readonly handlerKind: HandlerKind,
  ) { super(); }

  override onReceive(message: RecipientMessage): void | Promise<void> {
    return match(message)
      .with({ kind: 'changed' }, (m) => this.onChanged(m))
      .with({ kind: 'probe' }, (m) => this.onProbe(m))
      .with(P.instanceOf(Terminated), () => this.onTerminated())
      .exhaustive();
  }

  private onChanged(message: ChangedMessage): void | Promise<void> {
    this.journal.push(`receive:${message.value}`);
    const failure = new Error(`boom:${message.value}`);
    if (this.handlerKind === 'asynchronous') return Promise.reject(failure);
    throw failure;
  }

  private onProbe(message: ProbeMessage): void {
    this.journal.push(`receive:${message.label}`);
  }

  private onTerminated(): void {
    this.journal.push('terminated');
  }
}

/** Stashes the first `changed` it sees and handles it once a `replay` probe unstashes it. */
class Stasher extends Actor<StasherMessage> {
  private stashedOnce = false;

  constructor(private readonly journal: string[]) { super(); }

  override onReceive(message: StasherMessage): void {
    match(message)
      .with({ kind: 'changed' }, (m) => this.onChanged(m))
      .with({ kind: 'probe' }, (m) => this.onProbe(m))
      .exhaustive();
  }

  private onChanged(message: ChangedMessage): void {
    if (!this.stashedOnce) {
      this.stashedOnce = true;
      this.journal.push(`stash:${message.value}`);
      this.context.stash();
      return;
    }
    this.journal.push(`receive:${message.value}`);
  }

  private onProbe(message: ProbeMessage): void {
    this.journal.push(`receive:${message.label}`);
    if (message.label === 'replay') this.context.unstashAll();
  }
}

/** Spawns one child and records every failure it supervises, resuming the child each time. */
class Supervising extends Actor<'start'> {
  constructor(
    private readonly child: () => Actor<RecipientMessage>,
    private readonly failures: string[],
    private readonly handle: ChildHandle,
  ) { super(); }

  override supervisorStrategy(): SupervisorStrategy {
    return new OneForOneStrategy((error) => {
      this.failures.push((error as Error).message);
      return Directive.Resume;
    }, { maxRetries: -1 });
  }

  override onReceive(): void {
    this.handle.ref = this.context.spawn(this.child, 'child') as LocalActorRef<RecipientMessage>;
  }
}

/** Records every dead letter one system publishes. */
class DeadLetterCollector extends Actor<DeadLetter> {
  constructor(
    private readonly letters: DeadLetter[],
    private readonly ready: { value: boolean },
  ) { super(); }

  override preStart(): void {
    this.system.eventStream.subscribe(this.self, DeadLetter);
    this.ready.value = true;
  }

  override onReceive(letter: DeadLetter): void { this.letters.push(letter); }
}

/** A queue that refuses every signal, the way a third-party bound that ignores the exemption would. */
class RefusingMailbox<T> extends Mailbox<T> {
  override enqueueSignal(): void {
    throw new Error('refused by the mailbox');
  }
}

/* -------------------------------- helpers --------------------------------- */

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.open();
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

function newSystem(name: string, logger: RecordingLogger | null = null): ActorSystem {
  const systemOptions = logger === null
    ? ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
    : ActorSystemOptions.create()
      .withLogger(logger)
      .withLogLevel(LogLevel.Debug);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  return system;
}

function spawnRecipient(
  system: ActorSystem,
  journal: string[],
  handlerKind: HandlerKind = 'synchronous',
  gate: Gate | null = null,
  options?: ActorOptions<RecipientMessage>,
): LocalActorRef<RecipientMessage> {
  return system.spawn(() => new Recipient(journal, handlerKind, gate), 'recipient', options) as LocalActorRef<RecipientMessage>;
}

/** Subscribe before the case runs, so nothing it publishes can be missed. */
async function collectDeadLetters(system: ActorSystem): Promise<DeadLetter[]> {
  const letters: DeadLetter[] = [];
  const ready = { value: false };
  system.spawn(() => new DeadLetterCollector(letters, ready), 'dead-letter-collector');
  await awaitCondition(() => ready.value, {
    timeoutMs: 4_000,
    label: 'the collector subscribed to the event stream',
  });
  return letters;
}

/** A parent that resumes its child on every failure, and the child it spawned. */
async function supervisedChild(
  system: ActorSystem,
  child: () => Actor<RecipientMessage>,
  failures: string[],
): Promise<LocalActorRef<RecipientMessage>> {
  const handle: ChildHandle = { ref: null };
  system.spawn(() => new Supervising(child, failures, handle), 'parent').tell('start');
  await awaitCondition(() => handle.ref !== null, { timeoutMs: 4_000, label: 'the parent spawned its child' });
  return handle.ref!;
}

/* ---------------------------- when it fires ------------------------------- */

describe('the release fires as the behavior is handed the message — #1468', () => {
  for (const handlerKind of HANDLER_KINDS) {
    test(`once, in the recipient's turn, immediately before the behavior (${handlerKind} handler)`, async () => {
      const system = newSystem(`release-order-${handlerKind}`);
      const journal: string[] = [];
      const ref = spawnRecipient(system, journal, handlerKind);
      // A microtask queued from inside the release.  Had the cell reached the
      // behavior through any hop of its own — a message back, a promise — this
      // would run before the behavior did.  It lands after the behavior's
      // entry only if the release and the hand-over are one synchronous step.
      const { calls, release } = releaseInto(journal, '1', () => {
        queueMicrotask(() => journal.push('microtask-queued-by-release'));
      });

      ref.tell(probe('before'));
      ref.getCell().postSignalEnvelope({ message: changed(1), sender: null }, release);
      ref.tell(probe('after'));
      // Not on the sender's stack: the post returns with nothing released.
      expect(calls.value).toBe(0);

      await awaitCondition(() => journal.includes('receive:after'), {
        timeoutMs: 4_000,
        label: 'the message queued behind the signal was handled',
      });

      expect(calls.value).toBe(1);
      const releasedAt = journal.indexOf('release:1');
      // In the recipient's turn, between the message ahead of it and its own
      // hand-over — so the behavior observes the release already done.
      expect(journal.indexOf('receive:before')).toBeLessThan(releasedAt);
      expect(journal[releasedAt + 1]).toBe('receive:1');
      expect(journal.indexOf('microtask-queued-by-release')).toBeGreaterThan(releasedAt + 1);
      expect(journal.filter((entry) => entry === 'release:1')).toHaveLength(1);
    });
  }

  test('an instrumented recipient — whose arrival stamp copies the envelope — still releases', async () => {
    // With an explain plan on, the cell stamps arrivals by copying the envelope
    // on its way into the queue, so the object the behavior is handed is not
    // the one the door built.  A release keyed on the envelope would never be
    // found again, and a sender waiting on it would wait forever.
    const system = newSystem('release-instrumented');
    const journal: string[] = [];
    const ref = spawnRecipient(system, journal);
    ref.getCell().enableExplainPlan({});
    const { calls, release } = releaseInto(journal, '1');

    ref.getCell().postSignalEnvelope({ message: changed(1), sender: null }, release);
    await awaitCondition(() => journal.includes('receive:1'), {
      timeoutMs: 4_000,
      label: 'the instrumented recipient handled the signal',
    });

    expect(calls.value).toBe(1);
    expect(journal).toEqual(['release:1', 'receive:1']);
    expect(ref.getCell().explainPlan().map((entry) => entry.outcome)).toEqual(['ok']);
  });
});

/* -------------------------- when it never fires --------------------------- */

describe('a release whose message is never handled is never called — #1468', () => {
  test('the recipient had already terminated when the signal was posted', async () => {
    const system = newSystem('release-terminated-before');
    const letters = await collectDeadLetters(system);
    const ref = spawnRecipient(system, []);
    const cell = ref.getCell();
    ref.stop();
    await awaitCondition(() => cell.isTerminated(), { timeoutMs: 4_000, label: 'the recipient terminated' });

    const message = changed(1);
    let calls = 0;
    cell.postSignalEnvelope({ message, sender: null }, () => { calls++; });
    await awaitCondition(() => letters.some((letter) => letter.message === message), {
      timeoutMs: 4_000,
      label: 'the signal reached dead letters',
    });

    expect(calls).toBe(0);
    expect(cell._pendingReleasesForTest()).toBeNull();
  });

  test('the recipient stopped with the signal still queued', async () => {
    const system = newSystem('release-stopped-queued');
    const letters = await collectDeadLetters(system);
    const journal: string[] = [];
    const ref = spawnRecipient(system, journal);
    const cell = ref.getCell();
    ref.tell(probe('started'));
    await awaitCondition(() => journal.includes('receive:started'), {
      timeoutMs: 4_000,
      label: 'the recipient handled its first message',
    });

    // The stop is queued first, so the termination drain is what reaches the
    // signal rather than the behavior.
    const message = changed(1);
    let calls = 0;
    ref.stop();
    cell.postSignalEnvelope({ message, sender: null }, () => { calls++; });
    // Held while the envelope waits: the control that makes "nothing held
    // afterwards" mean the termination let go of it.
    expect(cell._pendingReleasesForTest()?.size).toBe(1);

    await awaitCondition(() => letters.some((letter) => letter.message === message), {
      timeoutMs: 4_000,
      label: 'the queued signal reached dead letters',
    });

    expect(calls).toBe(0);
    expect(journal).toEqual(['receive:started']);
    expect(cell.isTerminated()).toBe(true);
    expect(cell._pendingReleasesForTest()).toBeNull();
  });

  test('the cell refuses the signal at dispatch and dead-letters it instead', async () => {
    // An unbranded `Terminated` is refused by provenance before any behavior
    // runs (#769) — a dead letter that happens inside the dispatch rather than
    // at the door or in the termination drain.
    const system = newSystem('release-refused-at-dispatch');
    const letters = await collectDeadLetters(system);
    const journal: string[] = [];
    const ref = spawnRecipient(system, journal);
    const cell = ref.getCell();
    const stranger = system.spawn(() => new Recipient([]), 'stranger');

    const forged = new Terminated(stranger);
    let calls = 0;
    cell.postSignalEnvelope({ message: forged, sender: null }, () => { calls++; });
    ref.tell(probe('after'));
    await awaitCondition(() => journal.includes('receive:after'), {
      timeoutMs: 4_000,
      label: 'the message behind the refused signal was handled',
    });
    await awaitCondition(() => letters.some((letter) => letter.message === forged), {
      timeoutMs: 4_000,
      label: 'the refused signal reached dead letters',
    });

    expect(calls).toBe(0);
    expect(journal).toEqual(['receive:after']);
    expect(cell._pendingReleasesForTest()).toBeNull();
  });
});

/* -------------------------- once, and only once --------------------------- */

describe('one release per message, however its handling goes — #1468', () => {
  test('one release across a stash and unstashAll round trip — the first dispatch only', async () => {
    const system = newSystem('release-stash');
    const journal: string[] = [];
    const ref = system.spawn(() => new Stasher(journal), 'stasher') as LocalActorRef<StasherMessage>;
    const { calls, release } = releaseInto(journal, '1');

    ref.getCell().postSignalEnvelope({ message: changed(1), sender: null }, release);
    await awaitCondition(() => journal.includes('stash:1'), {
      timeoutMs: 4_000,
      label: 'the stasher parked the signal',
    });
    ref.tell(probe('replay'));
    await awaitCondition(() => journal.includes('receive:1'), {
      timeoutMs: 4_000,
      label: 'the replayed signal was handled',
    });

    expect(journal).toEqual(['release:1', 'stash:1', 'receive:replay', 'receive:1']);
    expect(calls.value).toBe(1);
    expect(ref.getCell()._pendingReleasesForTest()).toBeNull();
  });

  for (const handlerKind of HANDLER_KINDS) {
    test(`one release when the handler fails on that message (${handlerKind} handler)`, async () => {
      const system = newSystem(`release-throw-${handlerKind}`);
      const journal: string[] = [];
      const failures: string[] = [];
      const ref = await supervisedChild(system, () => new Thrower(journal, handlerKind), failures);
      const { calls, release } = releaseInto(journal, '1');

      ref.getCell().postSignalEnvelope({ message: changed(1), sender: null }, release);
      ref.tell(probe('after'));
      await awaitCondition(() => journal.includes('receive:after'), {
        timeoutMs: 4_000,
        label: 'the resumed child handled the next message',
      });

      // Released before the handler ran, so the failure could not skip it.
      expect(journal).toEqual(['release:1', 'receive:1', 'receive:after']);
      expect(failures).toEqual(['boom:1']);
      expect(calls.value).toBe(1);
    });
  }
});

/* ------------------------ it rides the exempt door ------------------------ */

describe('a releasable signal keeps the exemption from the bound — #1468, #729', () => {
  const boundedOptions = (): ActorOptions<RecipientMessage> => ActorOptions.create<RecipientMessage>()
    .withMailboxCapacity(1)
    .withMailboxOverflow('drop-head');

  test('the control: a plain tell waiting in a full drop-head queue is evicted by the next one', async () => {
    const system = newSystem('release-bound-control');
    const journal: string[] = [];
    const gate = newGate();
    const ref = spawnRecipient(system, journal, 'synchronous', gate, boundedOptions());
    ref.tell(probe('hold'));
    await awaitCondition(() => journal.includes('receive:hold'), {
      timeoutMs: 4_000,
      label: 'the recipient is holding its turn',
    });

    ref.tell(probe('first'));
    ref.tell(probe('second'));
    gate.open();
    await awaitCondition(() => journal.includes('receive:second'), {
      timeoutMs: 4_000,
      label: 'the surviving tell was handled',
    });

    expect(journal).toEqual(['receive:hold', 'receive:second']);
  });

  test('a releasable signal in the same place is stepped over, and still releases', async () => {
    const system = newSystem('release-bound-signal');
    const journal: string[] = [];
    const gate = newGate();
    const ref = spawnRecipient(system, journal, 'synchronous', gate, boundedOptions());
    ref.tell(probe('hold'));
    await awaitCondition(() => journal.includes('receive:hold'), {
      timeoutMs: 4_000,
      label: 'the recipient is holding its turn',
    });

    const { calls, release } = releaseInto(journal, '1');
    ref.getCell().postSignalEnvelope({ message: changed(1), sender: null }, release);
    ref.tell(probe('later'));
    gate.open();
    await awaitCondition(() => journal.includes('receive:later'), {
      timeoutMs: 4_000,
      label: 'the later tell was handled',
    });

    expect(journal).toEqual(['receive:hold', 'release:1', 'receive:1', 'receive:later']);
    expect(calls.value).toBe(1);
  });
});

/* ------------------------------- the seam --------------------------------- */

describe('the seam holds nothing it does not need — #1468', () => {
  test('nothing is held before a releasable signal arrives, nor after its release fires', async () => {
    const system = newSystem('release-held-window');
    const journal: string[] = [];
    const gate = newGate();
    const ref = spawnRecipient(system, journal, 'synchronous', gate);
    const cell = ref.getCell();
    ref.tell(probe('hold'));
    await awaitCondition(() => journal.includes('receive:hold'), {
      timeoutMs: 4_000,
      label: 'the recipient is holding its turn',
    });
    // Ordinary traffic leaves the gate the receive path tests at its cheapest.
    expect(cell._pendingReleasesForTest()).toBeNull();

    const message = changed(1);
    const { release } = releaseInto(journal, '1');
    cell.postSignalEnvelope({ message, sender: null }, release);
    expect(cell._pendingReleasesForTest()?.get(message)).toBe(release);

    gate.open();
    await awaitCondition(() => journal.includes('receive:1'), {
      timeoutMs: 4_000,
      label: 'the signal was handled',
    });
    // Back to `null`, not to an empty map: an empty map would keep every later
    // message paying the lookup.
    expect(cell._pendingReleasesForTest()).toBeNull();
  });

  test('a release that throws is logged, and costs neither the message nor the recipient', async () => {
    const logger = new RecordingLogger();
    const system = newSystem('release-throws', logger);
    const journal: string[] = [];
    const failures: string[] = [];
    const ref = await supervisedChild(system, () => new Recipient(journal), failures);

    ref.getCell().postSignalEnvelope({ message: changed(1), sender: null }, () => {
      journal.push('release:1');
      throw new Error('a defect in the sender');
    });
    ref.tell(probe('after'));
    await awaitCondition(() => journal.includes('receive:after'), {
      timeoutMs: 4_000,
      label: 'the recipient handled the message behind the signal',
    });

    expect(journal).toEqual(['release:1', 'receive:1', 'receive:after']);
    expect(failures).toEqual([]);
    expect(logger.records.some((record) => record.level === 'error' && record.message.includes('release'))).toBe(true);
  });

  test('a mailbox that refuses the signal leaves no release behind', () => {
    const system = newSystem('release-mailbox-refuses');
    const options = ActorOptions.create<RecipientMessage>().withMailbox(() => new RefusingMailbox<RecipientMessage>());
    const ref = spawnRecipient(system, [], 'synchronous', null, options);
    const cell = ref.getCell();
    const message = changed(1);
    let calls = 0;

    expect(() => cell.postSignalEnvelope({ message, sender: null }, () => { calls++; }))
      .toThrow('refused by the mailbox');
    expect(cell._pendingReleasesForTest()).toBeNull();
    // Nothing lingers to be mistaken for a pending release: the same message
    // meets the mailbox's refusal again, not a refusal of a second release.
    expect(() => cell.postSignalEnvelope({ message, sender: null }, () => { calls++; }))
      .toThrow('refused by the mailbox');
    expect(calls).toBe(0);
  });

  test('a message still waiting on its release cannot be posted with a second one', async () => {
    const system = newSystem('release-second-refused');
    const journal: string[] = [];
    const gate = newGate();
    const ref = spawnRecipient(system, journal, 'synchronous', gate);
    const cell = ref.getCell();
    ref.tell(probe('hold'));
    await awaitCondition(() => journal.includes('receive:hold'), {
      timeoutMs: 4_000,
      label: 'the recipient is holding its turn',
    });

    const message = changed(1);
    const first = releaseInto(journal, 'first');
    const second = releaseInto(journal, 'second');
    cell.postSignalEnvelope({ message, sender: null }, first.release);
    // Keyed by the message, so a second release would replace the first — and
    // the first sender would wait for a call that never comes.
    expect(() => cell.postSignalEnvelope({ message, sender: null }, second.release)).toThrow('already waiting');

    gate.open();
    await awaitCondition(() => journal.includes('receive:1'), {
      timeoutMs: 4_000,
      label: 'the signal was handled',
    });

    expect(journal).toEqual(['receive:hold', 'release:first', 'receive:1']);
    expect(first.calls.value).toBe(1);
    expect(second.calls.value).toBe(0);
  });
});
