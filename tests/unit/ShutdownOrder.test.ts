/**
 * The root guardian drains `/user` before it starts on `/system`.
 *
 * This became load-bearing when the framework's own actors moved under
 * `/system`: the application talks to the framework, so a user actor's
 * `postStop` — unsubscribing from the mediator, handing a shard back — needs
 * that framework actor still alive.  Terminating both guardians at once made
 * that a race whose losing side is a silent dead letter.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';
import { SystemGroups } from '../../src/internal/SystemPaths.js';

function newSystem(name = 'shutdown-order'): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, systemOptions);
}

describe('shutdown order', () => {
  test('a user actor can still reach a /system actor from postStop', async () => {
    const system = newSystem();
    const received: string[] = [];

    class Infrastructure extends Actor<string> {
      override onReceive(message: string): void { received.push(message); }
    }
    const infrastructure = system._spawnSystemActor(
      Props.create(() => new Infrastructure()),
      SystemGroups.clusterPubSub,
      'mediator',
    );

    class Application extends Actor<string> {
      override onReceive(_message: string): void {}
      override postStop(): void { infrastructure.tell('goodbye'); }
    }
    system.spawn(Props.create(() => new Application()), 'application');

    await system.terminate();

    // Delivered, not dead-lettered: the mediator outlives its user.
    expect(received).toEqual(['goodbye']);
  });

  test('/user is fully drained before /system begins stopping', async () => {
    const system = newSystem();
    const stopped: string[] = [];

    /**
     * Records from `postStop` into a plain closure array rather than through
     * the event stream.  An `ActorStopped` subscriber has to be an actor, and
     * an actor is on one side of the boundary or the other — so it gets
     * stopped during the very phase it is meant to observe.
     */
    class Recorder extends Actor<string> {
      constructor(private readonly label: string) { super(); }
      override onReceive(_message: string): void {}
      override postStop(): void { stopped.push(this.label); }
    }

    system.spawn(Props.create(() => new Recorder('user:a')), 'a');
    system.spawn(Props.create(() => new Recorder('user:b')), 'b');
    system._spawnSystemActor(
      Props.create(() => new Recorder('system:consumer')),
      SystemGroups.delivery,
      'consumer',
    );
    system._spawnSystemActor(
      Props.create(() => new Recorder('system:mediator')),
      SystemGroups.clusterPubSub,
      'mediator',
    );

    await system.terminate();

    const firstSystem = stopped.findIndex((label) => label.startsWith('system:'));
    const lastUser = stopped.reduce(
      (last, label, index) => (label.startsWith('user:') ? index : last),
      -1,
    );

    expect(stopped).toHaveLength(4);
    // Order within a guardian is unspecified — only the boundary is asserted.
    expect(lastUser).toBeGreaterThanOrEqual(0);
    expect(firstSystem).toBeGreaterThan(lastUser);
  });

  test('terminate still resolves when no framework actor was ever spawned', async () => {
    const system = newSystem();
    class Idle extends Actor<string> {
      override onReceive(_message: string): void {}
    }
    system.spawn(Props.create(() => new Idle()), 'only-user-actor');

    await system.terminate();

    expect(system.isTerminated).toBe(true);
  });

  test('terminate is idempotent and resolves for repeat callers', async () => {
    const system = newSystem();
    const first = system.terminate();
    const second = system.terminate();
    await Promise.all([first, second]);
    await system.terminate();
    expect(system.isTerminated).toBe(true);
  });
});
