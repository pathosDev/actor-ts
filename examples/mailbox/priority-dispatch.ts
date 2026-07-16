/**
 * Realistic Priority Mailbox: a dispatcher actor handles three message
 * tiers — heartbeat (pri=0, urgent), command (pri=1), log (pri=10).
 * Regardless of insertion order, the actor always drains in priority
 * order.  Useful for "urgent signals never wait behind bulk traffic".
 *
 *   bun run examples/mailbox/priority-dispatch.ts
 */
import { match } from 'ts-pattern';
import {
  Actor,
  ActorSystem,
  PriorityMailbox,
  Props,
} from '../../src/index.js';

type Msg =
  | { kind: 'heartbeat'; ts: number }
  | { kind: 'command'; id: string }
  | { kind: 'log'; line: string };

const priorityFor = (m: Msg): number =>
  match(m)
    .with({ kind: 'heartbeat' }, () => 0)
    .with({ kind: 'command' }, () => 1)
    .with({ kind: 'log' }, () => 10)
    .exhaustive();

class Dispatcher extends Actor<Msg> {
  override async onReceive(m: Msg): Promise<void> {
    await Bun.sleep(15); // simulate non-trivial work
    match(m)
      .with({ kind: 'heartbeat' }, (hb) => this.onHeartbeat(hb))
      .with({ kind: 'command' }, (c) => this.onCommand(c))
      .with({ kind: 'log' }, (l) => this.onLog(l))
      .exhaustive();
  }

  private onHeartbeat(hb: Extract<Msg, { kind: 'heartbeat' }>): void {
    console.log(`HB @ ${hb.ts}`);
  }

  private onCommand(c: Extract<Msg, { kind: 'command' }>): void {
    console.log(`command ${c.id}`);
  }

  private onLog(l: Extract<Msg, { kind: 'log' }>): void {
    console.log(`log: ${l.line}`);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('pri-dispatch');
  const props = Props.create(() => new Dispatcher())
    .withMailbox(() => new PriorityMailbox<Msg>({ priorityFor }) as never);
  const ref = system.spawnAnonymous(props);

  // Fire a burst: a bunch of logs, a heartbeat, a command, a few more logs.
  for (let i = 0; i < 6; i++) ref.tell({ kind: 'log', line: `bulk-${i}` });
  ref.tell({ kind: 'heartbeat', ts: Date.now() });
  ref.tell({ kind: 'command', id: 'SHUTDOWN' });
  for (let i = 6; i < 10; i++) ref.tell({ kind: 'log', line: `bulk-${i}` });

  // Wait for the actor to drain.
  await Bun.sleep(300);
  await system.terminate();
}

void main();
