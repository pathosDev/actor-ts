/**
 * Hello ActorSelection: look up an actor by its path rather than by ref.
 * Useful when the spawning code and the using code don't share a reference,
 * e.g. when a config-driven pipeline addresses actors by name.
 *
 *   bun run examples/selection/hello-selection.ts
 */
import { Actor, ActorSystem, Props } from '../../src/index.js';

class Greeter extends Actor<string> {
  override onReceive(name: string): void { console.log(`Hello, ${name}!`); }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('selection-hello');
  system.actorOf(Props.create(() => new Greeter()), 'greeter');

  // Tell without resolving — fire-and-forget; delivers or drops to dead letters.
  system.actorSelection('/user/greeter').tell('world');

  // Resolve to a ref for when you need a handle (e.g. to pass as sender).
  const ref = await system.actorSelection('/user/greeter').resolveOne(500);
  ref.tell('again');

  await Bun.sleep(30);
  await system.terminate();
}

void main();
