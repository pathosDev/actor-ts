import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { AskTimeoutError } from '../../src/SystemMessages.js';
import { OptionsError } from '../../src/util/OptionsValidator.js';
import { DEFAULT_ASK_TIMEOUT_MS, MAX_TIMER_DELAY_MS } from '../../src/util/Constants.js';
import { Nobody, type ActorRef } from '../../src/ActorRef.js';
import { EntityRef } from '../../src/cluster/sharding/EntityRef.js';
import { TestProbe } from '../../src/testkit/TestProbe.js';
import { assertDoesNotCompleteWithin } from '../util/AsyncAssertions.js';
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

describe('ask — the configured default deadline (#863)', () => {
  /**
   * Nested and not `{'actor-ts.actor.ask-timeout': …}`: a dotted string stays a
   * literal top-level key, so the read would fall through to the reference
   * value and every assertion below would pass against a system that ignored
   * the configuration entirely.
   */
  const configuredSystem = (askTimeout: string, name = 'ask-configured'): ActorSystem => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { actor: { 'ask-timeout': askTimeout } } });
    return ActorSystem.create(name, sysOptions);
  };

  class Silent extends Actor<string> { override onReceive(_: string): void {} }

  test('an omitted deadline on a local ref arms the configured value', async () => {
    const sys = configuredSystem('40ms');
    const ref = sys.spawn(Silent, 's');

    // Asserted through the rejection message rather than by timing the await:
    // the message quotes the deadline that was actually armed, so a system
    // that fell back to the 5 000 ms constant fails here in milliseconds
    // instead of failing five seconds later, or passing on a slow machine.
    let caught: unknown = null;
    try { await ref.ask('hi'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AskTimeoutError);
    expect((caught as Error).message).toContain('after 40ms');

    // `undefined` takes the same road as an omitted argument — the parameter
    // is optional now rather than defaulted, and `??` is what resolves it.
    let caughtUndefined: unknown = null;
    try { await ref.ask('hi', undefined); } catch (e) { caughtUndefined = e; }
    expect((caughtUndefined as Error).message).toContain('after 40ms');

    await sys.terminate();
  });

  test('an explicit per-call deadline still wins over the configured one', async () => {
    const sys = configuredSystem('40ms', 'ask-explicit-wins');
    const ref = sys.spawn(Silent, 's');
    let caught: unknown = null;
    try { await ref.ask('hi', 90); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AskTimeoutError);
    expect((caught as Error).message).toContain('after 90ms');
    await sys.terminate();
  });

  test('a configured value still has to be positive at the call site', async () => {
    // The system refuses a non-positive `ask-timeout` at construction, so this
    // is the other half: an explicit `0` is not rescued by a healthy configured
    // default — the per-call guard is unchanged and still owns that domain.
    const sys = configuredSystem('40ms', 'ask-explicit-zero');
    const ref = sys.spawn(Silent, 's');
    let caught: unknown = null;
    try { void ref.ask('hi', 0).catch(() => undefined); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(OptionsError);
    expect((caught as OptionsError).field).toBe('timeoutMs');
    await sys.terminate();
  });

  test('which refs honour the key, and which keep the constant', async () => {
    const sys = configuredSystem('40ms', 'ask-ref-coverage');
    const local = sys.spawn(Silent, 's');
    const probe = new TestProbe(sys);
    // A local region ref stands in for the sharding one: `EntityRef` reaches
    // its system only through whatever ref it was handed, and that delegation
    // is the whole mechanism — the region's own kind is not part of it.
    const entity = new EntityRef(local, 'counter', 'user-42', 8, sys.name);

    expect(local._defaultAskTimeoutMs()).toBe(40);
    expect(probe._defaultAskTimeoutMs()).toBe(40);
    expect(entity._defaultAskTimeoutMs()).toBe(40);

    // Documented partial coverage, asserted so it stays a decision rather than
    // becoming an accident: these hold a system *name*, not a system, and the
    // configured value cannot reach them.  Widening the key to cover them means
    // changing this test on purpose.
    expect(sys.deadLetters._defaultAskTimeoutMs()).toBe(DEFAULT_ASK_TIMEOUT_MS);
    expect(Nobody._defaultAskTimeoutMs()).toBe(DEFAULT_ASK_TIMEOUT_MS);

    await sys.terminate();
  });

  test('an untouched system still arms the built-in constant', async () => {
    // The reference default and the built-in fallback are two numbers that
    // could drift apart; this is the one assertion that reads them as one.
    const sys = newSystem('ask-untouched');
    const ref = sys.spawn(Silent, 's');
    expect(ref._defaultAskTimeoutMs()).toBe(DEFAULT_ASK_TIMEOUT_MS);
    await sys.terminate();
  });
});

/**
 * A deadline past the host timer ceiling is the deadline that was asked for.
 *
 * `setTimeout` arms anything above {@link MAX_TIMER_DELAY_MS} (~24.9 days) as
 * 1 ms on Bun and Node (Deno wraps it modulo 2^32), and an ask on a real
 * system arms its deadline with a raw `setTimeout` — the scheduler is only
 * consulted when time is virtual.  So `ask(m, 2^31)`
 * rejected with `AskTimeoutError` after ~14 ms, and a 30-day deadline after
 * ~1 ms.  `assertAskTimeout` accepts any positive finite number, which is what
 * makes this a defect rather than a missing refusal: the value was accepted
 * and then not honoured.
 */
describe('ask — a deadline past the host timer ceiling', () => {
  const CEILING_PLUS_ONE_MS = MAX_TIMER_DELAY_MS + 1;
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
  /** Long enough that nothing the system arms for itself is mistaken for a link. */
  const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

  class Silent extends Actor<string> { override onReceive(_: string): void {} }

  class Echo extends Actor<string> {
    override onReceive(m: string): void { this.sender.forEach((s) => s.tell(m)); }
  }

  /** Holds the first asker and answers it once told to, so a test can settle its ask. */
  class Holder extends Actor<string> {
    private waiting: ActorRef | null = null;
    override onReceive(m: string): void {
      if (m !== 'release') {
        this.waiting = this.sender.toNullable();
        return;
      }
      this.waiting?.tell('released');
      this.waiting = null;
    }
  }

  type ParkedTimeout = { readonly callback: () => void; readonly delayMs: number };

  /**
   * Run `action` with every runtime timer of a day or longer parked instead of
   * armed, so a test can elapse a link by calling it.  Everything shorter is the
   * system's own business and reaches the real primitive unchanged.
   */
  function parkingLongTimeouts<T>(parked: ParkedTimeout[], action: () => T): T {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const [callback, delayMs] = args;
      if (typeof delayMs === 'number' && delayMs >= ONE_DAY_MS) {
        parked.push({ callback: callback as () => void, delayMs });
        return -1 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(...args);
    }) as typeof setTimeout;
    try {
      return action();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  }

  /** One full turn of the event loop, so a rejection already queued has landed. */
  const nextTurn = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

  test('has not timed out on the wall clock long after the overflow would have', async () => {
    const sys = newSystem('ask-long-wall-clock');
    const holder = sys.spawn(Holder, 'holder');
    try {
      const pending = holder.ask<string>('hold', CEILING_PLUS_ONE_MS);
      // An absence, so it needs a window; it only has to outlast the ~14 ms the
      // overflow took by a wide margin.
      await assertDoesNotCompleteWithin(pending, 150, 'an ask with a 2^31 ms deadline');
      // Settled by a reply rather than left armed: the reply cancels the chain.
      holder.tell('release');
      expect(await pending).toBe('released');
    } finally {
      await sys.terminate();
    }
  });

  test('is armed as a chain whose links add up to the deadline', async () => {
    const sys = newSystem('ask-long-chain');
    const silent = sys.spawn(Silent, 'silent');
    const parked: ParkedTimeout[] = [];
    let outcome = 'pending';
    try {
      const settled = parkingLongTimeouts(parked, () => silent.ask<string>('hi', THIRTY_DAYS_MS)).then(
        () => { outcome = 'replied'; },
        (error: unknown) => { outcome = error instanceof AskTimeoutError ? 'timed out' : 'rejected'; },
      );
      expect(parked.map((link) => link.delayMs)).toEqual([MAX_TIMER_DELAY_MS]);

      // 24.9 days pass: the first link elapses and arms the rest of the deadline.
      parkingLongTimeouts(parked, () => { parked[0]!.callback(); });
      await nextTurn();
      expect(outcome).toBe('pending');
      expect(parked.map((link) => link.delayMs)).toEqual([MAX_TIMER_DELAY_MS, THIRTY_DAYS_MS - MAX_TIMER_DELAY_MS]);

      parkingLongTimeouts(parked, () => { parked[1]!.callback(); });
      await settled;
      expect(outcome).toBe('timed out');
    } finally {
      await sys.terminate();
    }
  });

  test('no deadline that is accepted today is refused', async () => {
    // The HTTP layer refuses a deadline past the ceiling; an ask must not start
    // to, because every one of these was a valid call before the chain.  Each is
    // answered at once, which also cancels the chain it armed.
    const sys = newSystem('ask-long-accepted');
    const echo = sys.spawn(Echo, 'echo');
    try {
      for (const timeoutMs of [CEILING_PLUS_ONE_MS, THIRTY_DAYS_MS, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]) {
        expect(await echo.ask<string>(`deadline ${timeoutMs}`, timeoutMs)).toBe(`deadline ${timeoutMs}`);
      }
    } finally {
      await sys.terminate();
    }
  });
});
