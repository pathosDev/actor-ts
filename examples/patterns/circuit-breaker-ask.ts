/**
 * Realistic Circuit Breaker: protect ask-based calls to a downstream
 * actor that sometimes hangs.  The breaker opens after 3 consecutive
 * ask-timeouts and refuses further calls until the reset window elapses.
 *
 *   bun run examples/patterns/circuit-breaker-ask.ts
 */
import {
  Actor,
  ActorSystem,
  CircuitBreaker,
  CircuitBreakerOpenError,
  Props,
  ask,
} from '../../src/index.js';

type Cmd = { kind: 'ping'; id: number } | { kind: 'hang' };

// A service that responds to ping but silently hangs on 'hang'.
class FlakyService extends Actor<Cmd> {
  override onReceive(cmd: Cmd): void {
    if (cmd.kind === 'ping') this.sender.forEach((__s) => __s.tell(`pong#${cmd.id}`));
    // 'hang' intentionally drops the message — ask times out.
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('cb-realistic');
  const svc = system.actorOf(Props.create(() => new FlakyService()), 'svc');

  const breaker = new CircuitBreaker({
    maxFailures: 3,
    resetTimeoutMs: 400,
    callTimeoutMs: 100, // ask timeout-ish guard
  });
  breaker.onStateChange((s) => console.log(`breaker → ${s}`));

  // First: 3 hangs in a row → breaker opens.
  for (let i = 0; i < 3; i++) {
    try {
      await breaker.call(() => ask<Cmd, string>(svc, { kind: 'hang' }, 100));
    } catch (e) {
      console.log(`call#${i} failed: ${(e as Error).name}`);
    }
  }

  // Now a normal ping — should be rejected immediately with CircuitBreakerOpenError.
  try {
    const v = await breaker.call(() => ask<Cmd, string>(svc, { kind: 'ping', id: 42 }, 100));
    console.log(`unexpected success: ${v}`);
  } catch (e) {
    if (e instanceof CircuitBreakerOpenError) console.log('rejected fast — breaker is open');
  }

  // Wait for the reset window; next call probes in half-open state.
  await Bun.sleep(450);
  const v = await breaker.call(() => ask<Cmd, string>(svc, { kind: 'ping', id: 99 }, 100));
  console.log(`probe succeeded → ${v}, state=${breaker.state}`);

  await system.terminate();
}

void main();
