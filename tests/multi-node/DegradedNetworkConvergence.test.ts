import { describe, expect, test } from 'bun:test';
import { ManualScheduler } from '../../src/testkit/ManualScheduler.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeSpecOptions } from '../../src/testkit/MultiNodeSpecOptions.js';

/**
 * #1023 — does the cluster still converge on a network that is working badly?
 *
 * Until now the harness could ask two questions: is the network perfect, or is
 * it severed. Both are answered by `partition` and `crash`, and between them
 * lies every condition a real cluster actually runs in — a fifth of the gossip
 * pushes lost, frames overtaking each other, a peer that is slow rather than
 * dead. Every merge function in `Cluster` is written to be order-independent
 * and idempotent, and nothing exercised either property, because nothing could
 * produce an out-of-order or duplicated frame.
 *
 * These specs run on a shared `ManualScheduler`, so "given enough rounds" is a
 * number of virtual gossip intervals rather than a race against a wall-clock
 * budget. That matters more here than anywhere else in the tree: a convergence
 * assertion over a lossy link is exactly the shape that becomes a flake when it
 * is also a race, and this file would otherwise be the least reliable one in
 * the suite rather than the one that proves reliability.
 *
 * The seed is fixed, and every failure message names it. An unreproducible
 * chaos test is a flake generator; a reproducible one is a test.
 */

const ROLES = ['a', 'b', 'c'] as const;

/** Three nodes, one virtual clock, faults reproducible from `seed`. */
function specWith(scheduler: ManualScheduler, seed: number): MultiNodeSpec {
  return new MultiNodeSpec(MultiNodeSpecOptions.create()
    .withRoles([...ROLES])
    .withGossipIntervalMs(100)
    .withScheduler(scheduler)
    .withFaultSeed(seed));
}

/** Every role's own view of how many members are `up`. */
const upCounts = (spec: MultiNodeSpec): number[] =>
  ROLES.map((role) => spec.clusterFor(role).getMembers().filter((m) => m.status === 'up').length);

describe('membership converges on a degraded network', () => {
  test('a fifth of every frame lost still reaches agreement, given enough rounds', async () => {
    const scheduler = new ManualScheduler();
    const spec = specWith(scheduler, 20_231);
    try {
      await spec.start();
      // Degrade after start, which is the case an immutable profile could not
      // express: the cluster forms on a clean network and the network then
      // gets worse, rather than nodes booting into a broken one.
      for (const [left, right] of [['a', 'b'], ['b', 'c'], ['a', 'c']] as const) {
        spec.degrade(left, right, { dropProbability: 0.2 });
      }

      await spec.advanceUntil(
        () => upCounts(spec).every((count) => count === ROLES.length),
        { budgetMs: 60_000, description: 'every node sees all three members up' },
      );

      expect(upCounts(spec)).toEqual([3, 3, 3]);
    } finally {
      await spec.stop();
    }
  }, 60_000);

  test('reordering and duplication together do not corrupt the view', async () => {
    // The two properties `mergeMember` claims and nothing exercised: it is
    // idempotent, so a duplicated gossip frame changes nothing, and it is
    // order-independent, so a frame overtaking another changes nothing either.
    const scheduler = new ManualScheduler();
    const spec = specWith(scheduler, 20_232);
    try {
      await spec.start();
      for (const [left, right] of [['a', 'b'], ['b', 'c'], ['a', 'c']] as const) {
        spec.degrade(left, right, { reorderWindow: 4, duplicateProbability: 0.5 });
      }

      await spec.advanceUntil(
        () => upCounts(spec).every((count) => count === ROLES.length),
        { budgetMs: 60_000, description: 'every node sees all three members up' },
      );

      // Not just "three members" — the same three, with no member counted
      // twice by a duplicated frame and none lost to a reordered one.
      for (const role of ROLES) {
        const addresses = spec.clusterFor(role).getMembers().map((m) => m.address.toString());
        expect(new Set(addresses).size).toBe(ROLES.length);
      }
    } finally {
      await spec.stop();
    }
  }, 60_000);

  test('a link that is merely slow is not a link that is down', async () => {
    // The case a failure detector exists to tell apart, and the one no test
    // could construct: latency measured on the virtual clock, so the peer is
    // late by a known amount rather than by however loaded the machine is.
    const scheduler = new ManualScheduler();
    const spec = specWith(scheduler, 20_233);
    try {
      await spec.start();
      await spec.advanceUntil(
        () => upCounts(spec).every((count) => count === ROLES.length),
        { budgetMs: 30_000, description: 'the cluster forms on a clean network' },
      );

      spec.degrade('a', 'b', { latencyMs: 50 });
      await spec.advance(5_000);

      // 50 ms on a 100 ms gossip interval is late, not gone: nobody is
      // unreachable and the view is unchanged.
      expect(upCounts(spec)).toEqual([3, 3, 3]);
    } finally {
      await spec.stop();
    }
  }, 60_000);

  test('restore puts the link back and the view survives it', async () => {
    const scheduler = new ManualScheduler();
    const spec = specWith(scheduler, 20_234);
    try {
      await spec.start();
      spec.degrade('a', 'b', { dropProbability: 0.9, reorderWindow: 4 });
      await spec.advance(2_000);
      spec.restore('a', 'b');

      await spec.advanceUntil(
        () => upCounts(spec).every((count) => count === ROLES.length),
        { budgetMs: 60_000, description: 'the cluster converges after the link is restored' },
      );
      expect(upCounts(spec)).toEqual([3, 3, 3]);
    } finally {
      await spec.stop();
    }
  }, 60_000);
});

describe('the negative control, without which none of the above means anything', () => {
  test('total loss on every link prevents convergence', async () => {
    // Every test above asserts that the cluster converges *despite* faults,
    // and every one of them would pass just as well if `degrade` were wired to
    // nothing at all.  This is the assertion that separates the two: the same
    // spec, the same rounds, loss turned all the way up.  Measured: [1, 0, 0]
    // against [3, 3, 3] on a clean network of the same shape.
    const scheduler = new ManualScheduler();
    const spec = specWith(scheduler, 20_235);
    try {
      await spec.start();
      for (const [left, right] of [['a', 'b'], ['b', 'c'], ['a', 'c']] as const) {
        spec.degrade(left, right, { dropProbability: 1 });
      }

      await spec.advance(20_000);

      expect(upCounts(spec).every((count) => count === ROLES.length)).toBe(false);
    } finally {
      await spec.stop();
    }
  }, 60_000);
});

describe('a failure on a degraded network says how to reproduce it', () => {
  test('the timeout message names the seed and the degraded roles', async () => {
    // Without this the harness is a flake generator: a red CI run over a random
    // network tells you a number of frames were lost and not which ones.
    const scheduler = new ManualScheduler();
    const spec = specWith(scheduler, 4_242);
    try {
      await spec.start();
      spec.degrade('a', 'b', { dropProbability: 1 });

      const failure = await spec
        .advanceUntil(() => false, { budgetMs: 300, description: 'a condition that never holds' })
        .then(() => undefined, (error: Error) => error);

      expect(failure?.message).toContain('withFaultSeed(4242)');
      expect(failure?.message).toContain('Faults were injected on: a, b');
    } finally {
      await spec.stop();
    }
  }, 60_000);

  test('a clean spec says nothing about seeds, because there is no fault to reproduce', async () => {
    const scheduler = new ManualScheduler();
    const spec = specWith(scheduler, 4_242);
    try {
      await spec.start();
      const failure = await spec
        .advanceUntil(() => false, { budgetMs: 300, description: 'a condition that never holds' })
        .then(() => undefined, (error: Error) => error);

      expect(failure?.message).not.toContain('withFaultSeed');
    } finally {
      await spec.stop();
    }
  }, 60_000);
});
