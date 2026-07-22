/**
 * Death watch: a supervisor is notified via Terminated when a child dies.
 *
 *   tsx examples/death-watch.ts
 */
import { Actor, ActorSystem, Props, Terminated } from '../src/index.js';

class Child extends Actor<'work' | 'die'> {
  override onReceive(message: 'work' | 'die'): void {
    if (message === 'die') {
      console.log('[child] committing sudoku');
      this.self.stop();
    } else {
      console.log('[child] working…');
    }
  }
}

class Watcher extends Actor<'start' | 'kill' | Terminated> {
  private child?: import('../src/index.js').ActorRef<'work' | 'die'>;

  override onReceive(message: 'start' | 'kill' | Terminated): void {
    if (message === 'start') {
      this.child = this.context.spawn(Props.create(() => new Child()), 'kid');
      this.context.watch(this.child);
      this.child.tell('work');
      return;
    }
    if (message === 'kill') {
      this.child?.tell('die');
      return;
    }
    if (message instanceof Terminated) {
      console.log(`[watcher] received Terminated(${message.actor.path.toString()})`);
      this.self.stop();
    }
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('death-watch');
  const watcher = system.spawn(Props.create(() => new Watcher()), 'watcher');
  watcher.tell('start');
  await new Promise(resolve => setTimeout(resolve, 40));
  watcher.tell('kill');
  await new Promise(resolve => setTimeout(resolve, 80));
  await system.terminate();
}

void main();
