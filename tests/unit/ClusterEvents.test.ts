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

  test('ShardMapChanged captures type, shards, version', () => {
    const shards = new Map<number, string>([[0, 'a'], [1, 'b']]);
    const event = new ShardMapChanged('counter', shards, 7);
    expect(event.type).toBe('counter');
    expect(event.shards).toBe(shards);
    expect(event.version).toBe(7);
  });
});
