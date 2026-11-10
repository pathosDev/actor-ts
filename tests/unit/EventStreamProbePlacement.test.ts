import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { subscribeToEventStream } from '../../src/devtools/internal/EventStreamProbe.js';
import { SystemGroups, systemGroupPath } from '../../src/internal/SystemPaths.js';
import { awaitCondition } from '../util/AwaitCondition.js';

class OrderPlaced {
  constructor(readonly orderId: string) {}
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
});

function newSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

/** The live cells directly under `parentPath`. */
function childrenOf(system: ActorSystem, parentPath: string) {
  return system._inspectTree().filter((cell) => cell.parentPath === parentPath);
}

// The header of `EventStreamProbe.ts` kept describing `/user` actors with a
// `devtools-` name prefix after the probes had moved under `/system/devtools`
// with bare names, and nothing noticed, because nothing ran the module
// directly.  These pin what the header says now.
describe('subscribeToEventStream', () => {
  test('spawns its probe as a tooling actor under /system/devtools, named as asked', () => {
    const system = newSystem('probe-placement');
    const probe = subscribeToEventStream(system, OrderPlaced, () => {}, 'stats');

    const [cell, ...others] = childrenOf(system, systemGroupPath(system.name, SystemGroups.devtools));
    expect(others).toEqual([]);
    expect(cell?.name).toBe('stats');
    // Inherited from the group: what the actor panel hides it by, and what
    // keeps whole-system tracing off it.
    expect(cell?.internal).toBe(true);
    // `/user` holds only what the application spawned.
    expect(childrenOf(system, `actor-ts://${system.name}/user`)).toEqual([]);
    probe.stop();
  });

  test('suffixes the name only while a sibling still holds it', () => {
    const system = newSystem('probe-names');
    const first = subscribeToEventStream(system, OrderPlaced, () => {}, 'stats');
    const second = subscribeToEventStream(system, OrderPlaced, () => {}, 'stats');

    const names = childrenOf(system, systemGroupPath(system.name, SystemGroups.devtools))
      .map((cell) => cell.name)
      .sort();
    expect(names).toEqual(['stats', 'stats-2']);
    first.stop();
    second.stop();
  });

  test('hands the channel to its handler, and leaves the group when stopped', async () => {
    const system = newSystem('probe-delivery');
    const seen: string[] = [];
    const probe = subscribeToEventStream(
      system,
      OrderPlaced,
      (event) => { seen.push(event.orderId); },
      'orders',
    );

    system.eventStream.publish(new OrderPlaced('first'));
    await awaitCondition(() => seen.includes('first'), {
      timeoutMs: 2_000,
      label: 'the probe handed the event to its handler',
    });

    probe.stop();
    const groupPath = systemGroupPath(system.name, SystemGroups.devtools);
    await awaitCondition(() => childrenOf(system, groupPath).length === 0, {
      timeoutMs: 2_000,
      label: 'the stopped probe left /system/devtools',
    });
  });
});
