/**
 * Supervisor restart overhead — how expensive is a one-for-one restart?
 * Each op = one failed command + resumed processing.
 *
 * Note: `withSupervisorStrategy` on Props sets the strategy an actor uses to
 * supervise its OWN children.  How a child is supervised is decided by its
 * *parent*, so we spawn `Shaky` inside a `Supervisor` actor whose
 * `supervisorStrategy()` permits unlimited restarts.  Without this, the
 * user-guardian's default strategy (maxRetries=10) would abort the run.
 *
 *   bun run benchmarks/single-node/supervisor-restart.ts
 */
import {
  Actor,
  ActorSystem,
  Directive,
  LogLevel,
  NoopLogger,
  OneForOneStrategy,
  Props,
  ask,
  type ActorRef,
  type SupervisorStrategy,
} from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

type Cmd = 'boom' | 'ping';

class Shaky extends Actor<Cmd> {
  override onReceive(m: Cmd): void {
    if (m === 'boom') throw new Error('restart-me');
    this.sender.forEach((s) => s.tell('pong'));
  }
}

class Supervisor extends Actor<Cmd> {
  private child!: ActorRef<Cmd>;
  override preStart(): void {
    this.child = this.context.spawn(Props.create(() => new Shaky()), 'shaky');
  }
  override supervisorStrategy(): SupervisorStrategy {
    return new OneForOneStrategy(() => Directive.Restart, { maxRetries: -1 });
  }
  override onReceive(m: Cmd): void {
    // Forward to child, preserving sender for `ask`.
    this.child.tell(m, this.sender.toNullable());
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('bench-supervise', { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const ref = system.spawnAnonymous(Props.create(() => new Supervisor()));

  await runGroup('single-node · supervisor-restart', [
    {
      name: 'restart + ping round-trip',
      unit: 'restart',
      iterations: 1_000,
      run: async () => {
        ref.tell('boom');
        await ask<Cmd, string>(ref, 'ping', 5_000);
      },
    },
  ]);

  await system.terminate();
}

void main();
