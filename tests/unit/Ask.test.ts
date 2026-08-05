import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
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
    const ref = sys.spawn(Echo, 'echo');
    const reply = await ref.ask<string>('hi', 500);
    expect(reply).toBe('echo:hi');
    await sys.terminate();
  });

  test('rejects with AskTimeoutError after the timeout', async () => {
    class Silent extends Actor<string> { override onReceive(_: string): void {} }
    const sys = newSystem();
    const ref = sys.spawn(Silent, 's');
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
    const ref = sys.spawn(Peek, 'p');
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
    const ref = sys.spawn(Rejector, 'r');
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
    const ref = sys.spawn(DoubleReply, 'd');
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
    const ref = sys.spawn(Echo, 'e');
    const reply = await ref.ask<string>('hi', 0);
    expect(reply).toBe('hi');
    await sys.terminate();
  });

  test('injects replyTo onto the message so explicit-replyTo recipients work', async () => {
    // Recipient reads `msg.replyTo` instead of `this.sender`.
    type ReplyCommand = { readonly kind: 'reply'; readonly replyTo: import('../../src/ActorRef.js').ActorRef<string> };
    class ExplicitReplier extends Actor<ReplyCommand> {
      override onReceive(m: ReplyCommand): void {
        m.replyTo.tell('via-replyTo');
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(ExplicitReplier, 'er');
    // `replyTo` is omitted from the call site by OmitReplyTo.
    const reply = await ref.ask<string>({ kind: 'reply' }, 500);
    expect(reply).toBe('via-replyTo');
    await sys.terminate();
  });
});

describe('ask — reply-ref naming (#119)', () => {
  test('names are unpredictable and unique, not a shared counter', async () => {
    // Was `askResp-${++askCounter}` on a module-global counter: predictable
    // enough to aim a forged reply at an in-flight ask, shared across every
    // system in the process, and eventually wrapping into collisions with
    // names still in flight.
    const names: string[] = [];
    class Peek extends Actor<string> {
      override onReceive(_: string): void {
        this.sender.forEach((s) => { names.push(s.path.name); s.tell('ok'); });
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(Peek, 'p');
    for (let i = 0; i < 50; i++) await ref.ask('x', 200);

    expect(names).toHaveLength(50);
    expect(new Set(names).size).toBe(50);
    for (const name of names) expect(name).toMatch(/^askResp-[0-9a-f]{12}$/);

    // The decisive property: knowing one name must not yield the next.  The
    // format assertion above already rules out a plain counter (`askResp-1`
    // is not twelve hex characters); this rules out a counter rendered in hex.
    //
    // Deliberately not "no suffix is all digits" — hex digits include 0-9, so
    // a legitimate random suffix is all-digits about once in 139 draws, which
    // over 50 samples would fail roughly a third of runs.
    const asNumbers = names.map(n => parseInt(n.slice('askResp-'.length), 16));
    const consecutive = asNumbers.every((value, index) => index === 0 || value === asNumbers[index - 1]! + 1);
    expect(consecutive).toBe(false);

    await sys.terminate();
  });

  test('two systems in one process do not share the name sequence', async () => {
    // The old counter was module-global, so the Nth ask in either system got
    // the same name — two independent systems handing out one namespace.
    const seen: string[] = [];
    class Peek extends Actor<string> {
      override onReceive(_: string): void {
        this.sender.forEach((s) => { seen.push(s.path.name); s.tell('ok'); });
      }
    }
    const first = newSystem('ask-names-a');
    const second = newSystem('ask-names-b');
    const refA = first.spawn(Peek, 'p');
    const refB = second.spawn(Peek, 'p');
    await refA.ask('x', 200);
    await refB.ask('x', 200);

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);

    await first.terminate();
    await second.terminate();
  });
});
