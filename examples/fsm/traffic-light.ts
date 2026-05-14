/**
 * Hello FSM: a traffic light cycles through its three states on a timer.
 * Demonstrates `when`, `onEnter`, and `onTransition`.
 *
 *   bun run examples/fsm/traffic-light.ts
 */
import { ActorSystem, FSM, Props } from '../../src/index.js';

type Color = 'red' | 'green' | 'yellow';
interface Data { readonly enteredAt: number; }
type Cmd = 'tick';

class TrafficLight extends FSM<Color, Data, Cmd> {
  constructor() {
    super('red', { enteredAt: Date.now() });

    this.when('red', (_d, _m) => this.goto('green', { enteredAt: Date.now() }));
    this.when('green', (_d, _m) => this.goto('yellow', { enteredAt: Date.now() }));
    this.when('yellow', (_d, _m) => this.goto('red', { enteredAt: Date.now() }));

    this.onEnter('red', () => console.log('🔴  red'));
    this.onEnter('green', () => console.log('🟢  green'));
    this.onEnter('yellow', () => console.log('🟡  yellow'));
    this.onTransition((from, to) => console.log(`  (${from} → ${to})`));
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('fsm-hello');
  const ref = system.spawn(Props.create(() => new TrafficLight()), 'light');

  for (let i = 0; i < 6; i++) {
    ref.tell('tick');
    await Bun.sleep(80);
  }

  await system.terminate();
}

void main();
