/**
 * Hello ActorSelection: look up an actor by its path rather than by ref.
 * Useful when the spawning code and the using code don't share a reference,
 * e.g. when a config-driven pipeline addresses actors by name.
 *
 *   bun run examples/selection/hello-selection.ts
 */
import { Actor, ActorSystem } from '../../src/index.js';

class Greeter extends Actor<string> {
  override onReceive(name: string): void { console.log(`Hello, ${name}!`); }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('selection-hello');
  system.spawn(Greeter, 'greeter');

  // Tell without resolving — fire-and-forget; delivers or drops to dead letters.
  system.actorSelection('/user/greeter').tell('world');

  // Resolve to a ref for when you need a handle (e.g. to pass as sender).
  const ref = await system.actorSelection('/user/greeter').resolveOne(500);
  ref.tell('again');

  // No sleep: a selection resolves and tells synchronously, so both greetings
  // are on the greeter's mailbox before terminate() starts draining it.
  await system.terminate();
}

void main();
