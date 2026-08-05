import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import type { ActorFactory } from '../../src/Actor.js';
import { ActorRestarted, ActorStopped } from '../../src/SystemMessages.js';
import { SystemGroups } from '../../src/internal/SystemPaths.js';
import { awaitCondition } from '../util/AwaitCondition.js';

function newSystem(name = 'system-guardian'): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, systemOptions);
}

class Idle extends Actor<string> {
  override onReceive(_message: string): void {}
}

class Boom extends Actor<string> {
  override onReceive(_message: string): void { throw new Error('boom'); }
}

const idleActor = (): ActorFactory<string> => () => new Idle();

describe('ActorSystem._spawnSystemActor', () => {
  test('places the actor under /system and the given group', async () => {
    const sys = newSystem();

    const ref = sys._spawnSystemActor(idleActor(), SystemGroups.clusterSharding, 'region-cart');

    expect(ref.path.toString()).toBe(
      'actor-ts://system-guardian/system/cluster/sharding/region-cart',
    );
    await sys.terminate();
  });

  test('resolves through _resolvePath and actorSelection', async () => {
    const sys = newSystem();
    const ref = sys._spawnSystemActor(idleActor(), SystemGroups.clusterPubSub, 'mediator');

    const walked = sys._resolvePath(['system', 'cluster', 'pubsub', 'mediator']);
    const selected = await sys
      .actorSelection('/system/cluster/pubsub/mediator')
      .resolveOne(500);

    expect(walked.isSome()).toBe(true);
    expect(walked.getOrElse(null as never)?.path.toString()).toBe(ref.path.toString());
    expect(selected.path.toString()).toBe(ref.path.toString());
    await sys.terminate();
  });

  test('creates each group level once and shares it across callers', async () => {
    const sys = newSystem();

    sys._spawnSystemActor(idleActor(), SystemGroups.clusterSharding, 'region-cart');
    sys._spawnSystemActor(idleActor(), SystemGroups.clusterSharding, 'coordinator-cart');
    sys._spawnSystemActor(idleActor(), SystemGroups.clusterSingleton, 'manager-cron');

    const paths = sys._inspectTree().map((cell) => cell.path);
    const shardingGroups = paths.filter((p) => p.endsWith('/system/cluster/sharding'));
    const clusterGroups = paths.filter((p) => p.endsWith('/system/cluster'));

    // The shared `cluster` level is created once even though two different
    // nested groups reached for it.
    expect(shardingGroups).toHaveLength(1);
    expect(clusterGroups).toHaveLength(1);
    expect(paths).toContain('actor-ts://system-guardian/system/cluster/sharding/region-cart');
    expect(paths).toContain('actor-ts://system-guardian/system/cluster/sharding/coordinator-cart');
    expect(paths).toContain('actor-ts://system-guardian/system/cluster/singleton/manager-cron');
    await sys.terminate();
  });

  test('creates no group until something spawns into one', async () => {
    const sys = newSystem();

    // Root + /user + /system and nothing else — a system that never starts
    // DevTools or clustering must not pay for a group tree.
    expect(sys._inspectTree()).toHaveLength(3);
    await sys.terminate();
  });

  test('refuses to spawn on a terminated system', async () => {
    const sys = newSystem();
    await sys.terminate();

    expect(() => sys._spawnSystemActor(idleActor(), SystemGroups.delivery, 'consumer-1'))
      .toThrow(/terminated ActorSystem/);
  });
});

describe('system group policy', () => {
  test('marks the DevTools subtree as tooling, and other groups not', async () => {
    const sys = newSystem();

    sys._spawnSystemActor(idleActor(), SystemGroups.devtools, 'hub');
    sys._spawnSystemActor(idleActor(), SystemGroups.clusterPubSub, 'mediator');

    const byName = (name: string): boolean | undefined =>
      sys._inspectTree().find((cell) => cell.name === name)?.internal;

    // Set on the group, inherited by its children — which is what keeps a
    // debugger from tracing itself.
    expect(byName('devtools')).toBe(true);
    expect(byName('hub')).toBe(true);
    expect(byName('pubsub')).toBe(false);
    expect(byName('mediator')).toBe(false);
    await sys.terminate();
  });

  test('restarts a failing child of an infrastructure group', async () => {
    const sys = newSystem();
    const seen: string[] = [];
    const collector = sys.spawn(
      () => new (class extends Actor<ActorRestarted | ActorStopped> {
        override onReceive(event: ActorRestarted | ActorStopped): void {
          seen.push(`${event.constructor.name}:${event.actor.path.name}`);
        }
      })(),
      'collector',
    );
    sys.eventStream.subscribe(collector, ActorRestarted);
    sys.eventStream.subscribe(collector, ActorStopped);

    const ref = sys._spawnSystemActor(
      () => new Boom(),
      SystemGroups.clusterSharding,
      'region-flaky',
    );
    ref.tell('fail');

    await awaitCondition(() => seen.includes('ActorRestarted:region-flaky'), {
      label: 'the sharding group restarted its failing child',
    });
    await sys.terminate();
  });

  test('stops a failing child of the DevTools group', async () => {
    const sys = newSystem();
    const seen: string[] = [];
    const collector = sys.spawn(
      () => new (class extends Actor<ActorRestarted | ActorStopped> {
        override onReceive(event: ActorRestarted | ActorStopped): void {
          seen.push(`${event.constructor.name}:${event.actor.path.name}`);
        }
      })(),
      'collector',
    );
    sys.eventStream.subscribe(collector, ActorRestarted);
    sys.eventStream.subscribe(collector, ActorStopped);

    const ref = sys._spawnSystemActor(
      () => new Boom(),
      SystemGroups.devtools,
      'probe-flaky',
    );
    ref.tell('fail');

    await awaitCondition(() => seen.includes('ActorStopped:probe-flaky'), {
      label: 'the DevTools group stopped its failing child',
    });
    // Exactly one outcome follows a failure, so the stop proves no restart.
    expect(seen).not.toContain('ActorRestarted:probe-flaky');
    await sys.terminate();
  });
});
