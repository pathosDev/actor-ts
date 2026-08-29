/**
 * The simplest possible actor-ts program.
 *
 *   tsx examples/hello-world.ts
 */
import { Actor, ActorSystem } from '../src/index.js';

class GreeterActor extends Actor<string> {
  override onReceive(who: string): void {
    console.log(`Hello, ${who}!`);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('hello');
  const greeter = system.spawn(GreeterActor, 'greeter');

  greeter.tell('World');
  greeter.tell('actor-ts');

  // No sleep: terminate() drains what is already queued before it stops
  // anything, so both greetings are printed.
  await system.terminate();
}

void main();
