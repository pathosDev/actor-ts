/**
 * The simplest possible actor-ts program.
 *
 *   tsx examples/hello-world.ts
 */
import { Actor, ActorSystem, Props } from '../src/index.js';

class GreeterActor extends Actor<string> {
  override onReceive(who: string): void {
    console.log(`Hello, ${who}!`);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('hello');
  const greeter = system.spawn(Props.create(() => new GreeterActor()), 'greeter');

  greeter.tell('World');
  greeter.tell('actor-ts');

  // Give the dispatcher a tick to run, then shut down.
  await new Promise(resolve => setTimeout(resolve, 20));
  await system.terminate();
}

void main();
