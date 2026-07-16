/**
 * Two actors bouncing a message back and forth — the "hello world" of the
 * actor model.
 *
 *   tsx examples/ping-pong.ts
 */
import { match } from 'ts-pattern';
import { Actor, ActorSystem, Props } from '../src/index.js';

type PingMessage = { kind: 'ping'; n: number };
type PongMessage = { kind: 'pong'; n: number };
type StartMessage = { kind: 'start' };
type PingPong = PingMessage | PongMessage | StartMessage;

class Pinger extends Actor<PingPong> {
  private remaining = 5;
  constructor(private readonly target: () => import('../src/index.js').ActorRef<PingPong>) { super(); }

  override onReceive(msg: PingPong): void {
    match(msg)
      .with({ kind: 'start' }, () => this.onStart())
      .with({ kind: 'pong' }, (m) => this.onPong(m))
      .with({ kind: 'ping' }, () => this.onPing())
      .exhaustive();
  }

  private onStart(): void {
    this.target().tell({ kind: 'ping', n: 1 }, this.self);
  }

  private onPong(m: PongMessage): void {
    console.log(`[pinger] got pong#${m.n}`);
    if (--this.remaining <= 0) { this.self.stop(); return; }
    this.target().tell({ kind: 'ping', n: m.n + 1 }, this.self);
  }

  private onPing(): void { /* Pinger doesn't handle pings */ }
}

class Ponger extends Actor<PingPong> {
  override onReceive(msg: PingPong): void {
    match(msg)
      .with({ kind: 'ping' }, (m) => this.onPing(m))
      .otherwise(() => this.onUnhandled());
  }

  private onPing(m: PingMessage): void {
    console.log(`[ponger] got ping#${m.n}`);
    this.sender.forEach((s) => s.tell({ kind: 'pong', n: m.n }, this.self));
  }

  private onUnhandled(): void { /* Ponger only reacts to pings */ }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('ping-pong');

  const ponger = system.spawn(Props.create(() => new Ponger()), 'ponger');
  const pinger = system.spawn(Props.create(() => new Pinger(() => ponger)), 'pinger');

  pinger.tell({ kind: 'start' });

  // Let them finish, then clean up.
  await new Promise(resolve => setTimeout(resolve, 100));
  await system.terminate();
}

void main();
