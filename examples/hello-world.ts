/**
 * The simplest possible actor-ts program.
 *
 *   tsx examples/hello-world.ts
 */
import { Actor, ActorSystem } from '../src/index.js';
import { attachDevTools } from './devtools.js';

class GreeterActor extends Actor<string> {
  override onReceive(who: string): void {
    console.log(`Hello, ${who}!`);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('hello');
  const devtools = await attachDevTools(system);
  const greeter = system.spawn(GreeterActor, 'greeter');

  greeter.tell('World');
  greeter.tell('actor-ts');

  // Give the dispatcher a tick to run, then shut down.
  await new Promise(resolve => setTimeout(resolve, 20));
  await devtools.holdOpen();
  await system.terminate();
}

void main();
