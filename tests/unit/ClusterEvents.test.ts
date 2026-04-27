import { describe, expect, test } from 'bun:test';
import {
  LeaderChanged,
  MemberDown,
  MemberJoined,
  MemberLeft,
  MemberReachable,
  MemberRemoved,
  MemberUnreachable,
  MemberUp,
  SelfRemoved,
  SelfUp,
  ShardMapChanged,
} from '../../src/cluster/ClusterEvents.js';
import { Member } from '../../src/cluster/Member.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import { none, some } from '../../src/util/Option.js';

const addr = new NodeAddress('demo', 'h', 1);
const m = new Member(addr, 'up', 1);

describe('Cluster event classes', () => {
  test('SelfUp wraps a member', () => {
    const e = new SelfUp(m);
    expect(e.member).toBe(m);
  });

  test('SelfRemoved wraps a member', () => {
    const e = new SelfRemoved(m);
    expect(e.member).toBe(m);
  });

  test('LeaderChanged carries Option<Member>', () => {
    const ev1 = new LeaderChanged(some(m));
    expect(ev1.leader.isSome()).toBe(true);
    expect(ev1.leader.getOrElse(null as Member | null)).toBe(m);

    const ev2 = new LeaderChanged(none);
    expect(ev2.leader.isNone()).toBe(true);
  });

  test('Member* events all carry the same member', () => {
    expect(new MemberJoined(m).member).toBe(m);
    expect(new MemberUp(m).member).toBe(m);
    expect(new MemberUnreachable(m).member).toBe(m);
    expect(new MemberReachable(m).member).toBe(m);
    expect(new MemberDown(m).member).toBe(m);
    expect(new MemberLeft(m).member).toBe(m);
    expect(new MemberRemoved(m).member).toBe(m);
  });

  test('ShardMapChanged captures type, shards, version', () => {
    const shards = new Map<number, string>([[0, 'a'], [1, 'b']]);
    const e = new ShardMapChanged('counter', shards, 7);
    expect(e.type).toBe('counter');
    expect(e.shards).toBe(shards);
    expect(e.version).toBe(7);
  });
});
