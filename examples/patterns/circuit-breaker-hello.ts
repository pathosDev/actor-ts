/**
 * Hello Circuit Breaker: wrap a flaky call and watch the state transition
 *   closed → open → half-open → closed
 * as failures stack up and the probe eventually succeeds.
 *
 *   bun run examples/patterns/circuit-breaker-hello.ts
 */
import { CircuitBreaker } from '../../src/index.js';

async function main(): Promise<void> {
  const cb = new CircuitBreaker({ maxFailures: 2, resetTimeoutMs: 150 });
  cb.onStateChange((s) => console.log(`breaker → ${s}`));

  let calls = 0;
  const flaky = async (): Promise<string> => {
    calls++;
    if (calls < 4) throw new Error(`attempt ${calls} failed`);
    return `attempt ${calls} succeeded`;
  };

  for (let i = 0; i < 6; i++) {
    try {
      const result = await cb.call(flaky);
      console.log(`call#${i}: ${result}`);
    } catch (e) {
      console.log(`call#${i}: ${(e as Error).name}: ${(e as Error).message}`);
    }
    if (cb.state === 'open') {
      console.log(`  (open — waiting 200ms for the reset window)`);
      await Bun.sleep(200);
    }
  }
}

void main();
