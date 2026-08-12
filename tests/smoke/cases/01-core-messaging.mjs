/**
 * Smoke case: core actor messaging.  N tells + one ask round-trip.
 * Catches "actor system doesn't even boot" regressions.
 *
 * N=20_000 deliberately clears the 10 000 the default mailbox used to be
 * bounded at (#310, reversed by #1148).  This suite is the only gate that
 * runs on Bun, Node and Deno, so it is the only place a runtime-specific
 * regression in the unbounded default would surface — and the exact count
 * coming back is what proves nothing was dropped.
 */
export const name = 'core actor messaging';
export const description = '20k tells + ask round-trip';

export async function run({ actorTs }) {
  const { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  class Counter extends Actor {
    constructor() { super(); this.n = 0; }
    onReceive(m) {
      if (m === 'inc') this.n++;
      else this.sender.forEach((s) => s.tell(this.n));
    }
  }
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create('smoke-core', sysOptions);
  try {
    const ref = sys.spawnAnonymous(Counter);
    const N = 20_000;
    for (let i = 0; i < N; i++) ref.tell('inc');
    const got = await ref.ask('get', 30_000);
    if (got !== N) throw new Error(`counter mismatch: ${got} !== ${N}`);
  } finally {
    await sys.terminate();
  }
}
