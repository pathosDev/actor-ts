import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { isActorClass, runWorkerMeshNode } from '../../../src/worker/WorkerMeshBootstrap.js';
import type { WorkerNodeContext } from '../../../src/worker/WorkerNode.js';

/**
 * The two guards in the mesh bootstrap (#1562) that the in-process mesh
 * suite never trips: a worker spawned by something other than `WorkerMesh`,
 * and an export that is an actor class by shape but not by inheritance.
 */
describe('runWorkerMeshNode', () => {
  test('refuses an init frame that is not a worker-mesh init, before building anything', async () => {
    const address = new NodeAddress('rm', 'h', 1);
    const context = {
      self: address,
      systemName: 'rm',
      transport: new InMemoryTransport(address),
      initData: { hello: 'world' },
      ready: () => {},
    } as unknown as WorkerNodeContext<never>;
    await expect(runWorkerMeshNode(context)).rejects.toThrow(/not a worker-mesh init/);
  });
});

describe('isActorClass', () => {
  class Plain extends Actor<never> { override onReceive(): void {} }

  test('accepts a class that extends Actor, by inheritance', () => {
    expect(isActorClass(Plain)).toBe(true);
  });

  test('accepts a class with an onReceive on its prototype chain — a second copy of Actor from another bundle', () => {
    class LooksLikeAnActorBase { onReceive(): void {} }
    class FromAnotherBundle extends LooksLikeAnActorBase {}
    expect(isActorClass(FromAnotherBundle)).toBe(true);
  });

  test('rejects values that are not constructible actors', () => {
    expect(isActorClass(42)).toBe(false);
    expect(isActorClass({ onReceive() {} })).toBe(false);
    expect(isActorClass(() => {})).toBe(false);
    class NoReceive {}
    expect(isActorClass(NoReceive)).toBe(false);
  });
});
