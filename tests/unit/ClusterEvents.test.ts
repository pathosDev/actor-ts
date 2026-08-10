import { describe, expect, test } from 'bun:test';
import {
  CurrentClusterState,
  LeaderChanged,
  MemberDown,
  MemberJoined,
  MemberLeft,
  MemberReachable,
  MemberRemoved,
  MemberUnreachable,
  MemberUp,
  ReachabilityChanged,
  SelfRemoved,
  SelfUp,
  ShardMapChanged,
} from '../../src/cluster/ClusterEvents.js';
import { Member } from '../../src/cluster/Member.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import { none, some } from '../../src/util/Option.js';

const addr = new NodeAddress('demo', 'h', 1);
const member = new Member(addr, 'up', 1);

describe('Cluster event classes', () => {
  test('SelfUp wraps a member', () => {
    const event = new SelfUp(member);
    expect(event.member).toBe(member);
  });

  test('SelfRemoved wraps a member', () => {
    const event = new SelfRemoved(member);
    expect(event.member).toBe(member);
  });

  test('LeaderChanged carries Option<Member>', () => {
    const ev1 = new LeaderChanged(some(member));
    expect(ev1.leader.isSome()).toBe(true);
    expect(ev1.leader.getOrElse(null as Member | null)).toBe(member);

    const ev2 = new LeaderChanged(none);
    expect(ev2.leader.isNone()).toBe(true);
  });

  test('Member* events all carry the same member', () => {
    expect(new MemberJoined(member).member).toBe(member);
    expect(new MemberUp(member).member).toBe(member);
    expect(new MemberUnreachable(member).member).toBe(member);
    expect(new MemberReachable(member).member).toBe(member);
    expect(new MemberDown(member).member).toBe(member);
    expect(new MemberLeft(member).member).toBe(member);
    expect(new MemberRemoved(member).member).toBe(member);
  });

  test('CurrentClusterState keeps unreachable as a subset of members (#161)', () => {
    // Not a disjoint set: an unreachable peer is still a member, and excluding
    // it would make `members.length` mean something different depending on the
    // cluster's health.
    const lost = new Member(new NodeAddress('demo', 'h', 2), 'unreachable', 3);
    const state = new CurrentClusterState([member, lost], [lost], some(member));
    expect(state.members).toEqual([member, lost]);
    expect(state.unreachable).toEqual([lost]);
    expect(state.leader.getOrElse(null as Member | null)).toBe(member);
  });

  test('ReachabilityChanged carries an address and a verdict, not a member (#161)', () => {
    // Address rather than `Member`, because the fact it states is the local
    // detector's, and a `Member` would invite reading its gossiped `status` as
    // if it were the same thing.
    const event = new ReachabilityChanged(addr, false);
    expect(event.address).toBe(addr);
    expect(event.reachable).toBe(false);
  });

  test('ShardMapChanged captures type, shards, version', () => {
    const shards = new Map<number, string>([[0, 'a'], [1, 'b']]);
    const event = new ShardMapChanged('counter', shards, 7);
    expect(event.type).toBe('counter');
    expect(event.shards).toBe(shards);
    expect(event.version).toBe(7);
    // Regions are optional so a producer that only knows the map still fits.
    expect(event.regions).toEqual([]);
  });

  test('ShardMapChanged carries the region table when the producer has it', () => {
    const regionPath = '/system/cluster/sharding/region-counter';
    const regions = [
      { key: `a@h:1|${regionPath}`, address: 'a@h:1', path: regionPath, proxy: false, shardCount: 2 },
    ];
    const event = new ShardMapChanged('counter', new Map([[0, `a@h:1|${regionPath}`]]), 8, regions);
    expect(event.regions).toBe(regions);
  });
});
