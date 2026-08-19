/**
 * Smoke case: the default dispatcher yields to the event loop.
 *
 * The default wakes actors on the microtask queue and spends every 64th unit
 * on a macrotask so timers and I/O still get a turn.  Whether that actually
 * yields is runtime-specific in a way a unit test on one engine cannot see:
 * the relative ordering of microtasks, `setImmediate` and timers is decided by
 * each engine's loop, and this suite is the only gate that runs on all three.
 *
 * (All three do provide `setImmediate`, so the dispatcher's `setTimeout(…, 0)`
 * fallback is *not* covered here — it is there for browsers, which no gate in
 * this repository exercises.)
 *
 * Two actors volley 4 000 times, which is far past the 64-unit budget, while a
 * repeating timer tries to run.  Without a yield the timer fires zero times:
 * a microtask queue that refills itself never lets the loop advance.  The
 * assertion is deliberately weak — *some* progress, not a count — because how
 * many times a 1 ms timer fires inside a volley is a property of the machine,
 * while whether it fires at all is a property of the scheduler.
 *
 * The timer is cleared on every path, including the failing one: a repeating
 * timer left armed keeps one runtime's event loop alive and the whole suite
 * then hangs after its last green line instead of exiting (#1196).
 */
export const name = 'dispatcher fairness';
export const description = 'a 4k volley does not starve a timer';

export async function run({ actorTs }) {
  const { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;

  const EXCHANGES = 4_000;
  let timerTicks = 0;
  let timer = null;

  class Pong extends Actor {
    onReceive() { this.sender.forEach((s) => s.tell('pong', this.context.self)); }
  }
  class Ping extends Actor {
    constructor(partner) { super(); this.partner = partner; this.done = 0; this.replyTo = null; }
    onReceive(message) {
      if (message === 'start') {
        this.replyTo = this.sender;
        this.partner.tell('ping', this.context.self);
        return;
      }
      this.done++;
      if (this.done >= EXCHANGES) {
        this.replyTo.forEach((s) => s.tell(this.done));
        return;
      }
      this.partner.tell('ping', this.context.self);
    }
  }

  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create('smoke-dispatcher-fairness', sysOptions);
  try {
    // Named so a failure says which scheduler was in play, not just that a
    // number was zero.
    if (!sys.dispatcher.id.includes('hybrid')) {
      throw new Error(`expected the hybrid dispatcher by default, got ${sys.dispatcher.id}`);
    }

    timer = setInterval(() => { timerTicks++; }, 1);
    const pong = sys.spawnAnonymous(Pong);
    const ping = sys.spawnAnonymous(() => new Ping(pong));
    const completed = await ping.ask('start', 30_000);
    if (completed !== EXCHANGES) {
      throw new Error(`volley mismatch: ${completed} !== ${EXCHANGES}`);
    }
    if (timerTicks === 0) {
      throw new Error(`the volley starved the event loop: the timer never fired across ${EXCHANGES} exchanges`);
    }
  } finally {
    if (timer !== null) clearInterval(timer);
    await sys.terminate();
  }
}
