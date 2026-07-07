import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorRef } from '../../src/ActorRef.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';
import { Terminated } from '../../src/SystemMessages.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const newSystem = (name = 'watch-unit'): ActorSystem =>
  ActorSystem.create(name, ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));

describe('watch / unwatch', () => {
  test('watch delivers Terminated when the target stops', async () => {
    const seen: string[] = [];
    class Watched extends Actor<'die'> {
      override onReceive(_: 'die'): void { this.self.stop(); }
    }
    class Watcher extends Actor<'go' | Terminated> {
      private w?: ActorRef<'die'>;
      override onReceive(m: 'go' | Terminated): void {
        if (m === 'go') {
          this.w = this.context.spawn(Props.create(() => new Watched()), 'wd') as ActorRef<'die'>;
          this.context.watch(this.w);
          this.w.tell('die');
        } else if (m instanceof Terminated) {
          seen.push(m.actor.path.name);
        }
      }
    }
    const sys = newSystem();
    const p = sys.spawn(Props.create(() => new Watcher()), 'p');
    p.tell('go');
    await sleep(50);
    expect(seen).toEqual(['wd']);
    await sys.terminate();
  });

  test('unwatch stops further Terminated delivery for that target', async () => {
    let terminatedReceived = 0;
    class Watched extends Actor<'die'> {
      override onReceive(_: 'die'): void { this.self.stop(); }
    }
    class Watcher extends Actor<'go' | 'unwatch' | 'kill' | Terminated> {
      private w?: ActorRef<'die'>;
      override onReceive(m: 'go' | 'unwatch' | 'kill' | Terminated): void {
        if (m === 'go') {
          this.w = this.context.spawn(Props.create(() => new Watched()), 'wd') as ActorRef<'die'>;
          this.context.watch(this.w);
        } else if (m === 'unwatch') {
          this.context.unwatch(this.w!);
        } else if (m === 'kill') {
          this.w!.tell('die');
        } else if (m instanceof Terminated) {
          terminatedReceived++;
        }
      }
    }
    const sys = newSystem();
    const p = sys.spawn(Props.create(() => new Watcher()), 'p');
    p.tell('go');
    p.tell('unwatch');
    p.tell('kill');
    await sleep(50);
    expect(terminatedReceived).toBe(0);
    await sys.terminate();
  });

  test('watching an already-terminated ref delivers Terminated immediately', async () => {
    const seen: string[] = [];
    class LateWatcher extends Actor<ActorRef | Terminated> {
      override onReceive(m: ActorRef | Terminated): void {
        if (m instanceof Terminated) seen.push(m.actor.path.name);
        else this.context.watch(m);
      }
    }
    class Target extends Actor<'nope'> { override onReceive(_: 'nope'): void {} }

    const sys = newSystem();
    // Create target, immediately stop it, wait until terminated.
    const target = sys.spawn(Props.create(() => new Target()), 'dead');
    target.stop();
    await sleep(30);

    // Now spin up a watcher that receives the (terminated) ref.
    const w = sys.spawn(Props.create(() => new LateWatcher()), 'w');
    w.tell(target);
    await sleep(50);
    expect(seen).toEqual(['dead']);
    await sys.terminate();
  });

  test('watch returns the same ref for chaining', async () => {
    class X extends Actor<string> {
      override onReceive(_: string): void {}
    }
    class Watcher extends Actor<'go'> {
      returnedSame?: boolean;
      override onReceive(_: 'go'): void {
        const child = this.context.spawn(Props.create(() => new X()), 'x');
        const watched = this.context.watch(child);
        this.returnedSame = watched === child;
      }
    }
    const sys = newSystem();
    const instance = new Watcher();
    const ref = sys.spawn(Props.create(() => instance), 'w');
    ref.tell('go');
    await sleep(30);
    expect(instance.returnedSame).toBe(true);
    await sys.terminate();
  });
});
