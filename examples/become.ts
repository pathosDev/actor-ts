/**
 * A finite-state machine via become/unbecome: a lamp that cycles through
 * Off -> On -> Bright -> Off.
 *
 *   tsx examples/become.ts
 */
import { Actor, ActorSystem, Props } from '../src/index.js';

class LampActor extends Actor<'toggle'> {
  override preStart(): void {
    // Initial behaviour is "off".
    this.context.become(this.off);
  }

  override onReceive(_msg: 'toggle'): void {
    // Never hit, because preStart installed a new behaviour.
  }

  private off = (_: 'toggle'): void => {
    console.log('lamp: off -> on');
    this.context.become(this.on);
  };

  private on = (_: 'toggle'): void => {
    console.log('lamp: on -> bright');
    this.context.become(this.bright);
  };

  private bright = (_: 'toggle'): void => {
    console.log('lamp: bright -> off');
    this.context.become(this.off);
  };
}

async function main(): Promise<void> {
  const system = ActorSystem.create('become-demo');
  const lamp = system.spawn(Props.create(() => new LampActor()), 'lamp');

  for (let i = 0; i < 6; i++) lamp.tell('toggle');

  await new Promise(resolve => setTimeout(resolve, 80));
  await system.terminate();
}

void main();
