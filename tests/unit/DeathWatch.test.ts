import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorRef } from '../../src/ActorRef.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { ActorStopped, Terminated } from '../../src/SystemMessages.js';
import { awaitCondition } from '../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const newSystem = (name = 'watch-unit'): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

describe('watch / unwatch', () => {
  test('watch delivers Terminated when the target stops', async () => {
    const seen: string[] = [];
    class Watched extends Actor<'die'> {
      override onReceive(_: 'die'): void { this.self.stop(); }
    }
    class Watcher extends Actor<'go' | Terminated> {
      private watcher?: ActorRef<'die'>;
      override onReceive(m: 'go' | Terminated): void {
        if (m === 'go') {
          this.watcher = this.context.spawn(Watched, 'wd') as ActorRef<'die'>;
          this.context.watch(this.watcher);
          this.watcher.tell('die');
        } else if (m instanceof Terminated) {
          seen.push(m.actor.path.name);
        }
      }
    }
    const sys = newSystem();
    const watched = sys.spawn(Watcher, 'p');
    watched.tell('go');
    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the watcher received Terminated for its child',
    });
    expect(seen).toEqual(['wd']);
    await sys.terminate();
  });

  test('unwatch stops further Terminated delivery for that target', async () => {
    let terminatedReceived = 0;
    const targetStopped = { value: false };
    class Watched extends Actor<'die'> {
      override onReceive(_: 'die'): void { this.self.stop(); }
      override postStop(): void { targetStopped.value = true; }
    }
    class Watcher extends Actor<'go' | 'unwatch' | 'kill' | Terminated> {
      private watcher?: ActorRef<'die'>;
      override onReceive(m: 'go' | 'unwatch' | 'kill' | Terminated): void {
        if (m === 'go') {
          this.watcher = this.context.spawn(Watched, 'wd') as ActorRef<'die'>;
          this.context.watch(this.watcher);
        } else if (m === 'unwatch') {
          this.context.unwatch(this.watcher!);
        } else if (m === 'kill') {
          this.watcher!.tell('die');
        } else if (m instanceof Terminated) {
          terminatedReceived++;
        }
      }
    }
    const sys = newSystem();
    const watched = sys.spawn(Watcher, 'p');
    watched.tell('go');
    watched.tell('unwatch');
    watched.tell('kill');
    // The assertion is that something does *not* arrive, so the wait has to be
    // anchored to the event that would have produced it: the target actually
    // stopping.  The old fixed 50 ms could expire before `kill` was even
    // handled, in which case the test passed without exercising anything.  The
    // short settle afterwards is the legitimate "and still nothing" window.
    await awaitCondition(() => targetStopped.value, {
      timeoutMs: 4_000,
      label: 'the unwatched target stopped',
    });
    await sleep(20);
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

    // "Already terminated" is the whole premise: if the target were still
    // running when the watcher watches it, `Terminated` would arrive by the
    // ordinary path and the test would pass without covering the late-watch
    // branch at all.  `ActorStopped` is published after the cell flips to
    // `terminated`, so it is the exact signal — a fixed sleep was a guess at it.
    const stopped: ActorStopped[] = [];
    const subscribed = { value: false };
    class StopWatcher extends Actor<ActorStopped> {
      override preStart(): void {
        this.system.eventStream.subscribe(this.self, ActorStopped);
        subscribed.value = true;
      }
      override onReceive(event: ActorStopped): void { stopped.push(event); }
    }

    const sys = newSystem();
    sys.spawn(StopWatcher, 'stops');
    await awaitCondition(() => subscribed.value, {
      timeoutMs: 4_000,
      label: 'the lifecycle listener subscribed',
    });

    // Create target, immediately stop it, wait until terminated.
    const target = sys.spawn(Target, 'dead');
    target.stop();
    await awaitCondition(() => stopped.some((event) => event.actor.equals(target)), {
      timeoutMs: 4_000,
      label: 'the target reached the terminated state',
    });

    // Now spin up a watcher that receives the (terminated) ref.
    const watcher = sys.spawn(LateWatcher, 'w');
    watcher.tell(target);
    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'watching an already-terminated ref delivered Terminated',
    });
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
        const child = this.context.spawn(X, 'x');
        const watched = this.context.watch(child);
        this.returnedSame = watched === child;
      }
    }
    const sys = newSystem();
    const instance = new Watcher();
    const ref = sys.spawn(() => instance, 'w');
    ref.tell('go');
    await awaitCondition(() => instance.returnedSame !== undefined, {
      timeoutMs: 4_000,
      label: 'the watcher handled `go`',
    });
    expect(instance.returnedSame).toBe(true);
    await sys.terminate();
  });
});
