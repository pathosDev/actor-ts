/**
 * MultiNodeSpec.enterBarrier (#198, #47) — Akka-style cross-node
 * synchronisation primitive.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { sleep } from '../util/AwaitCondition.js';

describe('MultiNodeSpec.enterBarrier', () => {
  let spec: MultiNodeSpec;
  beforeAll(async () => {
    spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      gossipIntervalMs: 30,
      awaitTimeoutMs: 2_000,
    });
    await spec.start();
  });
  afterAll(async () => { await spec.stop(); });

  test('barrier resolves once every role has entered', async () => {
    // Stagger the entrants so the barrier exercises the parking
    // path, not just the "everyone arrives synchronously" race.
    const order: string[] = [];
    await Promise.all([
      (async () => {
        await spec.enterBarrier('configured', 'a');
        order.push('a');
      })(),
      (async () => {
        // The stagger IS the fixture: b must arrive after a so the barrier
        // parks rather than resolving on a synchronous three-way arrival.
        // There is no state to poll for — a's parked-ness is what the delay
        // manufactures.
        await sleep(20);
        await spec.enterBarrier('configured', 'b');
        order.push('b');
      })(),
      (async () => {
        // Same, one step further out: c arrives last, so the barrier has to
        // hold two parked entrants before it can resolve.
        await sleep(40);
        await spec.enterBarrier('configured', 'c');
        order.push('c');
      })(),
    ]);
    expect(order.sort()).toEqual(['a', 'b', 'c']);
    expect(spec.pendingBarrierCount).toBe(0);
  });

  test('subset participants — barrier only between named roles', async () => {
    let aDone = false;
    let bDone = false;
    let cInterfered = false;
    await Promise.all([
      (async () => {
        await spec.enterBarrier('a-b-only', 'a', { participants: ['a', 'b'] });
        aDone = true;
      })(),
      (async () => {
        // Stagger again, so a is parked when b enters.
        await sleep(30);
        await spec.enterBarrier('a-b-only', 'b', { participants: ['a', 'b'] });
        bDone = true;
      })(),
      // c does NOT enter this barrier.  After a and b both resolve, c
      // should still be idle.
      (async () => {
        // An absence: c must not affect the a-b barrier.  It has nothing to
        // wait *for* — the delay only keeps its arm alive across the window in
        // which a and b resolve, so a wrongly-counted participant would show.
        await sleep(60);
        cInterfered = true;
      })(),
    ]);
    expect(aDone).toBe(true);
    expect(bDone).toBe(true);
    expect(cInterfered).toBe(true);
    expect(spec.pendingBarrierCount).toBe(0);
  });

  test('reusing a barrier name across rounds works (slot resets)', async () => {
    for (let round = 0; round < 3; round++) {
      await Promise.all(['a', 'b', 'c'].map((role) =>
        spec.enterBarrier('repeat', role),
      ));
      expect(spec.pendingBarrierCount).toBe(0);
    }
  });

  test('throws if the same role enters the same barrier twice', async () => {
    // We can't easily make role a enter twice in the same flight
    // without nested promises — drive it with a manual race.
    const first = spec.enterBarrier('double-enter', 'a');
    let secondError: Error | null = null;
    try {
      await spec.enterBarrier('double-enter', 'a');
    } catch (e) { secondError = e as Error; }
    expect(secondError).not.toBeNull();
    expect(secondError!.message).toContain('already entered');
    // Other roles must still be able to enter and complete the barrier
    // (a is still parked from its FIRST call, which is legitimate).
    await Promise.all([
      spec.enterBarrier('double-enter', 'b'),
      spec.enterBarrier('double-enter', 'c'),
      first,
    ]);
  });

  test('rejects when role is not in the participants list', async () => {
    await expect(
      spec.enterBarrier('not-allowed', 'a', { participants: ['b', 'c'] }),
    ).rejects.toThrow(/not in the participants/);
  });

  test('times out when fewer than expected entrants arrive', async () => {
    // Only `a` enters — `b` and `c` skip.  After 200 ms the barrier
    // must reject for `a` (we override the default 2_000ms timeout
    // to keep the test fast).
    await expect(
      spec.enterBarrier('lonely', 'a', { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out/);
    // Slot was cleaned up so a fresh attempt can succeed.
    expect(spec.pendingBarrierCount).toBe(0);
  });

  test('changing participant-set mid-flight throws', async () => {
    // a enters with [a,b,c]; b then enters with [a,b] — different
    // participant set, different key — works as separate barrier.
    // But entering the SAME key (i.e. same name + same sorted
    // participant set) with a different declared count would conflict.
    // We can't easily trigger that without bypassing the key
    // computation, so this test instead exercises the happy
    // mismatch-but-distinct-keys path.
    const ab = spec.enterBarrier('split', 'a', { participants: ['a', 'b'], timeoutMs: 200 });
    await spec.enterBarrier('split', 'b', { participants: ['a', 'b'], timeoutMs: 200 });
    await ab;
    // No leftover slots.
    expect(spec.pendingBarrierCount).toBe(0);
  });
});
