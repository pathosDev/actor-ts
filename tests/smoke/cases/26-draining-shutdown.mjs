/**
 * Smoke case: `terminate()` drains `/user` before it stops anything (#663).
 *
 * Cross-runtime because the drain is the one shutdown step built on the
 * *timer* phase rather than on the dispatcher: it polls for quiescence with
 * `setTimeout`, and every runtime clamps and orders that differently against
 * `setImmediate` (Bun), the macrotask queue (Node) and Deno's op scheduler.
 * A drain that resolves a phase too early on one of them would deliver fewer
 * messages there and nowhere else — invisible to `bun test`.
 *
 * It is also the change that keeps the event loop alive later into shutdown
 * than anything before it, so this case doubles as the check that the extra
 * timers do not outlive the run: no handle is left armed on any path, and the
 * process exits on its own rather than being reaped by the watchdog.
 */
export const name = 'draining shutdown';
export const description = 'terminate() drains a backlog, a rally and a graceful stop';

export async function run({ actorTs }) {
  const {
    Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger, gracefulStop,
  } = actorTs;

  const newSystem = (systemName) => ActorSystem.create(
    systemName,
    ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
  );

  // 1. A backlog queued on a started, idle actor.  Deeper than two on purpose:
  //    before the drain existed, the terminate cascade let exactly two through
  //    — one per hop of root -> /user-guardian -> child — however many were
  //    queued, so a shallower check passes against the old behaviour.
  const seen = [];
  class Recorder extends Actor {
    onReceive(message) { seen.push(message); }
  }
  const backlogSystem = newSystem('smoke-drain-backlog');
  try {
    const ref = backlogSystem.spawnAnonymous(Recorder);
    const count = 500;
    for (let index = 0; index < count; index++) ref.tell(index);
    await backlogSystem.terminate();
    if (seen.length !== count) {
      throw new Error(`drained ${seen.length} of ${count} queued messages`);
    }
  } finally {
    await backlogSystem.terminate();
  }

  // 2. Transitivity: neither mailbox is ever deep, the work only exists
  //    because draining it creates more.  A single flush of each queue stops
  //    after one hop.
  let hops = 0;
  class Bouncer extends Actor {
    onReceive(remaining) {
      hops += 1;
      if (remaining > 0) {
        this.sender.forEach((peer) => peer.tell(remaining - 1, this.self));
      }
    }
  }
  const rallySystem = newSystem('smoke-drain-rally');
  try {
    const ping = rallySystem.spawnAnonymous(Bouncer);
    const pong = rallySystem.spawnAnonymous(Bouncer);
    ping.tell(50, pong);
    await rallySystem.terminate();
    if (hops !== 51) throw new Error(`rally stopped after ${hops} hops, expected 51`);
  } finally {
    await rallySystem.terminate();
  }

  // 3. `gracefulStop` settles on the real `Terminated`, not on a timer.
  const stopSystem = newSystem('smoke-drain-graceful-stop');
  try {
    const handled = [];
    class Worker extends Actor {
      onReceive(message) { handled.push(message); }
    }
    const worker = stopSystem.spawnAnonymous(Worker);
    for (let index = 0; index < 25; index++) worker.tell(index);

    const startedAt = Date.now();
    const stopped = await gracefulStop(worker, 5_000);
    const elapsedMs = Date.now() - startedAt;

    if (stopped !== true) throw new Error('gracefulStop did not confirm the stop');
    if (handled.length !== 25) {
      throw new Error(`gracefulStop stopped after ${handled.length} of 25 messages`);
    }
    // A PoisonPill behind 25 messages is not a five-second wait anywhere; if
    // this is near the budget the promise settled on the timeout instead.
    if (elapsedMs >= 4_000) throw new Error(`gracefulStop took ${elapsedMs} ms`);
  } finally {
    await stopSystem.terminate();
  }

  // 4. The budget really bounds it.  A self-tell loop never goes quiet, so
  //    only the configured drain timeout ends the wait — and the system must
  //    still terminate, on every runtime.
  const boundedSystem = ActorSystem.create(
    'smoke-drain-bounded',
    ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { system: { 'shutdown-drain-timeout': 150 } } }),
  );
  try {
    class Perpetual extends Actor {
      onReceive(message) { this.self.tell(message); }
    }
    boundedSystem.spawnAnonymous(Perpetual).tell('go');

    const startedAt = Date.now();
    await boundedSystem.terminate();
    const elapsedMs = Date.now() - startedAt;

    if (!boundedSystem.isTerminated) throw new Error('bounded drain left the system up');
    if (elapsedMs >= 3_000) throw new Error(`bounded drain took ${elapsedMs} ms`);
  } finally {
    await boundedSystem.terminate();
  }
}
