/**
 * #935 — the general equal-version tie in `mergeMember`.
 *
 * Two observers can assign the same version to different statuses of one
 * member: versions advance by one from a per-node wall-clock epoch, so a
 * collision needs nothing more than two nodes deciding about the same member
 * in the same step.  The merge ignored every record not strictly newer than
 * the one it held, so each observer kept whichever record reached it first
 * and neither ever had a reason to send a newer one — the views diverged for
 * good.  #1493 resolved the single `weakly-up` / `up` pair; this suite pins
 * the general rule: at equal versions the status further along the lifecycle
 * wins, so the order of arrival cannot decide the outcome.
 *
 * The property at the bottom is the invariant the issue asks for: two nodes
 * that have seen the same set of records hold the same member view,
 * whatever order those records arrived in.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { type GossipMessage, MEMBER_STATUSES, type MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';

const SYSTEM = 'tie-break';
const OBSERVER_HOST = '10.0.194.1';
const SENDER_HOST = '10.0.194.2';
const SUBJECT_HOST = '10.0.194.3';
const UNANSWERED_SEED_HOST = '10.0.194.4';

type Observer = { readonly system: ActorSystem; readonly cluster: Cluster };

/**
 * A node whose seed nobody answers on and whose periodic tasks all lie far
 * past the virtual clock, so only the frames a case delivers move it.
 */
async function startObserver(port: number): Promise<Observer> {
  const address = new NodeAddress(SYSTEM, OBSERVER_HOST, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(new ManualScheduler());
  const system = ActorSystem.create(SYSTEM, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withSeeds([`${UNANSWERED_SEED_HOST}:${port}`])
    .withSeedRetryIntervalMs(600_000)
    .withGossipIntervalMs(600_000)
    .withFailureDetector({ heartbeatIntervalMs: 600_000, unreachableAfterMs: 1_200_000, downAfterMs: 2_400_000 });
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster };
}

/** The `up` third party every record is relayed through — it has standing to speak for others. */
const SENDER = new NodeAddress(SYSTEM, SENDER_HOST, 19_400, 'sender-run');

let sequence = 0;
function nextSequence(): number {
  sequence = Math.max(sequence + 1, Date.now());
  return sequence;
}

function deliver(observer: Observer, subject: NodeAddress, status: MemberStatus, version: number): void {
  const frame: GossipMessage = {
    kind: 'gossip',
    from: SENDER.toJSON(),
    sequence: nextSequence(),
    members: [{ address: subject.toJSON(), status, version, roles: [] }],
  };
  (observer.cluster as unknown as { handleWire(from: NodeAddress, message: GossipMessage): void })
    .handleWire(SENDER, frame);
}

function introduceSender(observer: Observer): void {
  deliver(observer, SENDER, 'up', Date.now());
}

/** The raw record held for `subject`, tombstones included. */
function heldRecord(observer: Observer, subject: NodeAddress): { status: MemberStatus; version: number } | undefined {
  const members = (observer.cluster as unknown as { members: Map<string, { status: MemberStatus; version: number }> }).members;
  const held = members.get(subject.toString());
  return held === undefined ? undefined : { status: held.status, version: held.version };
}

let left: Observer;
let right: Observer;
let subjectPort = 20_000;
/** A fresh subject per case, so cases sharing the two observers never meet. */
function freshSubject(): NodeAddress {
  subjectPort += 1;
  return new NodeAddress(SYSTEM, SUBJECT_HOST, subjectPort);
}

beforeAll(async () => {
  left = await startObserver(19_401);
  right = await startObserver(19_402);
  introduceSender(left);
  introduceSender(right);
});

afterAll(async () => {
  for (const observer of [left, right]) {
    try { await observer.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await observer.system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

describe('an equal-version tie between two statuses resolves the same way in either order (#935)', () => {
  const pairs: Array<[MemberStatus, MemberStatus]> = [];
  for (let i = 0; i < MEMBER_STATUSES.length; i++) {
    for (let j = i + 1; j < MEMBER_STATUSES.length; j++) pairs.push([MEMBER_STATUSES[i]!, MEMBER_STATUSES[j]!]);
  }

  for (const [lower, higher] of pairs) {
    test(`${lower} vs ${higher}: both arrival orders end at ${higher}`, () => {
      const subject = freshSubject();
      const version = Date.now();
      deliver(left, subject, lower, version);
      deliver(left, subject, higher, version);
      deliver(right, subject, higher, version);
      deliver(right, subject, lower, version);
      expect(heldRecord(left, subject)).toEqual({ status: higher, version });
      expect(heldRecord(right, subject)).toEqual({ status: higher, version });
    });
  }

  test('a strictly newer version still beats a status further along', () => {
    // The tie-break orders records at one version only: it must not turn into
    // "the most advanced status wins", which would let a stale `down` shadow
    // the member's newer record for ever.
    const subject = freshSubject();
    const version = Date.now();
    deliver(left, subject, 'down', version);
    deliver(left, subject, 'up', version + 1);
    expect(heldRecord(left, subject)).toEqual({ status: 'up', version: version + 1 });
  });
});

describe('membership merge converges under any delivery order (#935)', () => {
  test('two observers that saw the same records hold the same view', () => {
    const record = fc.record({
      status: fc.constantFrom(...MEMBER_STATUSES),
      // A narrow band, so equal versions — the case under test — are common.
      offset: fc.integer({ min: 0, max: 3 }),
    });
    fc.assert(
      fc.property(
        fc.array(record, { minLength: 1, maxLength: 8 }).chain((records) =>
          fc.tuple(fc.constant(records), fc.shuffledSubarray(records, { minLength: records.length }))),
        ([inOrder, shuffled]) => {
          const subject = freshSubject();
          const base = Date.now();
          for (const { status, offset } of inOrder) deliver(left, subject, status, base + offset);
          for (const { status, offset } of shuffled) deliver(right, subject, status, base + offset);
          expect(heldRecord(left, subject)).toEqual(heldRecord(right, subject));
        },
      ),
    );
  });
});
