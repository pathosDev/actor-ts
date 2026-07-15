import type { MockClusterOptions, MockClusterOptionsType } from './MockClusterOptions.js';
import type { ActorRef } from '../ActorRef.js';
import { Member } from '../cluster/Member.js';
import { NodeAddress } from '../cluster/NodeAddress.js';
import type { MemberStatus } from '../cluster/Protocol.js';
import {
  LeaderChanged, MemberDown, MemberJoined, MemberLeft, MemberReachable,
  MemberRemoved, MemberUnreachable, MemberUp, SelfRemoved, SelfUp,
  type ClusterEvent,
} from '../cluster/ClusterEvents.js';
import { none, some, type Option } from '../util/Option.js';

/**
 * Tiny in-memory mock of the {@link Cluster} read surface — for unit
 * tests that only care about membership events and don't want to
 * spin up a real ActorSystem + Transport.
 *
 * What it provides:
 *   - `subscribe(listener)` — same shape as `Cluster.subscribe`; the
 *     mock replays the current view as `MemberUp` events on first
 *     subscribe, then emits events imperatively via the test helper
 *     methods.
 *   - `getMembers()` / `upMembers()` / `getMembersByStatus()` —
 *     same accessor shape as the real Cluster.
 *   - `selfAddress` — fixed at construction time.
 *
 * What it deliberately does NOT do:
 *   - No Transport — `tell` / `send` paths aren't simulated.  Use
 *     the in-memory MultiNodeSpec if you need real message flow.
 *   - No gossip — events fire when the test driver calls them.
 *   - No failure detection — `markUnreachable()` flips status
 *     synchronously.
 *
 * Use for: testing code that subscribes to cluster events
 * (Receptionist, Sharding, DowningProvider impls) without paying
 * the spin-up cost of a real Cluster instance.
 */

export class MockCluster {
  readonly selfAddress: NodeAddress;
  private readonly members = new Map<string, Member>();
  private leader: Option<Member>;
  private readonly listeners: Array<(e: ClusterEvent) => void> = [];

  constructor(optionsInput: MockClusterOptions) {
    const options = optionsInput as MockClusterOptionsType;
    this.selfAddress = options.selfAddress;
    // Self always present.
    const selfMember = new Member(options.selfAddress, 'up', 1, []);
    this.members.set(options.selfAddress.toString(), selfMember);
    for (const member of options.initialMembers ?? []) {
      this.members.set(member.address.toString(), member);
    }
    this.leader = options.initialLeader ?? this.computeLeader();
  }

  /** Match the Cluster API: replays current state on subscribe. */
  subscribe(listener: (event: ClusterEvent) => void): () => void {
    for (const member of this.members.values()) {
      if (member.status === 'up') {
        try { listener(new MemberUp(member)); } catch { /* ignore */ }
      }
    }
    if (this.members.get(this.selfAddress.toString())?.status === 'up') {
      try { listener(new SelfUp(this.members.get(this.selfAddress.toString())!)); } catch { /* ignore */ }
    }
    this.leader.forEach((l) => {
      try { listener(new LeaderChanged(some(l))); } catch { /* ignore */ }
    });
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  getMembers(): ReadonlyArray<Member> {
    return Array.from(this.members.values()).filter((member) => member.status !== 'removed');
  }

  upMembers(): Member[] {
    return Array.from(this.members.values())
      .filter((member) => member.status === 'up')
      .sort((a, b) => a.address.compareTo(b.address));
  }

  getMembersByStatus(status: MemberStatus): Member[] {
    return Array.from(this.members.values()).filter((member) => member.status === status);
  }

  getLeader(): Option<Member> { return this.leader; }

  /* ------------------------------ Test driver ------------------------------ */

  /** Add a fresh peer in `joining` state and fire `MemberJoined`. */
  addMember(address: NodeAddress, roles: ReadonlyArray<string> = []): Member {
    const member = new Member(address, 'joining', 1, roles);
    this.members.set(address.toString(), member);
    this.emit(new MemberJoined(member));
    return member;
  }

  /** Transition a member to `up` and fire `MemberUp` (+ LeaderChanged if it changes). */
  upMember(address: NodeAddress): Member {
    const prev = this.requireMember(address);
    const member = new Member(address, 'up', prev.version + 1, prev.roles);
    this.members.set(address.toString(), member);
    this.emit(new MemberUp(member));
    this.maybeLeaderChange();
    return member;
  }

  /** Mark a member as unreachable; fires `MemberUnreachable`. */
  markUnreachable(address: NodeAddress): Member {
    const prev = this.requireMember(address);
    // The Member type doesn't carry an `unreachable` status — only
    // the FailureDetector view does.  We re-emit the event with the
    // current member; consumers that care about reachability listen
    // for the EVENT, not a status mutation.
    this.emit(new MemberUnreachable(prev));
    return prev;
  }

  markReachable(address: NodeAddress): Member {
    const prev = this.requireMember(address);
    this.emit(new MemberReachable(prev));
    return prev;
  }

  /** Force a member down (DowningProvider triggered).  Fires `MemberDown`. */
  downMember(address: NodeAddress): Member {
    const prev = this.requireMember(address);
    const member = new Member(address, 'down', prev.version + 1, prev.roles);
    this.members.set(address.toString(), member);
    this.emit(new MemberDown(member));
    return member;
  }

  /** Graceful leave path — fires `MemberLeft` then `MemberRemoved`. */
  leaveMember(address: NodeAddress): Member {
    const prev = this.requireMember(address);
    const leaving = new Member(address, 'leaving', prev.version + 1, prev.roles);
    this.members.set(address.toString(), leaving);
    this.emit(new MemberLeft(leaving));
    const removed = new Member(address, 'removed', prev.version + 2, prev.roles, Date.now());
    this.members.set(address.toString(), removed);
    this.emit(new MemberRemoved(removed));
    if (address.equals(this.selfAddress)) {
      this.emit(new SelfRemoved(removed));
    }
    this.maybeLeaderChange();
    return removed;
  }

  /** Move the leader to a specific member.  Fires `LeaderChanged`. */
  setLeader(addr: NodeAddress | null): void {
    if (addr === null) {
      this.leader = none;
    } else {
      const member = this.requireMember(addr);
      this.leader = some(member);
    }
    this.emit(new LeaderChanged(this.leader));
  }

  /** Snapshot of registered listeners — for test introspection. */
  get listenerCount(): number { return this.listeners.length; }

  /* ------------------------------ internals ------------------------------ */

  private emit(event: ClusterEvent): void {
    for (const listener of this.listeners.slice()) {
      try { listener(event); } catch { /* ignore */ }
    }
  }

  private requireMember(address: NodeAddress): Member {
    const member = this.members.get(address.toString());
    if (!member) throw new Error(`MockCluster: no member with address ${address}`);
    return member;
  }

  private computeLeader(): Option<Member> {
    const ups = this.upMembers();
    return ups.length > 0 ? some(ups[0]!) : none;
  }

  private maybeLeaderChange(): void {
    const newLeader = this.computeLeader();
    const prevLeader = this.leader;
    const sameLeader =
      (prevLeader.isNone() && newLeader.isNone()) ||
      (prevLeader.isSome() && newLeader.isSome() &&
        prevLeader.value.address.equals(newLeader.value.address));
    if (!sameLeader) {
      this.leader = newLeader;
      this.emit(new LeaderChanged(newLeader));
    }
  }

  /** Compatibility with code that calls `cluster.actorRefForMember(m)` — not implemented. */
  actorRefForMember(_member: Member): ActorRef<unknown> | null {
    return null;
  }
}
