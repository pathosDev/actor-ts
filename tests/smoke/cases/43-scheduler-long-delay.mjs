/**
 * Smoke case: a delay past the host timer ceiling waits, on every runtime.
 *
 * `setTimeout` and `setInterval` cannot hold a delay above 2^31 - 1 ms, and
 * what each runtime does with one differs: Bun and Node arm it as 1 ms with a
 * `TimeoutOverflowWarning`, Deno wraps it modulo 2^32 without a word — so 2^31
 * fires at once there, and 2^32 + 300 after 300 ms.  Either way a 2^31 ms
 * one-shot fired within milliseconds, a 2^31 ms interval became a loop, and an
 * ask with a 2^31 ms deadline rejected almost at once.  The scheduler and the ask
 * now chain links of at most `MAX_TIMER_DELAY_MS`; the unit tests prove the
 * chain on a virtual host, and this case asks each real runtime whether the
 * first link it was handed actually holds.
 *
 * Everything armed here is released in `finally` on every path — the one-shot
 * and the interval by `cancel()`, the ask by a reply — because a link left
 * armed is a 24.9-day timer: it would hold Deno's event loop open past the last
 * case, and the runner's exit watchdog would report it as a leak (#1196).
 */
export const name = 'scheduler long delay';
export const description = 'a 2^31 ms one-shot, interval and ask deadline hold instead of firing at once';

/** One past the largest delay a host timer holds (2^31 - 1 ms, ~24.9 days). */
const CEILING_PLUS_ONE_MS = 2_147_483_648;
/** The overflow fired within ~17 ms on Bun, ~1 ms on Node and at once on Deno. */
const OBSERVE_FOR_MS = 100;

export async function run({ actorTs }) {
  const { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger, Scheduler } = actorTs;

  /** Holds the first asker and answers it once told to, so the ask is settled by a reply. */
  class Holder extends Actor {
    constructor() { super(); this.waiting = null; }
    onReceive(message) {
      if (message !== 'release') {
        this.waiting = this.sender.toNullable();
        return;
      }
      this.waiting?.tell('released');
      this.waiting = null;
    }
  }

  const scheduler = new Scheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('smoke-long-delay', systemOptions);
  let oneShot = null;
  let interval = null;
  let holder = null;
  let pendingAsk = null;
  try {
    let oneShotFired = false;
    let ticks = 0;
    let askOutcome = 'pending';
    oneShot = scheduler.scheduleOnceFunction(CEILING_PLUS_ONE_MS, () => { oneShotFired = true; });
    interval = scheduler.scheduleAtFixedRateFunction(1, CEILING_PLUS_ONE_MS, () => { ticks += 1; });
    holder = system.spawn(Holder, 'holder');
    pendingAsk = holder.ask('hold', CEILING_PLUS_ONE_MS).then(
      (reply) => { askOutcome = `replied ${reply}`; },
      (error) => { askOutcome = `rejected ${error?.constructor?.name ?? error}`; },
    );

    await new Promise((resolve) => { setTimeout(resolve, OBSERVE_FOR_MS); });

    if (oneShotFired) throw new Error(`a ${CEILING_PLUS_ONE_MS} ms one-shot fired within ${OBSERVE_FOR_MS} ms`);
    if (ticks !== 1) {
      throw new Error(`a ${CEILING_PLUS_ONE_MS} ms interval ticked ${ticks} times in ${OBSERVE_FOR_MS} ms (expected the first tick only)`);
    }
    if (askOutcome !== 'pending') {
      throw new Error(`an ask with a ${CEILING_PLUS_ONE_MS} ms deadline settled within ${OBSERVE_FOR_MS} ms: ${askOutcome}`);
    }
    if (!oneShot.cancel()) throw new Error('the long one-shot could not be cancelled');
  } finally {
    oneShot?.cancel();
    interval?.cancel();
    if (pendingAsk !== null) {
      // The reply settles the ask and cancels the link it had armed.
      holder.tell('release');
      await pendingAsk;
    }
    scheduler.shutdown();
    await system.terminate();
  }
}
