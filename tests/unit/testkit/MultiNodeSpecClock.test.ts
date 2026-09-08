import { describe, expect, test } from 'bun:test';
import { MultiNodeSpec } from '../../../src/testkit/MultiNodeSpec.js';
import { MultiNodeSpecOptions } from '../../../src/testkit/MultiNodeSpecOptions.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';

/**
 * #1424 — a whole multi-node spec can run on one virtual clock.
 *
 * A cluster's interesting questions are all about convergence, and convergence
 * takes gossip rounds — so every multi-node assertion here is a race between
 * "has it converged yet" and a real-time budget.  That is the shape the flake
 * catalogue is mostly made of, and it is why the budgets are generous and the
 * suites slow.
 *
 * Sharing one scheduler across every node is what makes an advance mean "one
 * round happened everywhere", rather than "one node's timer fired".  It is also
 * what made the ownership rule in `ActorSystem` necessary: four systems on one
 * scheduler, and the first to terminate used to disarm it for the other three.
 */

const specWith = (scheduler?: ManualScheduler): MultiNodeSpec => {
  const options = MultiNodeSpecOptions.create()
    .withRoles(['a', 'b'])
    .withGossipIntervalMs(100);
  if (scheduler !== undefined) options.withScheduler(scheduler);
  return new MultiNodeSpec(options);
};

describe('MultiNodeSpec on a shared virtual clock', () => {
  test('every node reads the same virtual instant', async () => {
    const scheduler = new ManualScheduler();
    const spec = specWith(scheduler);
    try {
      await spec.start();
      await spec.advance(5_000);

      const readings = ['a', 'b'].map((role) => spec.systemFor(role).clock.now());
      expect(readings).toEqual([5_000, 5_000]);
    } finally {
      await spec.stop();
    }
  }, 30_000);

  test('advanceUntil stops as soon as the condition holds', async () => {
    const scheduler = new ManualScheduler();
    const spec = specWith(scheduler);
    try {
      await spec.start();
      await spec.advanceUntil(() => scheduler.now() >= 300, {
        budgetMs: 10_000,
        description: 'three gossip intervals of virtual time',
      });
      // Stopped at the first step that satisfied it, not at the budget.
      expect(scheduler.now()).toBe(300);
    } finally {
      await spec.stop();
    }
  }, 30_000);

  test('advanceUntil costs no virtual time when the condition already holds', async () => {
    const scheduler = new ManualScheduler();
    const spec = specWith(scheduler);
    try {
      await spec.start();
      const before = scheduler.now();
      await spec.advanceUntil(() => true, { description: 'a condition that already holds' });
      expect(scheduler.now()).toBe(before);
    } finally {
      await spec.stop();
    }
  }, 30_000);

  test('advanceUntil reports the budget it spent rather than hanging', async () => {
    const scheduler = new ManualScheduler();
    const spec = specWith(scheduler);
    try {
      await spec.start();
      await expect(
        spec.advanceUntil(() => false, { budgetMs: 500, description: 'something impossible' }),
      ).rejects.toThrow(/something impossible did not hold within 500 ms of virtual time/);
    } finally {
      await spec.stop();
    }
  }, 30_000);

  test('a spec with no virtual clock refuses to advance rather than doing nothing', async () => {
    // Silently succeeding would make every assertion after it a race.
    const spec = specWith();
    try {
      await spec.start();
      await expect(spec.advance(1_000)).rejects.toThrow(/no virtual clock to advance/);
    } finally {
      await spec.stop();
    }
  }, 30_000);

  test('stopping the first node leaves the clock working for the rest', async () => {
    // The ownership rule, exercised through the thing that needed it.
    const scheduler = new ManualScheduler();
    const spec = specWith(scheduler);
    try {
      await spec.start();
      await spec.systemFor('a').terminate();

      let fired = false;
      scheduler.scheduleOnceFunction(1_000, () => { fired = true; });
      scheduler.advance(1_000);

      expect(fired).toBe(true);
      expect(spec.systemFor('b').clock.now()).toBe(1_000);
    } finally {
      await spec.stop();
    }
  }, 30_000);
});
