/**
 * become / unbecome overhead — how fast can we swap behaviors?
 *
 *   bun run benchmarks/single-node/become-unbecome.ts
 */
import { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger, Props, ask } from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

type Message = 'swap' | { kind: 'ping' };

class Swapper extends Actor<Message> {
  override onReceive(m: Message): void {
    if (m === 'swap') {
      this.context.become((inner) => {
        if (inner === 'swap') this.context.unbecome();
        else if ((inner as { kind: string }).kind === 'ping') {
          this.sender.forEach((s) => s.tell('pong'));
        }
      });
      return;
    }
    if ((m as { kind: string }).kind === 'ping') {
      this.sender.forEach((s) => s.tell('pong'));
    }
  }
}

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('bench-become', systemOptions);
  const ref = system.spawnAnonymous(Props.create(() => new Swapper()));

  await runGroup('single-node · become/unbecome', [
    {
      name: 'swap→ping→swap-back→ping',
      unit: 'swap',
      iterations: 2_000,
      opsPerIteration: 2,
      run: async () => {
        ref.tell('swap');
        await ask<Message, 'pong'>(ref, { kind: 'ping' }, 10_000);
        ref.tell('swap');
        await ask<Message, 'pong'>(ref, { kind: 'ping' }, 10_000);
      },
    },
  ]);

  await system.terminate();
}

void main();
