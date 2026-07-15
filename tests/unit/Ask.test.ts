import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';
import { AskTimeoutError } from '../../src/SystemMessages.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const newSystem = (name = 'ask-unit'): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

describe('ref.ask()', () => {
  test('resolves with the first reply', async () => {
    class Echo extends Actor<string> {
      override onReceive(m: string): void { this.sender.forEach((__s) => __s.tell(`echo:${m}`)); }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new Echo()), 'echo');
    const reply = await ref.ask<string>('hi', 500);
    expect(reply).toBe('echo:hi');
    await sys.terminate();
  });

  test('rejects with AskTimeoutError after the timeout', async () => {
    class Silent extends Actor<string> { override onReceive(_: string): void {} }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new Silent()), 's');
    let caught: unknown = null;
    try { await ref.ask('hi', 20); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AskTimeoutError);
    await sys.terminate();
  });

  test('sender inside the recipient is the synthesised ask-response ref (non-null)', async () => {
    let senderName: string | undefined;
    class Peek extends Actor<string> {
      override onReceive(_: string): void {
        senderName = this.sender.map((s) => s.path.name).toNullable() ?? undefined;
        this.sender.forEach((__s) => __s.tell('ok'));
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new Peek()), 'p');
    await ref.ask('x', 100);
    expect(senderName).toBeDefined();
    expect(senderName!.startsWith('askResp-')).toBe(true);
    await sys.terminate();
  });

  test('rejects when the actor replies with an Error', async () => {
    class Rejector extends Actor<string> {
      override onReceive(_: string): void {
        this.sender.forEach((__s) => __s.tell(new Error('boom')));
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new Rejector()), 'r');
    let err: Error | null = null;
    try { await ref.ask('hi', 500); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toBe('boom');
    await sys.terminate();
  });

  test('second reply to the same ask is ignored', async () => {
    class DoubleReply extends Actor<string> {
      override onReceive(_: string): void {
        this.sender.forEach((__s) => __s.tell('first'));
        this.sender.forEach((__s) => __s.tell('second'));
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new DoubleReply()), 'd');
    const reply = await ref.ask<string>('x', 500);
    expect(reply).toBe('first');
    // Give the second tell a chance — it must not blow up anything.
    await sleep(30);
    await sys.terminate();
  });

  test('timeout 0 means effectively disabled (resolves normally)', async () => {
    class Echo extends Actor<string> {
      override onReceive(m: string): void { this.sender.forEach((__s) => __s.tell(m)); }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new Echo()), 'e');
    const reply = await ref.ask<string>('hi', 0);
    expect(reply).toBe('hi');
    await sys.terminate();
  });

  test('injects replyTo onto the message so explicit-replyTo recipients work', async () => {
    // Recipient reads `msg.replyTo` instead of `this.sender`.
    interface ReplyCommand { readonly kind: 'reply'; readonly replyTo: import('../../src/ActorRef.js').ActorRef<string> }
    class ExplicitReplier extends Actor<ReplyCommand> {
      override onReceive(m: ReplyCommand): void {
        m.replyTo.tell('via-replyTo');
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new ExplicitReplier()), 'er');
    // `replyTo` is omitted from the call site by OmitReplyTo.
    const reply = await ref.ask<string>({ kind: 'reply' }, 500);
    expect(reply).toBe('via-replyTo');
    await sys.terminate();
  });
});
