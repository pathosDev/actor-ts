/**
 * Supervisor restart overhead — how expensive is a one-for-one restart?
 * Each op = one failed command + resumed processing.
 *
 * Note: how a child is supervised is decided by its *parent* — either by the
 * parent actor's `supervisorStrategy()` or, per child, by
 * `Props.withSupervisorStrategy` on that child's own Props.  Either way the
 * user guardian's default (maxRetries=10) would abort a 1 000-restart run, so
 * `Shaky` runs inside a `Supervisor` whose strategy permits unlimited
 * restarts.  The extra hop through `Supervisor` is part of the measured
 * round-trip — keep it so numbers stay comparable with earlier runs.
 *
 *   bun run benchmarks/single-node/supervisor-restart.ts
 */
import {
  Actor,
  ActorSystem,
  ActorSystemOptions,
  Directive,
  LogLevel,
  NoopLogger,
  OneForOneStrategy,
  Props,
  type ActorRef,
  type SupervisorStrategy,
} from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

type Command = 'boom' | 'ping';

class Shaky extends Actor<Command> {
  override onReceive(m: Command): void {
    if (m === 'boom') throw new Error('restart-me');
    this.sender.forEach((s) => s.tell('pong'));
  }
}

class Supervisor extends Actor<Command> {
  private child!: ActorRef<Command>;
  override preStart(): void {
    this.child = this.context.spawn(Props.create(() => new Shaky()), 'shaky');
  }
  override supervisorStrategy(): SupervisorStrategy {
    return new OneForOneStrategy(() => Directive.Restart, { maxRetries: -1 });
  }
  override onReceive(m: Command): void {
    // Forward to child, preserving sender for `ask`.
    this.child.tell(m, this.sender.toNullable());
  }
}

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('bench-supervise', systemOptions);
  const ref = system.spawnAnonymous(Props.create(() => new Supervisor()));

  await runGroup('single-node · supervisor-restart', [
    {
      name: 'restart + ping round-trip',
      unit: 'restart',
      iterations: 1_000,
      run: async () => {
        ref.tell('boom');
        await ref.ask<string>('ping', 5_000);
      },
    },
  ]);

  await system.terminate();
}

void main();
