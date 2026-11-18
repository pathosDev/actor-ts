/**
 * #1828 — the window after which a node clears an `unreachable` mark it holds
 * on a peer's word runs from the mark's *first* arrival.
 *
 * The merge stores an `unreachable` record over an `unreachable` one whenever
 * the incoming version is higher — a second observer that keeps re-marking the
 * member does exactly that.  If each such record restarted the window, the
 * way out for a mark whose first observer crashed would never be reached while
 * another observer kept gossiping.  The records enter through `mergeMember`
 * and the heartbeat through `onHeartbeat`, the seams the merge and liveness
 * suites use; the clock is a `ManualScheduler`, so the window is counted in
 * virtual time.
 */
import { afterEach, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { HeartbeatMessage, MemberData, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';

const STABLE_AFTER_MS = 4_000;

type ClusterInternals = {
  readonly members: Map<string, Member>;
  mergeMember(from: NodeAddress, senderStatus: MemberStatus | undefined, data: MemberData): void;
  onHeartbeat(from: NodeAddress, message: HeartbeatMessage): void;
};

const internals = (cluster: Cluster): ClusterInternals => cluster as unknown as ClusterInternals;

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
});

test('more unreachable gossip at higher versions does not restart the window from the first sighting', async () => {
  const scheduler = new ManualScheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(scheduler);
  const system = ActorSystem.create('peer-word-window', systemOptions);
  systems.push(system);
  const self = new NodeAddress('peer-word-window', '10.0.128.1', 9_601);
  const clusterOptions = ClusterOptions.create()
    .withHost(self.host)
    .withPort(self.port)
    .withTransport(new InMemoryTransport(self))
    // Nothing on a timer may decide anything here: the detector never gives
    // up on anyone within the test, and gossip and heartbeats wait an hour.
    .withFailureDetector({ heartbeatIntervalMs: 3_600_000, unreachableAfterMs: 3_600_000, downAfterMs: 7_200_000 })
    .withFailureDetectorAutoDown(false)
    .withGossipIntervalMs(3_600_000)
    .withSplitBrainResolver({ stableAfterMs: STABLE_AFTER_MS });
  const cluster = await Cluster.join(system, clusterOptions);

  const observer = new NodeAddress('peer-word-window', '10.0.128.2', 9_602);
  const subject = new NodeAddress('peer-word-window', '10.0.128.3', 9_603);
  const version = Date.now();
  internals(cluster).mergeMember(observer, 'up', { address: observer.toJSON(), status: 'up', version, roles: [] });
  internals(cluster).mergeMember(subject, 'up', { address: subject.toJSON(), status: 'up', version, roles: [] });
  const statusOfSubject = (): MemberStatus | undefined => internals(cluster).members.get(subject.toString())?.status;
  const heartbeatFromSubject = (seq: number): void =>
    internals(cluster).onHeartbeat(subject, { kind: 'heartbeat', from: subject.toJSON(), seq, ts: Date.now() });

  // First sighting of the mark, on the observer's word.
  internals(cluster).mergeMember(observer, 'up', { address: subject.toJSON(), status: 'unreachable', version: version + 1, roles: [] });
  expect(statusOfSubject()).toBe('unreachable');

  // Half a window later the mark arrives again, newer — still `unreachable`.
  scheduler.advance(STABLE_AFTER_MS / 2);
  internals(cluster).mergeMember(observer, 'up', { address: subject.toJSON(), status: 'unreachable', version: version + 2, roles: [] });
  expect(internals(cluster).members.get(subject.toString())?.version).toBe(version + 2);
  heartbeatFromSubject(1);
  expect(statusOfSubject()).toBe('unreachable');

  // One window after the *first* sighting the subject, still talking to this
  // node, is cleared — restarting at the re-mark would hold it another half.
  scheduler.advance(STABLE_AFTER_MS / 2);
  heartbeatFromSubject(2);
  expect(statusOfSubject()).toBe('up');
});
