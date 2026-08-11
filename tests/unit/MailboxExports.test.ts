import { describe, expect, test } from 'bun:test';
import { Actor, ActorOptions, ActorSystem, ActorSystemOptions, Mailbox } from '../../src/index.js';
import type { Envelope, MailboxFactory } from '../../src/index.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';

/**
 * The mailbox escape hatch has to be reachable the way a consumer reaches it
 * (#661, #1002).  `package.json` ships only `dist/` and its `exports` map has
 * no wildcard, so a name `src/index.ts` drops is a name that left the package
 * — and `Mailbox` was dropped while `MailboxFactory`, whose whole signature is
 * `() => Mailbox<T>`, was exported.  The documented sample could not compile
 * against the tarball.
 *
 * Every other mailbox test imports by deep relative path and so keeps passing
 * whatever the barrel says.  This file is the only one that reads them the way
 * a consumer must.
 */
describe('the mailbox surface is reachable from the barrel (#661)', () => {
  test('Mailbox is a real class with the queue semantics it documents', () => {
    const mailbox = new Mailbox<string>();
    expect(mailbox.size).toBe(0);

    mailbox.enqueue({ message: 'a', sender: null });
    mailbox.enqueue({ message: 'b', sender: null });
    expect(mailbox.size).toBe(2);
    expect(mailbox.dequeueUser()?.message).toBe('a');

    // Unbounded is the point: no capacity to configure, and none to hit.
    for (let i = 0; i < 50_000; i++) mailbox.enqueue({ message: `m${i}`, sender: null });
    expect(mailbox.size).toBe(50_001);
  });

  test('Envelope types a custom mailbox, which is why it had to ship too', () => {
    // The subclass is the whole reason both names are public: `extends
    // Mailbox` needs the class, and the method it overrides needs the type.
    class CountingMailbox<T> extends Mailbox<T> {
      seen = 0;
      override enqueue(envelope: Envelope<T>): void {
        this.seen++;
        super.enqueue(envelope);
      }
    }
    const mailbox = new CountingMailbox<number>();
    mailbox.enqueue({ message: 1, sender: null });
    mailbox.enqueue({ message: 2, sender: null });
    expect(mailbox.seen).toBe(2);
    expect(mailbox.size).toBe(2);
  });

  test('a custom mailbox reaches an actor through MailboxFactory', async () => {
    class TracingMailbox<T> extends Mailbox<T> {
      static built = 0;
      constructor() { super(); TracingMailbox.built++; }
    }
    const system = ActorSystem.create(
      'mailbox-exports',
      ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
    );

    class Greeter extends Actor<string> {
      override onReceive(_m: string): void {}
    }
    // Typed as the exported alias rather than inlined, so the test fails to
    // compile if `MailboxFactory` and `Mailbox` ever drift apart.
    const factory: MailboxFactory<string> = () => new TracingMailbox<string>();
    const ref = system.spawn(Greeter, 'greeter', ActorOptions.create<string>().withMailbox(factory));
    ref.tell('hello');

    expect(TracingMailbox.built).toBe(1);
    await system.terminate();
  });
});
