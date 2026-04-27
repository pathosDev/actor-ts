/**
 * Two actors bouncing a message back and forth — the "hello world" of the
 * actor model.
 *
 *   tsx examples/ping-pong.ts
 */
import { match } from 'ts-pattern';
import { Actor, ActorSystem, Props } from '../src/index.js';

type PingPong = { kind: 'ping'; n: number } | { kind: 'pong'; n: number } | { kind: 'start' };

class Pinger extends Actor<PingPong> {
  private remaining = 5;
  constructor(private readonly target: () => import('../src/index.js').ActorRef<PingPong>) { super(); }

  override onReceive(msg: PingPong): void {
    match(msg)
      .with({ kind: 'start' }, () => this.target().tell({ kind: 'ping', n: 1 }, this.self))
      .with({ kind: 'pong' }, (m) => {
        console.log(`[pinger] got pong#${m.n}`);
        if (--this.remaining <= 0) { this.self.stop(); return; }
        this.target().tell({ kind: 'ping', n: m.n + 1 }, this.self);
      })
      .with({ kind: 'ping' }, () => { /* Pinger doesn't handle pings */ })
      .exhaustive();
  }
}

class Ponger extends Actor<PingPong> {
  override onReceive(msg: PingPong): void {
    match(msg)
      .with({ kind: 'ping' }, (m) => {
        console.log(`[ponger] got ping#${m.n}`);
        this.sender.forEach((s) => s.tell({ kind: 'pong', n: m.n }, this.self));
      })
      .otherwise(() => { /* Ponger only reacts to pings */ });
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('ping-pong');

  const ponger = system.actorOf(Props.create(() => new Ponger()), 'ponger');
  const pinger = system.actorOf(Props.create(() => new Pinger(() => ponger)), 'pinger');

  pinger.tell({ kind: 'start' });

  // Let them finish, then clean up.
  await new Promise(resolve => setTimeout(resolve, 100));
  await system.terminate();
}

void main();
