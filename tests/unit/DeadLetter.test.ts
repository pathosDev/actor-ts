import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';
import { DeadLetter } from '../../src/SystemMessages.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const newSystem = (name = 'dl-unit'): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

describe('DeadLetter routing', () => {
  test('a message sent to a terminated actor is published as DeadLetter on the event stream', async () => {
    const seen: DeadLetter[] = [];
    class Listener extends Actor<DeadLetter> {
      override preStart(): void { this.system.eventStream.subscribe(this.self, DeadLetter); }
      override onReceive(m: DeadLetter): void { seen.push(m); }
    }
    class Nothing extends Actor<string> { override onReceive(_: string): void {} }

    const sys = newSystem();
    sys.spawn(Props.create(() => new Listener()), 'lst');
    const dead = sys.spawn(Props.create(() => new Nothing()), 'n');
    dead.stop();
    await sleep(30);

    dead.tell('too-late');
    await sleep(30);

    expect(seen.length).toBeGreaterThan(0);
    const messages = seen.map(d => d.message);
    expect(messages).toContain('too-late');
    // Sender is null since we called tell without a sender.
    expect(seen.find(d => d.message === 'too-late')!.sender).toBeNull();
    await sys.terminate();
  });

  test('messages sent to Nobody are dropped without hitting dead letters', async () => {
    const seen: DeadLetter[] = [];
    class Listener extends Actor<DeadLetter> {
      override preStart(): void { this.system.eventStream.subscribe(this.self, DeadLetter); }
      override onReceive(m: DeadLetter): void { seen.push(m); }
    }
    const sys = newSystem();
    sys.spawn(Props.create(() => new Listener()), 'lst');
    // Import Nobody lazily to avoid unused at top.
    const { Nobody } = await import('../../src/ActorRef.js');
    Nobody.tell('nothing');
    await sleep(30);
    expect(seen.find(d => d.message === 'nothing')).toBeUndefined();
    await sys.terminate();
  });
});

describe('DeadLetter delivery loop', () => {
  test('a terminated DeadLetter subscriber does not spin the dead-letter office', async () => {
    // Delivering a dead letter to a subscriber that has stopped without
    // unsubscribing routes it BACK to dead letters, which used to
    // republish it to the same dead subscriber until the stack blew.
    // The nested wrap is the loop signature and is dropped.
    class Listener extends Actor<DeadLetter> {
      override preStart(): void { this.system.eventStream.subscribe(this.self, DeadLetter); }
      override onReceive(_: DeadLetter): void {}
    }
    class Nothing extends Actor<string> { override onReceive(_: string): void {} }

    const sys = newSystem('dl-loop');
    const listener = sys.spawn(Props.create(() => new Listener()), 'lst');
    const dead = sys.spawn(Props.create(() => new Nothing()), 'n');
    dead.stop();
    await sleep(30);

    // Stop the subscriber but leave the subscription in place.
    listener.stop();
    await sleep(30);

    // Must return rather than recurse; the assertion is that we get here.
    expect(() => dead.tell('trigger')).not.toThrow();
    await sleep(30);
    expect(sys.isTerminated).toBe(false);
    await sys.terminate();
  });
});
