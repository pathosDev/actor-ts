import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { AskTimeoutError } from '../../src/SystemMessages.js';
import { TestKit } from '../../src/testkit/TestKit.js';

/**
 * #1424 — an ask deadline is armed on the system scheduler, so a
 * `ManualScheduler` makes it virtual.
 *
 * This is the commonest shape in the flake catalogue, and it is worth naming
 * exactly.  A test for "the reply never comes" has to let the deadline elapse.
 * On the wall clock the only way to do that is to wait, so the test is written
 * with an unrealistically short deadline — 40 ms, say — and then it fails on a
 * machine running fifteen other suites, because 40 ms of wall clock is not
 * 40 ms of scheduling.  Both halves of that trade go away when the deadline is
 * virtual: the realistic five seconds can be asserted, and it costs nothing.
 */

/** Never replies, so only the deadline can settle the ask. */
class Silent extends Actor<{ kind: 'ping' }> {
  override onReceive(): void { /* deliberately nothing */ }
}

describe('an ask deadline is virtual under a ManualScheduler', () => {
  test('a five-second deadline elapses in no real time', async () => {
    const { kit, scheduler } = TestKit.withManualScheduler('ask-virtual');
    try {
      const silent = kit.system.spawn(Silent, 'silent');
      const pending = silent.ask({ kind: 'ping' }, 5_000);
      const realStart = Date.now();

      scheduler.advance(5_000);

      await expect(pending).rejects.toThrow(AskTimeoutError);
      expect(Date.now() - realStart).toBeLessThan(1_000);
    } finally {
      await kit.shutdown();
    }
  });

  test('the deadline is not reached a millisecond early', async () => {
    // The other half of the claim: virtual time has to be *the* clock, not a
    // second clock that also happens to move.
    const { kit, scheduler } = TestKit.withManualScheduler('ask-not-early');
    try {
      const silent = kit.system.spawn(Silent, 'silent');
      let rejected = false;
      const pending = silent.ask({ kind: 'ping' }, 5_000).catch(() => { rejected = true; });

      scheduler.advance(4_999);
      await kit.settle();
      expect(rejected).toBe(false);

      scheduler.advance(1);
      await pending;
      expect(rejected).toBe(true);
    } finally {
      await kit.shutdown();
    }
  });

  test('a probe ask is virtual too, since TestProbe can see its system', async () => {
    const { kit, scheduler } = TestKit.withManualScheduler('ask-probe');
    try {
      const probe = kit.createTestProbe();
      const pending = probe.ask({ kind: 'ping' }, 30_000);
      scheduler.advance(30_000);
      await expect(pending).rejects.toThrow(AskTimeoutError);
    } finally {
      await kit.shutdown();
    }
  });

  test('a real scheduler still expires an ask on the wall clock', async () => {
    // Nothing outside a test changes: without a ManualScheduler the deadline is
    // a real one. Kept short because here the wall clock genuinely is the clock.
    const kit = TestKit.create('ask-wall');
    try {
      const silent = kit.system.spawn(Silent, 'silent');
      await expect(silent.ask({ kind: 'ping' }, 25)).rejects.toThrow(AskTimeoutError);
    } finally {
      await kit.shutdown();
    }
  });

  test('a reply still cancels the deadline it beat', async () => {
    // The scheduler arm has to be cancelled on settle exactly as the raw timer
    // was, or a served ask leaves a task behind on every call.
    const { kit, scheduler } = TestKit.withManualScheduler('ask-cancel');
    try {
      type PingMessage = { kind: 'ping'; replyTo?: { tell(reply: unknown): void } };
      class Echo extends Actor<PingMessage> {
        override onReceive(message: PingMessage): void {
          message.replyTo?.tell('pong');
        }
      }
      const echo = kit.system.spawn(Echo, 'echo');
      const before = scheduler.pendingCount;

      expect(await echo.ask<string>({ kind: 'ping' }, 5_000)).toBe('pong');

      // Back to where it started: the deadline was cancelled, not left armed.
      expect(scheduler.pendingCount).toBe(before);
    } finally {
      await kit.shutdown();
    }
  });
});
