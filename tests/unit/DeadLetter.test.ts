import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { ActorStopped, DeadLetter } from '../../src/SystemMessages.js';
import { awaitCondition, sleep } from '../util/AwaitCondition.js';

const newSystem = (name = 'dl-unit'): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

describe('DeadLetter routing', () => {
  test('a message sent to a terminated actor is published as DeadLetter on the event stream', async () => {
    const seen: DeadLetter[] = [];
    const stopped: ActorStopped[] = [];
    const subscribed = { value: false };
    // Subscribed to `ActorStopped` as well, because both halves of this test
    // are races the old fixed sleeps papered over: the listener has to be on
    // the stream before anything is published, and `dead` has to be genuinely
    // terminated before the tell — otherwise `too-late` is simply delivered
    // and no dead letter is ever produced.  `ActorStopped` is published after
    // the cell flips to `terminated`, so it is the exact signal.
    class Listener extends Actor<DeadLetter | ActorStopped> {
      override preStart(): void {
        this.system.eventStream.subscribe(this.self, DeadLetter);
        this.system.eventStream.subscribe(this.self, ActorStopped);
        subscribed.value = true;
      }
      override onReceive(m: DeadLetter | ActorStopped): void {
        if (m instanceof ActorStopped) stopped.push(m); else seen.push(m);
      }
    }
    class Nothing extends Actor<string> { override onReceive(_: string): void {} }

    const sys = newSystem();
    sys.spawn(Listener, 'lst');
    await awaitCondition(() => subscribed.value, {
      timeoutMs: 4_000,
      label: 'the listener subscribed to the event stream',
    });

    const dead = sys.spawn(Nothing, 'n');
    dead.stop();
    await awaitCondition(() => stopped.some((e) => e.actor.equals(dead)), {
      timeoutMs: 4_000,
      label: 'the target actor reached the terminated state',
    });

    dead.tell('too-late');
    await awaitCondition(() => seen.some((d) => d.message === 'too-late'), {
      timeoutMs: 4_000,
      label: 'the message to the terminated actor reached dead letters',
    });

    expect(seen.length).toBeGreaterThan(0);
    const messages = seen.map(d => d.message);
    expect(messages).toContain('too-late');
    // Sender is null since we called tell without a sender.
    expect(seen.find(d => d.message === 'too-late')!.sender).toBeNull();
    await sys.terminate();
  });

  test('messages sent to Nobody are dropped without hitting dead letters', async () => {
    const seen: DeadLetter[] = [];
    const subscribed = { value: false };
    class Listener extends Actor<DeadLetter> {
      override preStart(): void {
        this.system.eventStream.subscribe(this.self, DeadLetter);
        subscribed.value = true;
      }
      override onReceive(m: DeadLetter): void { seen.push(m); }
    }
    const sys = newSystem();
    sys.spawn(Listener, 'lst');
    // The subscription is the precondition that keeps the assertion from
    // passing vacuously — without it "no dead letter arrived" is guaranteed
    // for the wrong reason.  The settle afterwards stays a plain sleep: the
    // property under test is that nothing happens, and there is no state to
    // poll for that.
    await awaitCondition(() => subscribed.value, {
      timeoutMs: 4_000,
      label: 'the listener subscribed to the event stream',
    });
    // Import Nobody lazily to avoid unused at top.
    const { Nobody } = await import('../../src/ActorRef.js');
    Nobody.tell('nothing');
    await sleep(30);
    expect(seen.find(d => d.message === 'nothing')).toBeUndefined();
    await sys.terminate();
  });
});

describe('DeadLetter recipient attribution (#433)', () => {
  test('a typed behavior answering unhandled names itself, not the dead-letter office', async () => {
    // The raw `deadLetters.tell(message)` this replaced let `DeadLetterRef`
    // do the wrapping, and the ref can only name itself — so every unhandled
    // typed message came out addressed to `/deadLetters`, which is the one
    // recipient shared by the entire stream and therefore no information.
    const seen: DeadLetter[] = [];
    const subscribed = { value: false };
    class Listener extends Actor<DeadLetter> {
      override preStart(): void {
        this.system.eventStream.subscribe(this.self, DeadLetter);
        subscribed.value = true;
      }
      override onReceive(m: DeadLetter): void { seen.push(m); }
    }

    const sys = newSystem('dl-typed');
    sys.spawn(Listener, 'lst');
    await awaitCondition(() => subscribed.value, {
      timeoutMs: 4_000,
      label: 'the listener subscribed to the event stream',
    });

    const { Behaviors } = await import('../../src/typed/Behaviors.js');
    const ref = sys.spawnTyped(
      Behaviors.receiveMessage<string>(() => Behaviors.unhandled),
      'picky',
    );
    ref.tell('nope');

    await awaitCondition(() => seen.some((d) => d.message === 'nope'), {
      timeoutMs: 4_000,
      label: 'the unhandled message reached dead letters',
    });
    const letter = seen.find((d) => d.message === 'nope')!;
    expect(letter.recipient.path.toString()).toBe(`actor-ts://${sys.name}/user/picky`);
    await sys.terminate();
  });
});

describe('DeadLetter delivery loop', () => {
  test('a terminated DeadLetter subscriber does not spin the dead-letter office', async () => {
    // Delivering a dead letter to a subscriber that has stopped without
    // unsubscribing routes it BACK to dead letters, which used to
    // republish it to the same dead subscriber until the stack blew.
    // The nested wrap is the loop signature and is dropped.
    const listenerStopped = { value: false };
    const targetStopped = { value: false };
    class Listener extends Actor<DeadLetter> {
      override preStart(): void { this.system.eventStream.subscribe(this.self, DeadLetter); }
      override onReceive(_: DeadLetter): void {}
      override postStop(): void { listenerStopped.value = true; }
    }
    class Nothing extends Actor<string> {
      override onReceive(_: string): void {}
      override postStop(): void { targetStopped.value = true; }
    }

    const sys = newSystem('dl-loop');
    const listener = sys.spawn(Listener, 'lst');
    const dead = sys.spawn(Nothing, 'n');
    dead.stop();
    await awaitCondition(() => targetStopped.value, {
      timeoutMs: 4_000,
      label: 'the dead-letter target stopped',
    });

    // Stop the subscriber but leave the subscription in place.
    listener.stop();
    await awaitCondition(() => listenerStopped.value, {
      timeoutMs: 4_000,
      label: 'the dead-letter subscriber stopped',
    });

    // Must return rather than recurse; the assertion is that we get here.
    expect(() => dead.tell('trigger')).not.toThrow();
    await sleep(30);
    expect(sys.isTerminated).toBe(false);
    await sys.terminate();
  });
});
