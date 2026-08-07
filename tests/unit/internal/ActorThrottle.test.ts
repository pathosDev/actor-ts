/**
 * Integration tests for `context.throttle()` (#83) — the per-actor
 * token-bucket gate on user-message processing.  The TokenBucket
 * itself is unit-tested in `tests/unit/util/TokenBucket.test.ts`;
 * here we verify the cell-level wiring: pause-mode backpressure,
 * drop-mode loss, system messages bypassing the gate, and
 * cancelThrottle restoring full speed.
 */
import { match } from 'ts-pattern';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

let sys: ActorSystem;
beforeEach(() => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  sys = ActorSystem.create('throttle-test', sysOptions);
});
afterEach(async () => { await sys.terminate(); });

type TickMessage = { kind: 'tick' };
type ConfigureThrottleMessage = { kind: 'configure-throttle' };
type CancelThrottleMessage = { kind: 'cancel-throttle' };

type CountMessage = TickMessage | ConfigureThrottleMessage | CancelThrottleMessage;

class Counter extends Actor<CountMessage> {
  count = 0;
  override onReceive(m: CountMessage): void {
    match(m)
      .with({ kind: 'tick' }, () => this.onTick())
      .with({ kind: 'configure-throttle' }, () => this.onConfigureThrottle())
      .with({ kind: 'cancel-throttle' }, () => this.onCancelThrottle())
      .exhaustive();
  }

  private onTick(): void {
    this.count += 1;
  }

  /** Wide burst, low qps — first 2 messages go through immediately, then throttle. */
  private onConfigureThrottle(): void {
    this.context.throttle({ qps: 10, burst: 2 });
  }

  private onCancelThrottle(): void {
    this.context.cancelThrottle();
  }
}

describe('ActorContext.throttle (#83)', () => {
  test('pause mode — burst messages process immediately, excess waits for refill', async () => {
    const counter = new Counter();
    const ref = sys.spawn(() => counter, 'pause-mode');

    // Configure throttle from inside the actor (one of the two
    // valid contexts — the other being a behavior-injection wrapper).
    ref.tell({ kind: 'configure-throttle' });
    await sleep(10);

    // Send 10 ticks back-to-back.  With qps=10 / burst=2:
    //   - First 2 process immediately (consume the burst).
    //   - Each subsequent tick takes ~100 ms to earn a token.
    //   - 10 total ticks need ~800 ms minimum.
    for (let i = 0; i < 10; i++) ref.tell({ kind: 'tick' });

    // After 50 ms only the burst should have processed.
    await sleep(50);
    expect(counter.count).toBeLessThanOrEqual(3); // 2 burst + maybe 1 timing edge

    // The lower bound — that the throttle really held messages back — is the
    // assertion above.  This half only waits for the queue to drain, which at
    // qps=10 takes ~800 ms on an idle machine; the 1.1 s it used to sleep left
    // 300 ms of slack and paid the full second on every passing run.
    await awaitCondition(() => counter.count === 10, {
      timeoutMs: 4_000,
      intervalMs: 20,
      label: 'the throttled queue drained all ten ticks',
    });
    expect(counter.count).toBe(10);
  }, 5_000);

  test('drop mode — bucket-empty messages are silently discarded', async () => {
    class DropCounter extends Actor<CountMessage> {
      count = 0;
      override preStart(): void {
        this.context.throttle({ qps: 5, burst: 2, onExcess: 'drop' });
      }
      override onReceive(m: CountMessage): void {
        if (m.kind === 'tick') this.count += 1;
      }
    }
    const dc = new DropCounter();
    const ref = sys.spawn(() => dc, 'drop-mode');
    await sleep(10);

    // Fire 20 ticks at once.  Burst=2 means 2 process, the other
    // 18 hit the empty bucket and are dropped.  No backpressure,
    // no waiting — count stays at 2.
    for (let i = 0; i < 20; i++) ref.tell({ kind: 'tick' });
    await sleep(50);
    expect(dc.count).toBe(2);

    // After 250 ms, bucket has refilled (5 qps × 0.25 s = ~1.25
    // tokens — capped at burst=2 if anything fired in between, but
    // nothing fired so just the 1 fresh token).  No new messages
    // were sent though, so count still 2.
    await sleep(250);
    expect(dc.count).toBe(2);

    // Now send 1 more tick — bucket has tokens, processes immediately.
    ref.tell({ kind: 'tick' });
    await awaitCondition(() => dc.count === 3, {
      timeoutMs: 4_000,
      label: 'the tick against a refilled bucket was processed',
    });
    expect(dc.count).toBe(3);
  }, 5_000);

  test('cancelThrottle eventually processes through the throttled queue and drains the rest', async () => {
    // The cancel-throttle message itself goes through the throttle
    // (it's a regular user message), so it has to wait its turn —
    // there's no out-of-band bypass for control messages.  Once it
    // does process, the cell drops the limiter and the remainder of
    // the queue drains in one dispatch cycle.  Test verifies the
    // post-cancel "no more rate limit" behaviour with a generous
    // upper bound for the through-queue wait.
    const counter = new Counter();
    const ref = sys.spawn(() => counter, 'cancel-throttle');
    ref.tell({ kind: 'configure-throttle' }); // qps=10, burst=2
    await sleep(10);

    // 4 ticks under the throttle — burst 2 + 2 paused.
    for (let i = 0; i < 4; i++) ref.tell({ kind: 'tick' });
    await sleep(50);
    expect(counter.count).toBeLessThan(4);

    // Cancel — joins the queue.  At qps=10 it takes ~200 ms to walk
    // through the 2 still-pending ticks before reaching the cancel
    // and another ~0 ms to drain the (zero) remainder.  500 ms slack
    // covers CI variance.
    ref.tell({ kind: 'cancel-throttle' });
    // Only four ticks were ever sent, so the count cannot overshoot — waiting
    // for it beats guessing at 500 ms, which was already only 2.5× the ~200 ms
    // the walk through the pending queue actually needs.
    await awaitCondition(() => counter.count === 4, {
      timeoutMs: 4_000,
      intervalMs: 20,
      label: 'the queue drained once the throttle was cancelled',
    });
    expect(counter.count).toBe(4);
  }, 5_000);

  test('system messages (Terminated, supervision, watch) bypass the throttle', async () => {
    // The actor sets a tight throttle, then we kill it.  The
    // system-side `terminate` command must NOT be gated by the
    // throttle — the actor stops promptly, no token-wait.
    const stopped = { value: false };
    class Strict extends Actor<CountMessage> {
      override preStart(): void {
        this.context.throttle({ qps: 1, burst: 1 });
      }
      override onReceive(_m: CountMessage): void { /* noop */ }
      override postStop(): void { stopped.value = true; }
    }
    const ref = sys.spawn(Strict, 'strict');
    await sleep(20);

    // Drain the burst.
    ref.tell({ kind: 'tick' });
    await sleep(20);

    // Stop — system messages are not subject to the bucket.  `postStop` is the
    // observable that says so; before, the test asserted only that
    // `sys.deadLetters` had a path and leaned entirely on `afterEach` not
    // hanging.  The budget stays generous rather than tuned just below the
    // 1 s the bucket would impose: a tight bound here would be the same trade
    // this change is removing everywhere else.
    ref.stop();
    await awaitCondition(() => stopped.value, {
      timeoutMs: 4_000,
      label: 'the throttled actor stopped',
    });
    expect(stopped.value).toBe(true);
  }, 5_000);

});
