/**
 * MockCluster tests (#289) — verify the in-memory cluster surface
 * delivers events in the expected order and shape, without
 * touching a real ActorSystem / Transport.
 */
import { describe, expect, test } from 'bun:test';
import { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import {
  LeaderChanged, MemberDown, MemberJoined, MemberLeft, MemberReachable,
  MemberRemoved, MemberUnreachable, MemberUp, SelfRemoved, SelfUp,
} from '../../../src/cluster/ClusterEvents.js';
import { MockCluster } from '../../../src/testkit/MockCluster.js';

const addr = (port: number): NodeAddress => new NodeAddress('sys', 'host', port);

describe('MockCluster — construction + accessors', () => {
  test('self is registered as an up member at construction time', () => {
    const cluster = new MockCluster({ selfAddress: addr(1) });
    expect(cluster.selfAddress.toString()).toBe('sys@host:1');
    const ups = cluster.upMembers();
    expect(ups.length).toBe(1);
    expect(ups[0]!.address.toString()).toBe('sys@host:1');
  });

  test('initial members are merged in', () => {
    const cluster = new MockCluster({
      selfAddress: addr(1),
      initialMembers: [new Member(addr(2), 'up', 1, [])],
    });
    expect(cluster.getMembers().length).toBe(2);
  });

  test('initial leader defaults to lowest-address up member', () => {
    const cluster = new MockCluster({
      selfAddress: addr(5),
      initialMembers: [
        new Member(addr(2), 'up', 1, []),
        new Member(addr(3), 'up', 1, []),
      ],
    });
    const leader = cluster.getLeader();
    expect(leader.isSome()).toBe(true);
    // Lowest-port wins lexicographically (sys@host:2 < sys@host:3 < sys@host:5)
    expect(leader.toNullable()!.address.port).toBe(2);
  });
});

describe('MockCluster — subscribe replays current state', () => {
  test('new subscriber receives MemberUp for every up member + SelfUp + LeaderChanged', () => {
    const cluster = new MockCluster({
      selfAddress: addr(1),
      initialMembers: [new Member(addr(2), 'up', 1, [])],
    });
    const events: string[] = [];
    cluster.subscribe((e) => events.push(e.constructor.name));
    expect(events).toContain('MemberUp');
    expect(events).toContain('SelfUp');
    expect(events).toContain('LeaderChanged');
  });

  test('returned unsubscribe handle removes the listener', () => {
    const cluster = new MockCluster({ selfAddress: addr(1) });
    const events: string[] = [];
    const unsubscribe = cluster.subscribe((e) => events.push(e.constructor.name));
    expect(cluster.listenerCount).toBe(1);
    unsubscribe();
    expect(cluster.listenerCount).toBe(0);
    cluster.addMember(addr(2));
    expect(events).not.toContain('MemberJoined');
  });
});

describe('MockCluster — driver methods emit events', () => {
  test('addMember → MemberJoined; upMember → MemberUp + possible LeaderChanged', () => {
    const cluster = new MockCluster({ selfAddress: addr(5) });
    const events: string[] = [];
    cluster.subscribe((e) => events.push(e.constructor.name));
    events.length = 0; // ignore replay

    cluster.addMember(addr(2));
    expect(events).toContain('MemberJoined');

    cluster.upMember(addr(2));
    expect(events).toContain('MemberUp');
    // New member has lower port → becomes leader.
    expect(events).toContain('LeaderChanged');
  });

  test('downMember → MemberDown', () => {
    const cluster = new MockCluster({
      selfAddress: addr(1),
      initialMembers: [new Member(addr(2), 'up', 1, [])],
    });
    let downed: Member | null = null;
    cluster.subscribe((e) => { if (e instanceof MemberDown) downed = e.member; });
    cluster.downMember(addr(2));
    expect(downed).not.toBeNull();
    expect(downed!.address.port).toBe(2);
    expect(downed!.status).toBe('down');
  });

  test('leaveMember fires MemberLeft → MemberRemoved (+ SelfRemoved on self)', () => {
    const cluster = new MockCluster({
      selfAddress: addr(1),
      initialMembers: [new Member(addr(2), 'up', 1, [])],
    });
    const events: Array<MemberLeft | MemberRemoved | SelfRemoved> = [];
    cluster.subscribe((e) => {
      if (e instanceof MemberLeft || e instanceof MemberRemoved || e instanceof SelfRemoved) {
        events.push(e);
      }
    });
    cluster.leaveMember(addr(2));
    expect(events.length).toBe(2);
    expect(events[0]).toBeInstanceOf(MemberLeft);
    expect(events[1]).toBeInstanceOf(MemberRemoved);

    // leaving self ALSO fires SelfRemoved.
    cluster.leaveMember(addr(1));
    const selfRemoved = events.find((e) => e instanceof SelfRemoved);
    expect(selfRemoved).toBeDefined();
  });

  test('markUnreachable + markReachable fire the matching events', () => {
    const cluster = new MockCluster({
      selfAddress: addr(1),
      initialMembers: [new Member(addr(2), 'up', 1, [])],
    });
    const seen: string[] = [];
    cluster.subscribe((e) => seen.push(e.constructor.name));
    seen.length = 0;
    cluster.markUnreachable(addr(2));
    expect(seen).toContain('MemberUnreachable');
    cluster.markReachable(addr(2));
    expect(seen).toContain('MemberReachable');
  });

  test('setLeader fires LeaderChanged with the new leader', () => {
    const cluster = new MockCluster({
      selfAddress: addr(1),
      initialMembers: [new Member(addr(2), 'up', 1, [])],
    });
    let last: LeaderChanged | null = null;
    cluster.subscribe((e) => { if (e instanceof LeaderChanged) last = e; });
    cluster.setLeader(addr(2));
    expect(last).not.toBeNull();
    expect(last!.leader.isSome()).toBe(true);
    expect(last!.leader.toNullable()!.address.port).toBe(2);
  });

  test('setLeader(null) → LeaderChanged with None', () => {
    const cluster = new MockCluster({ selfAddress: addr(1) });
    let last: LeaderChanged | null = null;
    cluster.subscribe((e) => { if (e instanceof LeaderChanged) last = e; });
    cluster.setLeader(null);
    expect(last).not.toBeNull();
    expect(last!.leader.isNone()).toBe(true);
  });

  test('requireMember on unknown address throws', () => {
    const cluster = new MockCluster({ selfAddress: addr(1) });
    expect(() => cluster.upMember(addr(999))).toThrow(/no member/);
  });
});

describe('MockCluster — error isolation', () => {
  test('a throwing listener does not break other listeners', () => {
    const cluster = new MockCluster({ selfAddress: addr(1) });
    const seen: string[] = [];
    cluster.subscribe(() => { throw new Error('boom'); });
    cluster.subscribe((e) => seen.push(e.constructor.name));
    cluster.addMember(addr(2));
    expect(seen).toContain('MemberJoined');
  });
});
