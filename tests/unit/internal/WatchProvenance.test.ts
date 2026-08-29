/**
 * Death-watch provenance (#769).
 *
 * `ActorCell` retires a watch registration when a `Terminated` naming the
 * watched subject arrives — and the message carries a ref and nothing else, so
 * "that actor is dead" used to be a claim the runtime accepted from anyone who
 * could construct one.  The damage was in two halves: the watcher acted on a
 * death that had not happened, and the watch went with it, so the *genuine*
 * notification was later dropped by the same gate as unwatched and the watcher
 * stayed blind to that subject for good.
 *
 * These tests pin the fix from the outside — nothing here reaches into the
 * brand.  A `Terminated` a test constructs is exactly the one an application
 * (or an attacker in the same module graph) can construct, so "the framework
 * would not honour this" is the whole assertion.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DeadLetter, Terminated } from '../../../src/SystemMessages.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const newSystem = (name: string): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

/** The watched actor: stops itself on demand, and nothing else. */
class Subject extends Actor<'die'> {
  override onReceive(_: 'die'): void { this.self.stop(); }
}

type WatcherInbox = 'go' | 'probe' | Terminated | string;

/**
 * Watches one child and records everything its behavior is handed.
 *
 * `probe` is the ordering device: it is sent *after* the forged signal, so a
 * test that has seen the probe knows the forgery has already been through the
 * mailbox and the assertion is not racing it.
 */
class Watcher extends Actor<WatcherInbox> {
  constructor(
    private readonly handled: string[],
    private readonly spawned: { subject: ActorRef<'die'> | null },
    private readonly lostMessage: string | null,
  ) { super(); }

  override onReceive(message: WatcherInbox): void {
    if (message === 'go') {
      const subject = this.context.spawn(Subject, 'subject') as ActorRef<'die'>;
      if (this.lostMessage === null) {
        this.context.watch(subject);
      } else {
        this.context.watchWith(subject, this.lostMessage);
      }
      this.spawned.subject = subject;
      return;
    }
    this.handled.push(message instanceof Terminated ? `terminated:${message.actor.path.name}` : message);
  }
}

/** Somebody to name as the sender of the forgery — and a dead-letter listener. */
class Bystander extends Actor<unknown> {
  override onReceive(_: unknown): void {}
}

describe('Terminated provenance', () => {
  test('a fabricated Terminated is not delivered and does not retire the watch', async () => {
    const handled: string[] = [];
    const spawned: { subject: ActorRef<'die'> | null } = { subject: null };
    const sys = newSystem('watch-provenance-forged');
    try {
      const watcher = sys.spawn(
        () => new Watcher(handled, spawned, null), 'watcher',
      ) as ActorRef<WatcherInbox>;
      watcher.tell('go');
      await awaitCondition(() => spawned.subject !== null, {
        timeoutMs: 4_000,
        label: 'the watcher spawned and watched its subject',
      });
      const subject = spawned.subject as ActorRef<'die'>;

      // The forgery: a `Terminated` naming a subject the watcher really does
      // watch, for an actor that is very much alive.
      watcher.tell(new Terminated(subject));
      watcher.tell('probe');
      // `>= 1` rather than `=== 1` so the honoured-forgery case fails on the
      // assertion below — with the two lists side by side — instead of
      // sliding past a strict equality and timing out with nothing to read.
      await awaitCondition(() => handled.length >= 1, {
        timeoutMs: 4_000,
        label: 'the message queued behind the forgery was handled',
      });
      expect(handled).toEqual(['probe']);

      // And the watch survived it, so the real death still arrives.
      subject.tell('die');
      await awaitCondition(() => handled.length === 2, {
        timeoutMs: 4_000,
        label: 'the genuine Terminated reached the watcher',
      });
      expect(handled).toEqual(['probe', 'terminated:subject']);
    } finally {
      await sys.terminate();
    }
  }, 10_000);

  test('a fabricated Terminated is dead-lettered rather than silently consumed', async () => {
    const handled: string[] = [];
    const spawned: { subject: ActorRef<'die'> | null } = { subject: null };
    const letters: DeadLetter[] = [];
    const subscribed = { value: false };

    class Listener extends Actor<DeadLetter> {
      override preStart(): void {
        this.system.eventStream.subscribe(this.self, DeadLetter);
        subscribed.value = true;
      }
      override onReceive(letter: DeadLetter): void { letters.push(letter); }
    }

    const sys = newSystem('watch-provenance-deadletter');
    try {
      sys.spawn(Listener, 'listener');
      await awaitCondition(() => subscribed.value, {
        timeoutMs: 4_000,
        label: 'the listener subscribed to the event stream',
      });
      const watcher = sys.spawn(
        () => new Watcher(handled, spawned, null), 'watcher',
      ) as ActorRef<WatcherInbox>;
      watcher.tell('go');
      await awaitCondition(() => spawned.subject !== null, {
        timeoutMs: 4_000,
        label: 'the watcher spawned and watched its subject',
      });
      const subject = spawned.subject as ActorRef<'die'>;
      const forger = sys.spawn(Bystander, 'forger');

      watcher.tell(new Terminated(subject), forger);
      await awaitCondition(
        () => letters.some((letter) => letter.message instanceof Terminated),
        { timeoutMs: 4_000, label: 'the refused Terminated reached dead letters' },
      );

      const letter = letters.find((l) => l.message instanceof Terminated) as DeadLetter;
      expect((letter.message as Terminated).actor.equals(subject)).toBe(true);
      // The recipient is the watcher that refused it, and the sender names
      // whoever sent it — which is the point of dead-lettering rather than
      // dropping: a forged or mistakenly forwarded signal is attributable.
      expect(letter.recipient.equals(watcher)).toBe(true);
      expect(letter.sender?.equals(forger)).toBe(true);
    } finally {
      await sys.terminate();
    }
  }, 10_000);

  test('a fabricated Terminated does not consume a watchWith substitution', async () => {
    const handled: string[] = [];
    const spawned: { subject: ActorRef<'die'> | null } = { subject: null };
    const sys = newSystem('watch-provenance-watchwith');
    try {
      const watcher = sys.spawn(
        () => new Watcher(handled, spawned, 'lost:subject'), 'watcher',
      ) as ActorRef<WatcherInbox>;
      watcher.tell('go');
      await awaitCondition(() => spawned.subject !== null, {
        timeoutMs: 4_000,
        label: 'the watcher spawned and watched its subject',
      });
      const subject = spawned.subject as ActorRef<'die'>;

      // The substitution lives in a second map, keyed the same way and
      // deleted by the same gate, so it is forgeable by exactly the same
      // message — and losing it silently downgrades the watcher to a
      // `Terminated` it may have no arm for.
      watcher.tell(new Terminated(subject));
      watcher.tell('probe');
      // `>= 1` rather than `=== 1` so the honoured-forgery case fails on the
      // assertion below — with the two lists side by side — instead of
      // sliding past a strict equality and timing out with nothing to read.
      await awaitCondition(() => handled.length >= 1, {
        timeoutMs: 4_000,
        label: 'the message queued behind the forgery was handled',
      });
      expect(handled).toEqual(['probe']);

      subject.tell('die');
      await awaitCondition(() => handled.length === 2, {
        timeoutMs: 4_000,
        label: 'the genuine death arrived as the substituted message',
      });
      expect(handled).toEqual(['probe', 'lost:subject']);
    } finally {
      await sys.terminate();
    }
  }, 10_000);
});
