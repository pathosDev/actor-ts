/**
 * Realistic futures patterns: wrap a flaky HTTP-like call in `retry`, delay
 * the whole thing with `after`, and pipe the outcome to an actor so it can
 * decide the next step.  The fake service fails twice with a transient
 * error, then succeeds — exponential backoff keeps the retries gentle.
 *
 *   bun run examples/patterns/futures/retry-flaky-api.ts
 */
import {
  Actor,
  ActorSystem,
  Props,
  Success,
  Failure,
  after,
  pipeTo,
  retry,
} from '../../../src/index.js';

class TransientError extends Error {
  constructor(message: string) { super(message); this.name = 'TransientError'; }
}
class FatalError extends Error {
  constructor(message: string) { super(message); this.name = 'FatalError'; }
}

let attempts = 0;
async function flakyRemoteCall(): Promise<{ userId: number }> {
  attempts++;
  if (attempts < 3) throw new TransientError(`transient error #${attempts}`);
  return { userId: 42 };
}

class UserHandler extends Actor<Success<{ userId: number }> | Failure> {
  override onReceive(msg: Success<{ userId: number }> | Failure): void {
    if (msg instanceof Success) {
      console.log(`received user ${msg.value.userId} after ${attempts} attempts`);
    } else {
      console.log(`gave up: ${msg.cause.name}: ${msg.cause.message}`);
    }
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('retry-demo');
  const ref = system.spawn(Props.create(() => new UserHandler()), 'user-handler');

  const work = (): Promise<{ userId: number }> =>
    retry(flakyRemoteCall, {
      attempts: 5,
      delayMs: 40,
      factor: 2,
      maxDelayMs: 200,
      shouldRetry: (err) => err instanceof TransientError,
      onAttempt: (err, n) => console.log(`  attempt #${n} failed: ${err.message}`),
    });

  // Kick off after a 50ms soft start — e.g. to let other things warm up.
  pipeTo(after(50, work), ref);

  await Bun.sleep(500);
  await system.terminate();
}

void main();
