import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { ActorOptions } from '../../src/ActorOptions.js';
import { actorBlueprintOf } from '../../src/internal/ActorBlueprint.js';
import type { ActorRef } from '../../src/ActorRef.js';
import type { EntityContext } from '../../src/EntityContext.js';
import type { Option } from '../../src/util/Option.js';

const IDENTITY: EntityContext = { entityId: 'cart:42', typeName: 'cart', shardId: 7 };

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs = 2_000, stepMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(stepMs);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/**
 * Reports its own sharding identity back to the test.  `entityId`/`entity`
 * are `protected` — deliberately, they are for the actor itself — so a probe
 * has to widen them to be assertable from outside.
 */
class ProbeActor extends Actor<string> {
  started = false;
  /** What `preStart` saw, proving the identity is attached before message one. */
  seenInPreStart: string | null = null;
  child: ProbeActor | null = null;

  override preStart(): void {
    this.seenInPreStart = this.context.entity.toNullable() === null ? null : this.entityId;
    this.started = true;
  }

  override onReceive(message: string): void {
    if (message === 'fail') throw new Error('boom');
    if (message === 'spawn-child') this.spawnChild();
  }

  readEntityId(): string { return this.entityId; }

  readEntity(): EntityContext { return this.entity; }

  readEntityOption(): Option<EntityContext> { return this.context.entity; }

  private spawnChild(): void {
    const child = new ProbeActor();
    this.child = child;
    this.context.spawn(() => child, 'helper');
  }
}

type Harness = {
  system: ActorSystem;
  reference: ActorRef<string>;
  instances: ProbeActor[];
};

/** Spawns a probe — with an identity or without — and captures every
 *  instance the factory makes, so a restart is observable. */
async function spawnProbe(name: string, entity: EntityContext | null): Promise<Harness> {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  const instances: ProbeActor[] = [];
  const base = () => {
    const probe = new ProbeActor();
    instances.push(probe);
    return probe;
  };
  const reference = system.spawn(base, 'probe', entity === null ? undefined : { entity });
  await waitFor(() => instances.length > 0 && instances[0]!.started);
  return { system, reference, instances };
}

describe('ActorOptions.withEntity', () => {
  test('carries the identity into the blueprint without touching the factory', () => {
    const base = (): ProbeActor => new ProbeActor();
    const blueprint = actorBlueprintOf(base, ActorOptions.create().withEntity(IDENTITY));
    expect(blueprint.entity).toEqual(IDENTITY);
    expect(blueprint.factory).toBe(base);
  });

  test('the plain-object form is interchangeable with the builder', () => {
    const base = (): ProbeActor => new ProbeActor();
    expect(actorBlueprintOf(base, { entity: IDENTITY }).entity)
      .toEqual(actorBlueprintOf(base, ActorOptions.create().withEntity(IDENTITY)).entity);
  });

  test('an actor spawned without options has no identity at all', () => {
    expect(actorBlueprintOf((): ProbeActor => new ProbeActor()).entity).toBeUndefined();
  });
});

describe('sharding identity on the actor', () => {
  test('an actor spawned with an identity reads it back verbatim', async () => {
    const harness = await spawnProbe('entity-read', IDENTITY);
    const probe = harness.instances[0]!;

    expect(probe.readEntityId()).toBe('cart:42');
    expect(probe.readEntity()).toEqual(IDENTITY);
    expect(probe.readEntityOption().toNullable()).toEqual(IDENTITY);

    await harness.system.terminate();
  });

  test('the identity is attached before preStart runs', async () => {
    const harness = await spawnProbe('entity-prestart', IDENTITY);

    expect(harness.instances[0]!.seenInPreStart).toBe('cart:42');

    await harness.system.terminate();
  });

  test('a restart hands the fresh instance the same identity', async () => {
    const harness = await spawnProbe('entity-restart', IDENTITY);

    harness.reference.tell('fail');
    await waitFor(() => harness.instances.length === 2);

    const restarted = harness.instances[1]!;
    expect(restarted).not.toBe(harness.instances[0]);
    expect(restarted.seenInPreStart).toBe('cart:42');
    expect(restarted.readEntityId()).toBe('cart:42');

    await harness.system.terminate();
  });

  test('a plain actor has no identity, and asking for one says why', async () => {
    const harness = await spawnProbe('entity-absent', null);
    const probe = harness.instances[0]!;

    expect(probe.readEntityOption().isEmpty).toBe(true);
    expect(probe.seenInPreStart).toBeNull();
    expect(() => probe.readEntityId()).toThrow(/is not a sharded entity/);
    expect(() => probe.readEntityId()).toThrow(/ProbeActor/);

    await harness.system.terminate();
  });

  test('an entity does not pass its identity down to its children', async () => {
    const harness = await spawnProbe('entity-child', IDENTITY);
    const parent = harness.instances[0]!;

    harness.reference.tell('spawn-child');
    await waitFor(() => parent.child !== null && parent.child.started);

    expect(parent.child!.readEntityOption().isEmpty).toBe(true);
    expect(() => parent.child!.readEntityId()).toThrow(/is not a sharded entity/);

    await harness.system.terminate();
  });
});
