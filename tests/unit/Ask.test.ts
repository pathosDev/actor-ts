import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { AskTimeoutError } from '../../src/SystemMessages.js';
import { OptionsError } from '../../src/util/OptionsValidator.js';
import { sleep } from '../util/AwaitCondition.js';

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

  // Replaces `test('timeout 0 means effectively disabled (resolves normally)')`,
  // which asserted that `ask('hi', 0)` against an *Echo* actor resolves — the
  // one case in which a missing deadline costs nothing, because the reply
  // settles the ref.  #765 is the other case: with no timer armed and no reply
  // the ref never settles at all, so the caller's `await` never returns and a
  // cross-node ask leaves a permanent entry in `Cluster._envelopeHandlersByPath`
  // that `dispatchEnvelope` consults on every inbound envelope.  Nothing can
  // settle such a ref by hand — `ask` hands back the promise, not the ref — so
  // 0 is now refused rather than reinterpreted, and the deadline the docs call
  // "mandatory in spirit" is mandatory in fact.
  test('a deadline that would arm no timer is refused, not left to hang forever (#765)', async () => {
    class Silent extends Actor<string> { override onReceive(_: string): void {} }
    const sys = newSystem();
    const ref = sys.spawn(Silent, 'silent-no-timer');

    // 0, a negative and NaN all fail `if (timeoutMs > 0)` in AskResponseRef, so
    // without the guard each of these asks stays pending for ever.  The race
    // bounds that observation: with the guard the throw happens before the race
    // is even constructed, so `outcome` never moves off its initial value.
    for (const badTimeout of [0, -1, Number.NaN]) {
      let caught: unknown = null;
      let outcome = 'ask was refused before it started';
      try {
        outcome = await Promise.race([
          ref.ask<string>('hi', badTimeout).then(() => 'settled', () => 'settled'),
          // The elapsed time IS the assertion, so this cannot become an
          // `awaitCondition`: a ref that armed no timer settles on nothing, and
          // an absence has no state to poll.  Only letting time pass separates
          // "never going to settle" from "has not settled yet".
          sleep(120).then(() => 'still pending — the ref armed no timer'),
        ]);
      } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(OptionsError);
      expect((caught as OptionsError).field).toBe('timeoutMs');
      expect(outcome).toBe('ask was refused before it started');
    }
    await sys.terminate();
  });

  test('a non-finite deadline is refused (#765)', async () => {
    class Silent extends Actor<string> { override onReceive(_: string): void {} }
    const sys = newSystem();
    const ref = sys.spawn(Silent, 'silent-non-finite');
    for (const badTimeout of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      let caught: unknown = null;
      try {
        // The `.catch` is for the un-guarded tree, not this one: `Infinity`
        // passes `> 0` and reaches `setTimeout`, where an out-of-range delay is
        // clamped to a millisecond — so an "infinite" ask would reject almost
        // at once.  Swallowing it keeps a failure here a failed assertion
        // rather than an unhandled rejection somewhere else in the run.
        void ref.ask<string>('hi', badTimeout).catch(() => undefined);
      } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(OptionsError);
      expect((caught as OptionsError).field).toBe('timeoutMs');
    }
    await sys.terminate();
  });

  test('an omitted deadline still falls through to the default', async () => {
    class Echo extends Actor<string> {
      override onReceive(m: string): void { this.sender.forEach((__s) => __s.tell(m)); }
    }
    const sys = newSystem();
    const ref = sys.spawn(Echo, 'e');
    // The guard must not swallow the parameter default: `undefined` is what
    // reaches it when the argument is omitted, and that has to keep resolving
    // to DEFAULT_ASK_TIMEOUT_MS rather than tripping the new check.
    expect(await ref.ask<string>('hi')).toBe('hi');
    expect(await ref.ask<string>('hi', undefined)).toBe('hi');
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
