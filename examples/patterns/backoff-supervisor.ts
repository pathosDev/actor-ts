/**
 * BackoffSupervisor — restart-with-exponential-backoff demo.
 *
 *   bun run examples/patterns/backoff-supervisor.ts
 *
 * Two scenarios in one run:
 *
 *   1. Flaky preStart.  The connector's `preStart` fails three times
 *      before succeeding (e.g. third-party API that's having a bad day).
 *      The supervisor cycles through respawns with growing delays —
 *      ~200ms, ~400ms, ~800ms — and we wait for the connector to
 *      stabilise before sending any work.
 *
 *   2. Runtime crash with stash.  Once stable, we crash the connector
 *      mid-run.  Asks issued during the backoff window are buffered
 *      and replayed against the freshly-spawned incarnation, with their
 *      original senders preserved so the replies still flow back.
 */
import {
  Actor,
  ActorSystem,
  BackoffSupervisor,
  Props,
} from '../../src/index.js';

type Cmd =
  | { kind: 'fetch'; id: number }
  | { kind: 'crash' };

class FlakyConnector extends Actor<Cmd> {
  static failuresLeft = 3;

  override preStart(): void {
    if (FlakyConnector.failuresLeft > 0) {
      FlakyConnector.failuresLeft -= 1;
      const left = FlakyConnector.failuresLeft;
      console.log(`  [connector] preStart failing on purpose (${left} flaky starts left)`);
      throw new Error('upstream not ready');
    }
    console.log('  [connector] preStart succeeded — open for business');
  }

  override onReceive(cmd: Cmd): void {
    if (cmd.kind === 'crash') {
      console.log('  [connector] crashing on purpose');
      throw new Error('runtime crash');
    }
    console.log(`  [connector] handling fetch id=${cmd.id}`);
    this.sender.toNullable()?.tell(`row-${cmd.id}`);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('backoff-demo');

  const supervisor = system.spawn(
    BackoffSupervisor.props({
      childProps: Props.create(() => new FlakyConnector()),
      childName: 'connector',
      minBackoff: 200,
      maxBackoff: 5_000,
      randomFactor: 0.2,
      forward: 'stash',
      resetCounter: 'after-min-stable',
    }),
    'connector-supervisor',
  );

  // --- 1. Wait for the connector to stabilise across preStart failures ---
  console.log('client → waiting for the connector to stabilise...');
  await Bun.sleep(2_000);

  const r1 = await supervisor.ask<string>({ kind: 'fetch', id: 1 }, 1_000);
  console.log('client ← got:', r1);

  // --- 2. Mid-run crash + stash demo ---
  console.log('client → crashing the connector and immediately asking for ids 2/3/4');
  // Tell the connector (via the supervisor) to crash, then wait a moment
  // so the Terminated propagates and the supervisor enters its backoff
  // window before we ask — this is when stash actually kicks in.
  supervisor.tell({ kind: 'crash' });
  await Bun.sleep(50);

  // These three asks land while the supervisor is in its backoff window
  // — they get stashed, drained to the next incarnation, and reply back.
  const replies = await Promise.all([
    supervisor.ask<string>({ kind: 'fetch', id: 2 }, 5_000),
    supervisor.ask<string>({ kind: 'fetch', id: 3 }, 5_000),
    supervisor.ask<string>({ kind: 'fetch', id: 4 }, 5_000),
  ]);
  console.log('client ← got:', replies);

  supervisor.stop();
  await system.terminate();
}

void main();
