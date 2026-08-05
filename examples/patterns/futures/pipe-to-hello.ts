/**
 * Hello pipeTo/after/retry: kick off a promise-returning operation and
 * pipe its eventual result into an actor's mailbox wrapped as
 * Success or Failure.
 *
 *   bun run examples/patterns/futures/pipe-to-hello.ts
 */
import { Actor, ActorSystem, Success, Failure, after, pipeTo } from '../../../src/index.js';
import { attachDevTools } from '../../devtools.js';

class ResultHandler extends Actor<Success<number> | Failure> {
  override onReceive(message: Success<number> | Failure): void {
    if (message instanceof Success) console.log(`success: ${message.value}`);
    else console.log(`failure: ${message.cause.message}`);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('pipe-hello');
  const devtools = await attachDevTools(system);
  const ref = system.spawn(ResultHandler, 'handler');

  // Promise that resolves to a number — arrives as Success.
  pipeTo(Promise.resolve(42), ref);

  // Promise that rejects — arrives as Failure.
  pipeTo(Promise.reject(new Error('boom')), ref);

  // "after" delays the creation of the promise itself.
  pipeTo(after(30, () => Promise.resolve(99)), ref);

  await Bun.sleep(80);
  await devtools.holdOpen();
  await system.terminate();
}

void main();
