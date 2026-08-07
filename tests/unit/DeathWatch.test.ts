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

/* --------------------------- watchWith (#159) ---------------------------- */

/** Stops itself on request — the death every test below observes. */
class Worker extends Actor<'die'> {
  override onReceive(_: 'die'): void { this.self.stop(); }
}

type StartCommand = { readonly kind: 'start' };
type WorkerLostMessage = { readonly kind: 'workerLost'; readonly name: string };
type SupervisorMessage = StartCommand | WorkerLostMessage | Terminated;

describe('watchWith', () => {
  test('delivers the custom message instead of Terminated', async () => {
    const seen: string[] = [];
    class Supervisor extends Actor<SupervisorMessage> {
      override onReceive(message: SupervisorMessage): void {
        if (message instanceof Terminated) { seen.push(`terminated:${message.actor.path.name}`); return; }
        if (message.kind === 'start') {
          const worker = this.context.spawn(Worker, 'alice') as ActorRef<'die'>;
          this.context.watchWith(worker, { kind: 'workerLost', name: worker.path.name });
          worker.tell('die');
          return;
        }
        seen.push(`workerLost:${message.name}`);
      }
    }

    const sys = newSystem('watch-with');
    sys.spawn(Supervisor, 'supervisor').tell({ kind: 'start' });
    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the supervisor was told about the death',
    });
    // The point of the feature: `Terminated` never reaches the protocol.
    expect(seen).toEqual(['workerLost:alice']);
    await sys.terminate();
  });

  test('two watchWith registrations name their own subjects', async () => {
    const seen: string[] = [];
    class Supervisor extends Actor<SupervisorMessage> {
      override onReceive(message: SupervisorMessage): void {
        if (message instanceof Terminated) { seen.push('terminated'); return; }
        if (message.kind === 'start') {
          const alice = this.context.spawn(Worker, 'alice') as ActorRef<'die'>;
          const bob = this.context.spawn(Worker, 'bob') as ActorRef<'die'>;
          this.context.watchWith(alice, { kind: 'workerLost', name: 'alice' });
          this.context.watchWith(bob, { kind: 'workerLost', name: 'bob' });
          bob.tell('die');
          alice.tell('die');
          return;
        }
        seen.push(message.name);
      }
    }

    const sys = newSystem('watch-with-many');
    sys.spawn(Supervisor, 'supervisor').tell({ kind: 'start' });
    await awaitCondition(() => seen.length === 2, {
      timeoutMs: 4_000,
      label: 'both deaths were reported',
    });
    // Two deaths, two different domain messages — no ref comparison anywhere
    // in the handler.  Arrival order between two independent cells is not
    // determined, so compare as a set.
    expect(seen.slice().sort()).toEqual(['alice', 'bob']);
    await sys.terminate();
  });

  test('watchWith after watch replaces the Terminated (last call wins)', async () => {
    const seen: string[] = [];
    class Supervisor extends Actor<SupervisorMessage> {
      override onReceive(message: SupervisorMessage): void {
        if (message instanceof Terminated) { seen.push('terminated'); return; }
        if (message.kind === 'start') {
          const worker = this.context.spawn(Worker, 'alice') as ActorRef<'die'>;
          this.context.watch(worker);
          this.context.watchWith(worker, { kind: 'workerLost', name: 'alice' });
          worker.tell('die');
          return;
        }
        seen.push(`workerLost:${message.name}`);
      }
    }

    const sys = newSystem('watch-with-upgrade');
    sys.spawn(Supervisor, 'supervisor').tell({ kind: 'start' });
    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the supervisor was told about the death',
    });
    expect(seen).toEqual(['workerLost:alice']);
    await sys.terminate();
  });

  test('a plain watch after watchWith goes back to Terminated', async () => {
    // The direction that is easy to get wrong: `watch` sees the ref is already
    // being watched and could return early, leaving the custom message in
    // place and quietly ignoring the caller's downgrade.
    const seen: string[] = [];
    class Supervisor extends Actor<SupervisorMessage> {
      override onReceive(message: SupervisorMessage): void {
        if (message instanceof Terminated) { seen.push(`terminated:${message.actor.path.name}`); return; }
        if (message.kind === 'start') {
          const worker = this.context.spawn(Worker, 'alice') as ActorRef<'die'>;
          this.context.watchWith(worker, { kind: 'workerLost', name: 'alice' });
          this.context.watch(worker);
          worker.tell('die');
          return;
        }
        seen.push(`workerLost:${message.name}`);
      }
    }

    const sys = newSystem('watch-with-downgrade');
    sys.spawn(Supervisor, 'supervisor').tell({ kind: 'start' });
    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the supervisor was told about the death',
    });
    expect(seen).toEqual(['terminated:alice']);
    await sys.terminate();
  });

  test('unwatch drops a watchWith registration', async () => {
    const seen: string[] = [];
    const workerStopped = { value: false };
    class ObservedWorker extends Actor<'die'> {
      override onReceive(_: 'die'): void { this.self.stop(); }
      override postStop(): void { workerStopped.value = true; }
    }
    class Supervisor extends Actor<SupervisorMessage> {
      override onReceive(message: SupervisorMessage): void {
        if (message instanceof Terminated) { seen.push('terminated'); return; }
        if (message.kind === 'start') {
          const worker = this.context.spawn(ObservedWorker, 'alice') as ActorRef<'die'>;
          this.context.watchWith(worker, { kind: 'workerLost', name: 'alice' });
          this.context.unwatch(worker);
          worker.tell('die');
          return;
        }
        seen.push(`workerLost:${message.name}`);
      }
    }

    const sys = newSystem('watch-with-unwatch');
    sys.spawn(Supervisor, 'supervisor').tell({ kind: 'start' });
    // Asserting that nothing arrives means anchoring on the event that would
    // have produced it, then allowing a short settle window.
    await awaitCondition(() => workerStopped.value, {
      timeoutMs: 4_000,
      label: 'the unwatched worker stopped',
    });
    await sleep(20);
    expect(seen).toEqual([]);
    await sys.terminate();
  });

  test('watchWith on an already-terminated ref delivers the custom message immediately', async () => {
    // `_addWatcher` answers a dead target on the spot rather than through the
    // notification path, so it is a second entry point into delivery — and the
    // one that would still hand out a raw `Terminated` if the substitution
    // lived on the dying cell instead of on the watcher.
    const seen: string[] = [];
    const stopped: ActorStopped[] = [];
    const subscribed = { value: false };
    class StopWatcher extends Actor<ActorStopped> {
      override preStart(): void {
        this.system.eventStream.subscribe(this.self, ActorStopped);
        subscribed.value = true;
      }
      override onReceive(event: ActorStopped): void { stopped.push(event); }
    }
    class LateSupervisor extends Actor<ActorRef | WorkerLostMessage | Terminated> {
      override onReceive(message: ActorRef | WorkerLostMessage | Terminated): void {
        if (message instanceof Terminated) { seen.push('terminated'); return; }
        if (message instanceof ActorRef) {
          this.context.watchWith(message, { kind: 'workerLost', name: message.path.name });
          return;
        }
        seen.push(`workerLost:${message.name}`);
      }
    }

    const sys = newSystem('watch-with-late');
    sys.spawn(StopWatcher, 'stops');
    await awaitCondition(() => subscribed.value, {
      timeoutMs: 4_000,
      label: 'the lifecycle listener subscribed',
    });

    const worker = sys.spawn(Worker, 'alice');
    worker.stop();
    await awaitCondition(() => stopped.some((event) => event.actor.equals(worker)), {
      timeoutMs: 4_000,
      label: 'the worker reached the terminated state',
    });

    sys.spawn(LateSupervisor, 'supervisor').tell(worker);
    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the late watcher was told about the death',
    });
    expect(seen).toEqual(['workerLost:alice']);
    await sys.terminate();
  });

  test('a re-spawned name is a fresh subject and needs its own watchWith', async () => {
    // Watch bookkeeping is keyed by incarnation, not by address, so the
    // successor of a stopped name does not inherit the predecessor's
    // registration — which is also the answer to "does the custom message fire
    // again after a restart": only if you ask again.
    const seen: string[] = [];
    type GenerationStartCommand = { readonly kind: 'start'; readonly generation: number };
    type GenerationLostMessage = { readonly kind: 'workerLost'; readonly generation: number };
    type GenerationMessage = GenerationStartCommand | GenerationLostMessage | Terminated;

    class Supervisor extends Actor<GenerationMessage> {
      override onReceive(message: GenerationMessage): void {
        if (message instanceof Terminated) { seen.push('terminated'); return; }
        if (message.kind === 'start') {
          const worker = this.context.spawn(Worker, 'alice') as ActorRef<'die'>;
          this.context.watchWith(worker, { kind: 'workerLost', generation: message.generation });
          worker.tell('die');
          return;
        }
        seen.push(`lost:${message.generation}`);
        // Same name, new incarnation — and a second registration, because the
        // first was consumed by the death that just arrived.
        if (message.generation === 1) this.self.tell({ kind: 'start', generation: 2 });
      }
    }

    const sys = newSystem('watch-with-incarnation');
    sys.spawn(Supervisor, 'supervisor').tell({ kind: 'start', generation: 1 });
    await awaitCondition(() => seen.length === 2, {
      timeoutMs: 4_000,
      label: 'both incarnations of the worker were reported',
    });
    expect(seen).toEqual(['lost:1', 'lost:2']);
    await sys.terminate();
  });
});
