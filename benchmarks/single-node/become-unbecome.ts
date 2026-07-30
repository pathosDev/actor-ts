/**
 * become / unbecome overhead — how fast can we swap behaviors?
 *
 *   bun run benchmarks/single-node/become-unbecome.ts
 */
import { match } from 'ts-pattern';
import { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger, Props, ask } from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

type PingMessage = { kind: 'ping' };

type Message = 'swap' | PingMessage;

class Swapper extends Actor<Message> {
  override onReceive(m: Message): void {
    match(m)
      .with('swap', () => this.onSwap())
      .with({ kind: 'ping' }, () => this.onPing())
      .exhaustive();
  }

  /** Swap in the mirror behavior; there, 'swap' swaps back out again. */
  private onSwap(): void {
    this.context.become((inner) => {
      match(inner as Message)
        .with('swap', () => this.context.unbecome())
        .with({ kind: 'ping' }, () => this.onPing())
        .exhaustive();
    });
  }

  private onPing(): void {
    this.sender.forEach((s) => s.tell('pong'));
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
