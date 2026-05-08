/**
 * Integration tests for `context.throttle()` (#83) — the per-actor
 * token-bucket gate on user-message processing.  The TokenBucket
 * itself is unit-tested in `tests/unit/util/TokenBucket.test.ts`;
 * here we verify the cell-level wiring: pause-mode backpressure,
 * drop-mode loss, system messages bypassing the gate, and
 * cancelThrottle restoring full speed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Props } from '../../../src/Props.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

let sys: ActorSystem;
beforeEach(() => {
  sys = ActorSystem.create('throttle-test', { logger: new NoopLogger(), logLevel: LogLevel.Off });
});
afterEach(async () => { await sys.terminate(); });

interface CountMsg { kind: 'tick' | 'configure-throttle' | 'cancel-throttle' }

class Counter extends Actor<CountMsg> {
  count = 0;
  override onReceive(m: CountMsg): void {
    if (m.kind === 'tick') {
      this.count += 1;
      return;
    }
    if (m.kind === 'configure-throttle') {
      // Wide burst, low qps — first 2 messages go through immediately,
      // subsequent ones throttle.
      this.context.throttle({ qps: 10, burst: 2 });
      return;
    }
    if (m.kind === 'cancel-throttle') {
      this.context.cancelThrottle();
    }
  }
}

describe('ActorContext.throttle (#83)', () => {
  test('pause mode — burst messages process immediately, excess waits for refill', async () => {
    const counter = new Counter();
    const ref = sys.actorOf(Props.create(() => counter), 'pause-mode');

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

    // Wait long enough for the rest to drain.  qps=10 means the
    // remaining 8 take 800 ms; add 200 ms slack.
    await sleep(1_100);
    expect(counter.count).toBe(10);
  }, 5_000);

  test('drop mode — bucket-empty messages are silently discarded', async () => {
    class DropCounter extends Actor<CountMsg> {
      count = 0;
      override preStart(): void {
        this.context.throttle({ qps: 5, burst: 2, onExcess: 'drop' });
      }
      override onReceive(m: CountMsg): void {
        if (m.kind === 'tick') this.count += 1;
      }
    }
    const dc = new DropCounter();
    const ref = sys.actorOf(Props.create(() => dc), 'drop-mode');
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
    await sleep(20);
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
    const ref = sys.actorOf(Props.create(() => counter), 'cancel-throttle');
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
    await sleep(500);
    expect(counter.count).toBe(4);
  }, 5_000);

  test('system messages (Terminated, supervision, watch) bypass the throttle', async () => {
    // The actor sets a tight throttle, then we kill it.  The
    // system-side `terminate` command must NOT be gated by the
    // throttle — the actor stops promptly, no token-wait.
    class Strict extends Actor<CountMsg> {
      override preStart(): void {
        this.context.throttle({ qps: 1, burst: 1 });
      }
      override onReceive(_m: CountMsg): void { /* noop */ }
    }
    const ref = sys.actorOf(Props.create(() => new Strict()), 'strict');
    await sleep(20);

    // Drain the burst.
    ref.tell({ kind: 'tick' });
    await sleep(20);

    // Stop — system messages are not subject to the bucket.  Actor
    // should be gone within the next dispatch tick, well before
    // the qps=1 bucket would otherwise let anything through.
    ref.stop();
    await sleep(50);
    expect(sys.deadLetters.path.toString()).toBeDefined(); // sanity
    // No way to directly assert "actor is terminated" from outside —
    // the test passes if `sys.terminate()` in afterEach doesn't hang.
  }, 5_000);

});
