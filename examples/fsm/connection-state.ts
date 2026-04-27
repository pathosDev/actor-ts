/**
 * Realistic FSM: a network connection that cycles Disconnected →
 * Connecting → Connected → Reconnecting → ... with retries and back-off
 * timers driven by context.timers.
 *
 *   bun run examples/fsm/connection-state.ts
 */
import { ActorSystem, FSM, Props } from '../../src/index.js';

type State = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
interface Data {
  readonly retries: number;
  readonly lastConnectedAt: number | null;
}
type Cmd =
  | { kind: 'connect' }
  | { kind: 'connected' }
  | { kind: 'disconnect' }
  | { kind: 'failed'; reason: string }
  | { kind: 'retry' };

class ConnectionFsm extends FSM<State, Data, Cmd> {
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
  const ref = system.actorOf(Props.create(() => new ConnectionFsm()), 'conn');

  ref.tell({ kind: 'connect' });
  await Bun.sleep(30);
  ref.tell({ kind: 'failed', reason: 'handshake timeout' });
  await Bun.sleep(200);
  ref.tell({ kind: 'failed', reason: 'dns again' });
  await Bun.sleep(500);
  ref.tell({ kind: 'connected' });
  await Bun.sleep(50);
  ref.tell({ kind: 'disconnect' });

  await Bun.sleep(100);
  await system.terminate();
}

void main();
