/**
 * The projection behind `GET /cluster/shards` and
 * `ClusterSharding.shardMap()` (#682).
 *
 * `ShardMapChanged` carries each region's shard *count*, while the endpoint's
 * documented response carries each region's shard *ids* — the DistributedData
 * snapshot it used to read had them. So the ids are regrouped out of the
 * assignment map, and these tests pin that regrouping rather than the
 * pass-through fields: the counts in the event are deliberately wrong in one
 * case, because a projection that read them would then produce a different
 * answer and this suite has to notice.
 */
import { describe, expect, test } from 'bun:test';
import { ShardMapChanged } from '../../../../src/cluster/ClusterEvents.js';
import { shardMapViewOf } from '../../../../src/cluster/sharding/ShardMapView.js';
import type { ShardMapRegion } from '../../../../src/cluster/ClusterEvents.js';

const REGION_A: ShardMapRegion = {
  key: 'system@host-a:2551|/system/cluster/sharding/region-entity',
  address: 'system@host-a:2551',
  path: '/system/cluster/sharding/region-entity',
  proxy: false,
  shardCount: 2,
};

const REGION_B: ShardMapRegion = {
  key: 'system@host-b:2552|/system/cluster/sharding/region-entity',
  address: 'system@host-b:2552',
  path: '/system/cluster/sharding/region-entity',
  proxy: false,
  shardCount: 1,
};

describe('shardMapViewOf', () => {
  test('regroups the assignment map into per-region shard ids', () => {
    const event = new ShardMapChanged(
      'entity',
      new Map([[7, REGION_A.key], [3, REGION_B.key], [1, REGION_A.key]]),
      4,
      [REGION_A, REGION_B],
    );

    const view = shardMapViewOf(event, 'system@host-a:2551', 1_700_000_000_000);

    expect(view.typeName).toBe('entity');
    expect(view.leader).toBe('system@host-a:2551');
    expect(view.version).toBe(4);
    expect(view.takenAt).toBe(1_700_000_000_000);
    // Ascending, so an operator diffing two readouts sees a moved shard and
    // not a reordered array.
    expect(view.regions.map((region) => region.key)).toEqual([REGION_A.key, REGION_B.key]);
    expect(view.regions[0]!.shards).toEqual([1, 7]);
    expect(view.regions[1]!.shards).toEqual([3]);
    expect(view.shardHome).toEqual([
      { shard: 1, regionKey: REGION_A.key },
      { shard: 3, regionKey: REGION_B.key },
      { shard: 7, regionKey: REGION_A.key },
    ]);
  });

  test('the ids come from the assignment map, not from the region shardCount', () => {
    // Both counts are lies. A projection that trusted them would report two
    // shards on A and one on B; the assignment map says the opposite.
    const event = new ShardMapChanged(
      'entity',
      new Map([[5, REGION_B.key]]),
      1,
      [{ ...REGION_A, shardCount: 2 }, { ...REGION_B, shardCount: 99 }],
    );

    const view = shardMapViewOf(event, '', 1);

    expect(view.regions[0]!.shards).toEqual([]);
    expect(view.regions[1]!.shards).toEqual([5]);
  });

  test('a region hosting nothing is present with an empty shard list', () => {
    const event = new ShardMapChanged('entity', new Map(), 1, [REGION_A]);

    const view = shardMapViewOf(event, '', 1);

    // Absent would read as "that node is not participating", which is the
    // opposite of what an empty list says during a rebalance.
    expect(view.regions).toHaveLength(1);
    expect(view.regions[0]!.shards).toEqual([]);
    expect(view.shardHome).toEqual([]);
  });

  test('an assignment naming an unlisted region survives in shardHome', () => {
    const event = new ShardMapChanged(
      'entity',
      new Map([[2, 'system@ghost:2599|/system/cluster/sharding/region-entity']]),
      1,
      [REGION_A],
    );

    const view = shardMapViewOf(event, '', 1);

    // Would be a coordinator bug, so the evidence has to reach the readout
    // rather than be swallowed by the regrouping.
    expect(view.shardHome).toEqual([
      { shard: 2, regionKey: 'system@ghost:2599|/system/cluster/sharding/region-entity' },
    ]);
    expect(view.regions[0]!.shards).toEqual([]);
  });

  test('the whole view survives a JSON round trip unchanged', () => {
    const event = new ShardMapChanged(
      'entity',
      new Map([[0, REGION_A.key]]),
      2,
      [REGION_A, { ...REGION_B, proxy: true }],
    );

    const view = shardMapViewOf(event, 'system@host-a:2551', 42);

    // The endpoint serialises this verbatim, so a Map or a class instance
    // sneaking in would surface as an empty object on the wire and nowhere
    // else.
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });
});
