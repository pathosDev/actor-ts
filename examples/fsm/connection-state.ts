/**
 * Realistic FSM: a network connection that cycles Disconnected →
 * Connecting → Connected → Reconnecting → ... with retries and back-off
 * timers driven by context.timers.
 *
 *   bun run examples/fsm/connection-state.ts
 */
import { ActorSystem } from '../../src/index.js';
import { FSM } from '../../src/fsm/index.js';

type State = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
type Data = {
  readonly retries: number;
  readonly lastConnectedAt: number | null;
};
type Command =
  | { kind: 'connect' }
  | { kind: 'connected' }
  | { kind: 'disconnect' }
  | { kind: 'failed'; reason: string }
  | { kind: 'retry' };

class ConnectionFsm extends FSM<State, Data, Command> {
  constructor() {
    super('disconnected', { retries: 0, lastConnectedAt: null });

    this.when('disconnected', (d, m) => {
      if (m.kind === 'connect') return this.goto('connecting', d);
      return this.stay(d);
    });

    this.when('connecting', (d, m) => {
      if (m.kind === 'connected') return this.goto('connected', { retries: 0, lastConnectedAt: Date.now() });
      if (m.kind === 'failed') return this.goto('reconnecting', { ...d, retries: d.retries + 1 });
      return this.stay(d);
    });

    this.when('connected', (d, m) => {
      if (m.kind === 'disconnect') return this.goto('disconnected', d);
      if (m.kind === 'failed') return this.goto('reconnecting', { ...d, retries: d.retries + 1 });
      return this.stay(d);
    });

    this.when('reconnecting', (d, m) => {
      if (m.kind === 'retry') return this.goto('connecting', d);
      return this.stay(d);
    });

    this.onEnter('connecting', () => console.log('connecting ...'));
    this.onEnter('connected', (d) => console.log(`connected (retries=${d.retries})`));
    this.onEnter('reconnecting', (d) => {
      console.log(`reconnecting (attempt ${d.retries}) — scheduling retry`);
      this.context.timers.startSingleTimer('retry', { kind: 'retry' }, Math.min(300, 50 * 2 ** d.retries));
    });
    this.onEnter('disconnected', () => console.log('disconnected'));
    this.onTransition((from, to) => console.log(`  ${from} → ${to}`));
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('fsm-conn');
  const ref = system.spawn(ConnectionFsm, 'conn');

  // The two long waits are load-bearing and the two short ones are not.
  // `onEnter('reconnecting')` arms a *retry timer* (100 ms, then 200 ms), and
  // the drain does not follow work that is not enqueued yet — so 200 and 500
  // are what let each retry fire.  The 30 and 50 only pace one mailbox, whose
  // FIFO already orders these tells; they are kept for a readable transcript,
  // not because anything depends on them.
  ref.tell({ kind: 'connect' });
  await Bun.sleep(30);
  ref.tell({ kind: 'failed', reason: 'handshake timeout' });
  await Bun.sleep(200);
  ref.tell({ kind: 'failed', reason: 'dns again' });
  await Bun.sleep(500);
  ref.tell({ kind: 'connected' });
  await Bun.sleep(50);
  ref.tell({ kind: 'disconnect' });

  // No sleep: the last transition is already queued, and terminate() drains it.
  await system.terminate();
}

void main();
