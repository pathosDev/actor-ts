/**
 * #1382 — a node restarted at the same address, a restarted seed, and a node
 * that comes back after it was marked unreachable.
 *
 * None of the three had a test.  A restart at the same `host:port` is the
 * ordinary shape of a pod replacement, and the one the downstream reports for
 * #1272 and #940 began with: the address is the same, the process is not, and
 * everything keyed on `host:port` has to tell the two runs apart.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { MemberJoined, MemberRemoved, type ClusterEvent } from '../../src/cluster/ClusterEvents.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeSpecOptions } from '../../src/testkit/MultiNodeSpecOptions.js';

const DETECTOR = { heartbeatIntervalMs: 50, unreachableAfterMs: 250, downAfterMs: 800 };

let spec: MultiNodeSpec | null = null;

afterEach(async () => {
  await spec?.stop();
  spec = null;
});

function threeNodes(failureDetector = DETECTOR): MultiNodeSpec {
  const options = MultiNodeSpecOptions.create()
    .withRoles(['a', 'b', 'c'])
    .withGossipIntervalMs(50)
    .withFailureDetector(failureDetector);
  spec = new MultiNodeSpec(options);
  return spec;
}

/** The incarnation `observer` holds for `subject`. */
function incarnationSeen(running: MultiNodeSpec, observer: string, subject: string): string | undefined {
  const address = running.addressFor(subject).toString();
  return running.clusterFor(observer).getMembers()
    .find((member) => member.address.toString() === address)?.address.incarnation;
}

describe('a node restarted at the same address (#1382)', () => {
  test('rejoins as a new incarnation, and the old run is removed before the new one joins', async () => {
    const running = threeNodes();
    await running.start();
    for (const role of ['a', 'b', 'c']) await running.awaitMembers(role, 3);
    const oldRun = running.clusterFor('c').selfAddress.incarnation;
    expect(incarnationSeen(running, 'a', 'c')).toBe(oldRun);

    const seenByA: ClusterEvent[] = [];
    running.clusterFor('a').subscribe((event) => seenByA.push(event), { replayMode: 'snapshot' });
    seenByA.length = 0;

    await running.restart('c');
    const newRun = running.clusterFor('c').selfAddress.incarnation;
    expect(newRun).not.toBe(oldRun);
    for (const role of ['a', 'b', 'c']) await running.awaitMembers(role, 3);
    await running.awaitMemberStatus('a', 'c', 'up');
    expect(incarnationSeen(running, 'a', 'c')).toBe(newRun);

    // The old run ends on `a` before the new one is announced.
    const cAddress = running.addressFor('c').toString();
    const aboutC = seenByA.filter((event) =>
      (event instanceof MemberRemoved || event instanceof MemberJoined)
      && event.member.address.toString() === cAddress);
    const removal = aboutC.findIndex((event) => event instanceof MemberRemoved && event.member.address.incarnation === oldRun);
    const join = aboutC.findIndex((event) => event instanceof MemberJoined && event.member.address.incarnation === newRun);
    expect(removal).toBeGreaterThanOrEqual(0);
    expect(join).toBeGreaterThan(removal);
  }, 30_000);
});

describe('a restarted seed (#1382)', () => {
  test('rejoins the cluster it founded instead of founding a second one', async () => {
    const running = threeNodes();
    await running.start();
    for (const role of ['a', 'b', 'c']) await running.awaitMembers(role, 3);

    // `a` is the spec's only seed and the lowest address, so it also leads.
    await running.restart('a');

    for (const role of ['a', 'b', 'c']) await running.awaitMembers(role, 3);
    for (const role of ['a', 'b', 'c']) await running.awaitLeader(role, 'a');
    const membersOfA = running.clusterFor('a').getMembers().map((member) => member.address.toString()).sort();
    expect(membersOfA).toEqual(['a', 'b', 'c'].map((role) => running.addressFor(role).toString()).sort());
  }, 30_000);
});

describe('a node that was unreachable and is heard from again (#1382)', () => {
  test('comes back as the same member — no removal, same incarnation', async () => {
    // A `down-after` far past the test, so the detector parks and nothing
    // removes: the question is only whether the member returns.
    const running = threeNodes({ ...DETECTOR, downAfterMs: 60_000 });
    await running.start();
    for (const role of ['a', 'b', 'c']) await running.awaitMembers(role, 3);
    const run = running.clusterFor('c').selfAddress.incarnation;

    const seenByA: ClusterEvent[] = [];
    running.clusterFor('a').subscribe((event) => seenByA.push(event), { replayMode: 'snapshot' });
    seenByA.length = 0;

    running.partition('a', 'c');
    await running.awaitMemberStatus('a', 'c', 'unreachable');
    running.heal('a', 'c');
    await running.awaitMemberStatus('a', 'c', 'up');

    expect(incarnationSeen(running, 'a', 'c')).toBe(run);
    const cAddress = running.addressFor('c').toString();
    expect(seenByA.some((event) => event instanceof MemberRemoved && event.member.address.toString() === cAddress))
      .toBe(false);
  }, 30_000);
});
