/**
 * Smoke case: core actor messaging.  N tells + one ask round-trip.
 * Catches "actor system doesn't even boot" regressions.
 *
 * N=1000 because the default mailbox is now bounded at 10k (#310);
 * 10k tells + 1 ask = 10001 which would lose one message to
 * drop-head.  1000 is more than enough to verify the core path
 * works — we're not trying to benchmark throughput here.
 */
export const name = 'core actor messaging';
export const description = '1k tells + ask round-trip';

export async function run({ actorTs }) {
  const { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger, Props } = actorTs;
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
    const ref = sys.spawnAnonymous(Props.create(() => new Counter()));
    const N = 1_000;
    for (let i = 0; i < N; i++) ref.tell('inc');
    const got = await ref.ask('get', 5_000);
    if (got !== N) throw new Error(`counter mismatch: ${got} !== ${N}`);
  } finally {
    await sys.terminate();
  }
}
