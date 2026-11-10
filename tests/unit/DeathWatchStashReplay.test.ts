/**
 * What a stashed death notification does when it comes back round (#1098).
 *
 * Stashing is how an actor says "not now"; the contract is that the message
 * returns on `unstashAll()`.  A death-watch notification was the one message
 * for which that was false in both directions at once, and silently: the cell
 * retires the watch registration *before* it invokes the behavior, so the
 * replayed signal arrives at a cell that is — by then — no longer watching
 * anything, and the gate that exists to refuse an unrelated actor's death
 * consumed it without a trace.  An actor that parked a death while it was busy
 * simply never heard about it again, and nothing anywhere said so.
 *
 * Two changes answer that, and the tests below are one per door.
 *
 * **Under `watchWith` the parked message is the domain message.**  The
 * substitution happens inside the dispatch, so `stash()` used to park the
 * envelope the cell *received* — the `Terminated` — rather than the one the
 * behavior was handed.  Parking the delivered copy instead makes the replay an
 * ordinary user message, which is what `watchWith` promised in the first
 * place: the watcher asked to be told about the death in its own protocol, and
 * a protocol message is not something the death-watch gate has an opinion
 * about.  The envelope the trace and the explain plan recorded for the
 * *original* dispatch is untouched — that one still names the death.
 *
 * **Under a plain `watch` the parked message really is the signal**, and there
 * is nothing to substitute it with: the registration is gone by the time the
 * replay lands, so the cell cannot tell it apart from a death it never asked
 * for.  It becomes a dead letter — the same answer the branch beside it
 * already gave a `Terminated` with no provenance, and the answer
 * `fundamentals/death-watch.mdx` promises for a notification that cannot be
 * delivered.  Visible rather than silent is the whole of the improvement here;
 * redelivering it would mean keeping the registration alive across the stash,
 * which is a different change (#1319 carries the seam the typed half of it
 * needs).
 *
 * Both doors are tested twice, once through `ActorContext.stash()` and once
 * through the typed DSL's `Behaviors.withStash`, because the two park
 * different things — the envelope and a bare message — and that difference is
 * exactly what used to make them disagree.
 */
import { describe, expect, test } from 'bun:test';
import { match, P } from 'ts-pattern';
import { Actor } from '../../src/Actor.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { DeadLetter, Terminated } from '../../src/SystemMessages.js';
import {
  Behaviors,
  typedActor,
  type Behavior,
  type StashBuffer,
  type TypedActorContext,
} from '../../src/typed/index.js';
import { awaitCondition } from '../util/AwaitCondition.js';

const newSystem = (name: string): ActorSystem => {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, systemOptions);
};

/* ------------------------------ test protocol ----------------------------- */

type DieMessage = { readonly kind: 'die' };
type SubjectMessage = DieMessage;

type WatchMessage = { readonly kind: 'watch'; readonly subject: ActorRef<SubjectMessage> };
type OpenMessage = { readonly kind: 'open' };
type WorkerLostMessage = { readonly kind: 'workerLost'; readonly name: string };
type WatcherMessage = WatchMessage | OpenMessage | WorkerLostMessage | Terminated;

/** What one test observes about its watcher; one instance per test. */
type WatcherProbe = {
  /** Everything the behavior was handed after the watch was registered. */
  readonly seen: string[];
  /** Set once the first death notification has been parked. */
  readonly parked: { value: boolean };
  /** Set once `unstashAll()` has returned. */
  readonly replayed: { value: boolean };
};

const newProbe = (): WatcherProbe => ({ seen: [], parked: { value: false }, replayed: { value: false } });

/** The watched actor: stops itself on demand, and nothing else. */
class Subject extends Actor<SubjectMessage> {
  override onReceive(m: SubjectMessage): void {
    match(m)
      .with({ kind: 'die' }, () => this.onDie())
      .exhaustive();
  }

  private onDie(): void { this.self.stop(); }
}

/**
 * The reproduction from the issue body, as an actor.
 *
 * It is "closed" until an `open` arrives, and parks anything that turns up
 * before then — which is the ordinary shape of the stash, and the reason a
 * death notification meets it at all.  `watchWith` or plain `watch` is a
 * constructor argument, so both doors run the same handler.
 */
class ParkingWatcher extends Actor<WatcherMessage> {
  private open = false;

  constructor(
    private readonly probe: WatcherProbe,
    private readonly lostMessage: WorkerLostMessage | null,
  ) { super(); }

  override onReceive(m: WatcherMessage): void {
    match(m)
      .with(P.instanceOf(Terminated), (signal) => this.onTerminated(signal))
      .with({ kind: 'watch' }, (message) => this.onWatch(message))
      .with({ kind: 'open' }, () => this.onOpen())
      .with({ kind: 'workerLost' }, (message) => this.onWorkerLost(message))
      .exhaustive();
  }

  private onWatch(message: WatchMessage): void {
    if (this.lostMessage === null) this.context.watch(message.subject);
    else this.context.watchWith(message.subject, this.lostMessage);
    this.probe.seen.push('watching');
  }

  private onOpen(): void {
    this.open = true;
    this.context.unstashAll();
    this.probe.replayed.value = true;
  }

  private onTerminated(signal: Terminated): void {
    if (this.open) {
      this.probe.seen.push(`replayed:${signal.actor.path.name}`);
      return;
    }
    this.context.stash();
    this.probe.parked.value = true;
  }

  private onWorkerLost(message: WorkerLostMessage): void {
    if (this.open) {
      this.probe.seen.push(`workerLost:${message.name}`);
      return;
    }
    this.context.stash();
    this.probe.parked.value = true;
  }
}

/* --------------------------- the typed mirror ------------------------------ */

const onTypedWatch = (
  context: TypedActorContext<WatcherMessage>,
  probe: WatcherProbe,
  lostMessage: WorkerLostMessage | null,
  message: WatchMessage,
): Behavior<WatcherMessage> => {
  if (lostMessage === null) context.watch(message.subject);
  else context.watchWith(message.subject, lostMessage);
  probe.seen.push('watching');
  return Behaviors.same;
};

const onTypedTerminated = (
  probe: WatcherProbe,
  stash: StashBuffer<WatcherMessage>,
  open: { value: boolean },
  signal: Terminated,
): Behavior<WatcherMessage> => {
  if (open.value) {
    probe.seen.push(`replayed:${signal.actor.path.name}`);
    return Behaviors.same;
  }
  stash.stash(signal);
  probe.parked.value = true;
  return Behaviors.same;
};

const onTypedWorkerLost = (
  probe: WatcherProbe,
  stash: StashBuffer<WatcherMessage>,
  open: { value: boolean },
  message: WorkerLostMessage,
): Behavior<WatcherMessage> => {
  if (open.value) {
    probe.seen.push(`workerLost:${message.name}`);
    return Behaviors.same;
  }
  stash.stash(message);
  probe.parked.value = true;
  return Behaviors.same;
};

const onTypedOpen = (
  probe: WatcherProbe,
  stash: StashBuffer<WatcherMessage>,
  open: { value: boolean },
): Behavior<WatcherMessage> => {
  open.value = true;
  stash.unstashAll();
  probe.replayed.value = true;
  return Behaviors.same;
};

/**
 * The typed mirror of {@link ParkingWatcher}.
 *
 * No `onSignal`: `TypedActor` routes a `Terminated` to the signal handler only
 * when one is installed, and this behavior wants the notification as a
 * *message* — which is what makes it stashable through `StashBuffer` at all.
 */
const typedParkingWatcher = (
  probe: WatcherProbe,
  lostMessage: WorkerLostMessage | null,
): Behavior<WatcherMessage> => {
  const open = { value: false };
  return Behaviors.withStash<WatcherMessage>(4, (stash) =>
    Behaviors.receive<WatcherMessage>((context, message) =>
      match(message)
        .with(P.instanceOf(Terminated), (signal) => onTypedTerminated(probe, stash, open, signal))
        .with({ kind: 'watch' }, (m) => onTypedWatch(context, probe, lostMessage, m))
        .with({ kind: 'open' }, () => onTypedOpen(probe, stash, open))
        .with({ kind: 'workerLost' }, (m) => onTypedWorkerLost(probe, stash, open, m))
        .exhaustive(),
    ),
  );
};

/* --------------------------------- helpers -------------------------------- */

/** Collects the dead letters a system publishes, for the plain-`watch` half. */
class DeadLetterListener extends Actor<DeadLetter> {
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

const listenForDeadLetters = async (system: ActorSystem): Promise<DeadLetter[]> => {
  const letters: DeadLetter[] = [];
  const ready = { value: false };
  system.spawn(() => new DeadLetterListener(letters, ready), 'dead-letter-listener');
  await awaitCondition(() => ready.value, {
    timeoutMs: 4_000,
    label: 'the listener subscribed to the event stream',
  });
  return letters;
};

/**
 * Watch, kill the subject, let the watcher park the notification, then replay.
 *
 * Returns once `unstashAll()` has come back, so what follows reads a completed
 * replay rather than a race against one.
 */
const parkADeathAndReplayIt = async (
  system: ActorSystem,
  watcher: ActorRef<WatcherMessage>,
  probe: WatcherProbe,
): Promise<void> => {
  const subject = system.spawn(Subject, 'subject') as ActorRef<SubjectMessage>;
  watcher.tell({ kind: 'watch', subject });
  await awaitCondition(() => probe.seen.includes('watching'), {
    timeoutMs: 4_000,
    label: 'the watcher registered its death watch',
  });

  subject.tell({ kind: 'die' });
  await awaitCondition(() => probe.parked.value, {
    timeoutMs: 4_000,
    label: 'the watcher parked the death notification',
  });

  watcher.tell({ kind: 'open' });
  await awaitCondition(() => probe.replayed.value, {
    timeoutMs: 4_000,
    label: 'the watcher replayed its stash',
  });
};

/* ------------------------------- watchWith -------------------------------- */

describe('a stashed watchWith message replays as the ordinary message it is — #1098', () => {
  test('the untyped stash parks the delivered message, not the signal behind it', async () => {
    const probe = newProbe();
    const system = newSystem('1098-untyped-watchwith');
    try {
      const watcher = system.spawn(
        () => new ParkingWatcher(probe, { kind: 'workerLost', name: 'alice' }),
        'watcher',
      ) as ActorRef<WatcherMessage>;

      await parkADeathAndReplayIt(system, watcher, probe);

      // The issue's own reproduction.  `watchWith` says the death arrives as
      // this actor's protocol message, and a protocol message that was parked
      // comes back — there is nothing about it left for the death-watch gate
      // to have an opinion about.
      await awaitCondition(() => probe.seen.length === 2, {
        timeoutMs: 4_000,
        label: 'the replayed domain message was handled',
      });
      expect(probe.seen).toEqual(['watching', 'workerLost:alice']);
    } finally {
      await system.terminate();
    }
  }, 10_000);

  test('the typed stash agrees, because it always parked the delivered message', async () => {
    const probe = newProbe();
    const system = newSystem('1098-typed-watchwith');
    try {
      const watcher = system.spawnAnonymous(
        typedActor<WatcherMessage>(typedParkingWatcher(probe, { kind: 'workerLost', name: 'alice' })),
      );

      await parkADeathAndReplayIt(system, watcher, probe);

      // `StashBuffer.stash(message)` takes the value the behavior was handed,
      // so this half already round-tripped while the untyped one did not.  It
      // is asserted here so the two doors are pinned to one answer rather than
      // to one implementation each.
      await awaitCondition(() => probe.seen.length === 2, {
        timeoutMs: 4_000,
        label: 'the replayed domain message was handled',
      });
      expect(probe.seen).toEqual(['watching', 'workerLost:alice']);
    } finally {
      await system.terminate();
    }
  }, 10_000);
});

/* ------------------------------ plain watch ------------------------------- */

describe('a stashed plain-watch Terminated becomes a dead letter — #1098', () => {
  test('the untyped stash replay is dead-lettered rather than consumed silently', async () => {
    const probe = newProbe();
    const system = newSystem('1098-untyped-watch');
    try {
      const letters = await listenForDeadLetters(system);
      const watcher = system.spawn(
        () => new ParkingWatcher(probe, null),
        'watcher',
      ) as ActorRef<WatcherMessage>;

      await parkADeathAndReplayIt(system, watcher, probe);

      await awaitCondition(
        () => letters.some((letter) => letter.message instanceof Terminated),
        { timeoutMs: 4_000, label: 'the replayed Terminated reached dead letters' },
      );
      const letter = letters.find((l) => l.message instanceof Terminated) as DeadLetter;
      expect((letter.message as Terminated).actor.path.name).toBe('subject');
      // The watcher that refused it, so the letter says which actor lost the
      // notification rather than only that one was lost.
      expect(letter.recipient.equals(watcher)).toBe(true);

      // And it is a dead letter *instead of* a redelivery, not as well as one:
      // the registration was retired by the first delivery, so the cell has no
      // way left to tell this signal from a death nobody asked about.
      expect(probe.seen).toEqual(['watching']);
    } finally {
      await system.terminate();
    }
  }, 10_000);

  test('the typed withStash replay follows the same rule', async () => {
    const probe = newProbe();
    const system = newSystem('1098-typed-watch');
    try {
      const letters = await listenForDeadLetters(system);
      const watcher = system.spawnAnonymous(
        typedActor<WatcherMessage>(typedParkingWatcher(probe, null)),
      );

      await parkADeathAndReplayIt(system, watcher, probe);

      // The typed buffer parks a bare message and `prependUserMessages`
      // rebuilds the envelope around it, so this arrives by a different route
      // — and has to meet the same answer, or "stash a death" means two things
      // depending on which DSL the actor is written in.
      await awaitCondition(
        () => letters.some((letter) => letter.message instanceof Terminated),
        { timeoutMs: 4_000, label: 'the replayed Terminated reached dead letters' },
      );
      const letter = letters.find((l) => l.message instanceof Terminated) as DeadLetter;
      expect((letter.message as Terminated).actor.path.name).toBe('subject');
      expect(letter.recipient.equals(watcher)).toBe(true);
      expect(probe.seen).toEqual(['watching']);
    } finally {
      await system.terminate();
    }
  }, 10_000);
});
