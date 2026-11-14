/**
 * Two coordinator-state snapshots one node writes in the same millisecond
 * (#950).
 *
 * `scheduleCoordinatorStateSave` coalesces a rebalance burst into a follow-up
 * save fired from the in-flight one's `.finally`, so the second snapshot
 * routinely carries the first one's `takenAt`.  The store stamped the register
 * with that `takenAt` and the node's fixed replica id, so the two registers tied
 * on both halves of the order and `LWWRegister.merge` kept whichever side was
 * `this`: two peers gossiping the pair in opposite orders kept different shard
 * maps.  The store now stamps every write above the register it replaces, so
 * the later snapshot wins on the timestamp alone, in either order.
 *
 * The handle is a fake that applies `update` synchronously and records every
 * register it produced — those are the states a peer receives over gossip.
 */
import { describe, expect, test } from 'bun:test';
import {
  DistributedDataCoordinatorStateStore,
  type CoordinatorStateData,
} from '../../../../src/cluster/sharding/CoordinatorState.js';
import type { DistributedDataHandle } from '../../../../src/crdt/DistributedData.js';
import { LWWRegister } from '../../../../src/crdt/LWWRegister.js';

type Register = LWWRegister<CoordinatorStateData>;

/** The two members of `DistributedDataHandle` the store calls, over one map. */
function recordingHandle(): { readonly handle: DistributedDataHandle; readonly written: Register[] } {
  const values = new Map<string, Register>();
  const written: Register[] = [];
  const handle = {
    get: (key: string) => values.get(key),
    update: (key: string, factory: () => Register, mutator: (current: Register) => Register) => {
      const next = mutator(values.get(key) ?? factory());
      values.set(key, next);
      written.push(next);
    },
  };
  return { handle: handle as unknown as DistributedDataHandle, written };
}

/** A snapshot whose only difference is where shard 0 lives. */
function snapshot(regionKey: string, takenAt: number): CoordinatorStateData {
  return { leader: 'sys@h:1', takenAt, regions: [], shardHome: [[0, regionKey]], numShards: 1 };
}

describe('DistributedDataCoordinatorStateStore — same-millisecond saves (#950)', () => {
  test('the later of two snapshots taken in one millisecond wins in both arrival orders', async () => {
    const { handle, written } = recordingHandle();
    const store = new DistributedDataCoordinatorStateStore(handle, 'sys@h:1');

    // The earlier snapshot is the one a value tie-break would keep — its JSON
    // sorts higher — so only the stamping can make the later one win.
    await store.save('entity', snapshot('region-b', 1_000));
    await store.save('entity', snapshot('region-a', 1_000));
    const [first, second] = written as [Register, Register];

    expect(first.merge(second).value()?.shardHome).toEqual([[0, 'region-a']]);
    expect(second.merge(first).value()?.shardHome).toEqual([[0, 'region-a']]);
  });

  test('a snapshot whose wall clock went backwards still replaces the one before it', async () => {
    const { handle, written } = recordingHandle();
    const store = new DistributedDataCoordinatorStateStore(handle, 'sys@h:1');

    await store.save('entity', snapshot('region-a', 2_000));
    await store.save('entity', snapshot('region-b', 1_500));
    const [first, second] = written as [Register, Register];

    expect(first.merge(second).value()?.shardHome).toEqual([[0, 'region-b']]);
    expect(second.merge(first).value()?.shardHome).toEqual([[0, 'region-b']]);
    // `takenAt` itself is left as written: it is the snapshot's wall clock, and
    // only the register's stamp moves.
    expect(second.value()?.takenAt).toBe(1_500);
  });
});
