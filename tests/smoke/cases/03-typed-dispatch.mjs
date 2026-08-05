/**
 * Smoke case: typed message dispatch through an Actor's onReceive.
 * Verifies the discriminated-union pattern survives across runtimes —
 * ts-pattern's match() is heavily used in the framework's hot paths
 * and depends on V8/JSC iterator semantics.
 */
export const name = 'typed dispatch';
export const description = 'discriminated-union message dispatch via ts-pattern';

export async function run({ actorTs }) {
  const { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { match } = await import('ts-pattern');

  class Greeter extends Actor {
    constructor() { super(); this.last = null; }
    onReceive(m) {
      match(m)
        .with({ kind: 'greet' }, (g) => this.onGreet(g))
        .with({ kind: 'farewell' }, (f) => this.onFarewell(f))
        .with({ kind: 'ask' }, () => this.onAsk())
        .exhaustive();
    }
    onGreet(m) { this.last = `Hello, ${m.name}!`; }
    onFarewell(m) { this.last = `Goodbye, ${m.name}.`; }
    onAsk() { this.sender.forEach((s) => s.tell(this.last)); }
  }

  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create('smoke-typed', sysOptions);
  try {
    const ref = sys.spawnAnonymous(Greeter);
    ref.tell({ kind: 'greet', name: 'World' });
    let got = await ref.ask({ kind: 'ask' }, 5_000);
    if (got !== 'Hello, World!') throw new Error(`greet mismatch: ${got}`);

    ref.tell({ kind: 'farewell', name: 'World' });
    got = await ref.ask({ kind: 'ask' }, 5_000);
    if (got !== 'Goodbye, World.') throw new Error(`farewell mismatch: ${got}`);
  } finally {
    await sys.terminate();
  }
}
