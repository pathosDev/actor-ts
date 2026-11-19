/**
 * When a coordinator asks a region to register, and when it does not (#853,
 * #849).
 *
 * A `sharding.RegistrationRequest` goes to a region the coordinator has a
 * concrete reason to believe in and no registration from: an entry it has just
 * seeded from a snapshot, a region its predecessor knew before a restart, a
 * region whose beat names a key it does not hold.  The end-to-end cases live in
 * `CoordinatorRestart.test.ts` and `StaleRegionDetection.test.ts`; this file
 * pins each trigger on its own, including the one no public route isolates —
 * the request after a snapshot load, which a restart's own hand-over or a
 * leader change's own re-registration would otherwise always cover for.
 *
 * The harness is `StaleRegionSweepMembership.test.ts`'s: the live coordinator
 * of a real single-node cluster, reached through its cell, its registry written
 * directly and its handlers called by the test.  The peers it addresses are
 * staged `up` in the cluster's member map at addresses no transport serves, so
 * every request is visible at this node's transport and goes nowhere after.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { Member } from '../../../../src/cluster/Member.js';
import { NodeAddress, type NodeAddressData } from '../../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import type { CoordinatorStateData, CoordinatorStateStore } from '../../../../src/cluster/sharding/CoordinatorState.js';
import { AuthenticatedShardingMessage } from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { coordinatorSegments } from '../../../util/SystemPaths.js';

type WorkCommand = { id: string; kind: 'work' };

const TYPE_NAME = 'entity';
const NUM_SHARDS = 8;
const PEER_REGION_PATH = '/system/cluster-sharding/region-entity';

class Entity extends Actor<WorkCommand> {
  override onReceive(): void {}
}

/** One envelope this node sent, as far as these cases read it. */
type SentRequest = { readonly to: string; readonly path: string };

/** Records every `sharding.RegistrationRequest` this node sends, then sends it on. */
class RequestRecordingTransport extends InMemoryTransport {
  readonly requests: SentRequest[] = [];

  override send(to: NodeAddress, message: WireMessage): void {
    if (message.kind === 'envelope') {
      const body = message.body as { kind?: unknown } | null;
      if (typeof body === 'object' && body !== null && body.kind === 'sharding.RegistrationRequest') {
        this.requests.push({ to: to.toString(), path: message.to });
      }
    }
    super.send(to, message);
  }
}

/** A store whose `load` answers with whatever the case has put in it. */
class SettableSnapshotStore implements CoordinatorStateStore {
  snapshot: CoordinatorStateData | null = null;

  async load(): Promise<CoordinatorStateData | null> { return this.snapshot; }

  async save(): Promise<void> { /* the cases are about the seeding, not the persistence */ }
}

type RegionInfo = {
  readonly node: NodeAddress;
  readonly path: string;
  readonly proxy: boolean;
  readonly shards: Set<number>;
  lastSeenAtMs: number;
  lastHeartbeatAtMs: number | null;
  readonly seededFromSnapshot: boolean;
};

type RegionAddress = { readonly path: string; readonly node: NodeAddressData };

/** The coordinator members these cases read and call. */
type CoordinatorInternals = {
  readonly regions: Map<string, RegionInfo>;
  readonly refusedRegions: Set<string>;
  applyCoordinatorState(data: unknown): void;
  onRegionHeartbeat(message: { kind: 'sharding.RegionHeartbeat'; region: string; node: NodeAddressData }): void;
  onRequestRegistrations(event: { kind: 'request-registrations'; regions: ReadonlyArray<RegionAddress> }): void;
};

/** `Cluster`'s private member map, written to stage peers. */
type ClusterInternals = { readonly members: Map<string, Member> };

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly transport: RequestRecordingTransport;
  readonly store: SettableSnapshotStore;
  readonly coordinator: CoordinatorInternals;
};

let running: Harness | null = null;
let nextPort = 62_170;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* best-effort */ });
    await running.system.terminate().catch(() => { /* best-effort */ });
    running = null;
  }
});

async function startCoordinator(systemName: string): Promise<Harness> {
  const port = nextPort++;
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const transport = new RequestRecordingTransport(new NodeAddress(systemName, 'h', port));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(transport)
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);

  const store = new SettableSnapshotStore();
  const shardingOptions = StartShardingOptions.create<WorkCommand>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    .withPassivationIdleMs(0)
    .withRebalanceIntervalMs(600_000)
    .withCoordinatorStateStore(store);
  const region = cluster.sharding.start<WorkCommand>(shardingOptions);

  const reachCoordinator = (): CoordinatorInternals | null => {
    const resolved = system._resolvePath(coordinatorSegments(systemName, TYPE_NAME));
    if (resolved.isNone()) return null;
    const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
    return (cell?.actor as CoordinatorInternals | undefined) ?? null;
  };
  region.tell({ id: 'warm-up', kind: 'work' });
  await awaitCondition(() => (reachCoordinator()?.regions.size ?? 0) > 0, {
    timeoutMs: 4_000,
    label: 'the coordinator is live and the local region has registered',
  });

  const harness: Harness = { system, cluster, transport, store, coordinator: reachCoordinator()! };
  running = harness;
  return harness;
}

/** A peer `up` in this node's view, on a host that sorts after `h` so the leadership stays here. */
function stagePeer(harness: Harness, host: string): NodeAddress {
  const address = new NodeAddress(harness.system.name, host, 2_551);
  expect(address.compareTo(harness.cluster.selfAddress)).toBeGreaterThan(0);
  (harness.cluster as unknown as ClusterInternals).members.set(address.toString(), new Member(address, 'up', 1));
  return address;
}

function keyOf(address: NodeAddress): string {
  return `${address}|${PEER_REGION_PATH}`;
}

/**
 * The region paths this node asked `address` to register — without the
 * `actor-ts://<system>` prefix the remote ref writes onto the envelope, so a
 * case compares against the path it seeded.
 */
function requestsTo(harness: Harness, address: NodeAddress): string[] {
  return harness.transport.requests
    .filter((request) => request.to === address.toString())
    .map((request) => request.path.replace(/^actor-ts:\/\/[^/]+/, ''));
}

describe('a plain object cannot pose as one of the coordinator\'s own commands (#1267)', () => {
  // The coordinator's internal commands — `request-registrations`,
  // `coordinator-state-loaded`, `leader-changed`, … — were plain `{ kind }`
  // objects matched by their string, so anything that reached the mailbox
  // unattributed and spelled one was obeyed.  Only the envelope trust policy's
  // `/system` refusal stood in front of that.  They are classes now, and a
  // plain object spelling one is an unattributed frame, refused.
  test('a plain request-registrations or coordinator-state-loaded changes nothing', async () => {
    const harness = await startCoordinator('registration-requests-forged-command');
    const forgedTarget = stagePeer(harness, 'peer-forged');
    const fencePeer = stagePeer(harness, 'peer-fence');
    const resolved = harness.system._resolvePath(coordinatorSegments(harness.system.name, TYPE_NAME));
    if (resolved.isNone()) throw new Error('coordinator actor not found');
    const leaderTerm = (harness.coordinator as unknown as { readonly leaderTerm: number }).leaderTerm;

    resolved.value.tell({
      kind: 'request-registrations',
      regions: [{ path: PEER_REGION_PATH, node: forgedTarget.toJSON() }],
    } as never);
    resolved.value.tell({
      kind: 'coordinator-state-loaded',
      term: leaderTerm,
      data: {
        leader: harness.cluster.selfAddress.toString(),
        takenAt: 0,
        numShards: NUM_SHARDS,
        regions: [{ key: keyOf(forgedTarget), node: forgedTarget.toJSON(), path: PEER_REGION_PATH, proxy: false, shards: [5] }],
        shardHome: [[5, keyOf(forgedTarget)]],
      },
    } as never);
    // The fence: a genuine beat from a key the coordinator does not hold is
    // answered with a request, behind both forged commands.
    resolved.value.tell(new AuthenticatedShardingMessage(fencePeer, {
      kind: 'sharding.RegionHeartbeat',
      region: PEER_REGION_PATH,
      node: fencePeer.toJSON(),
    }) as never);
    await awaitCondition(() => requestsTo(harness, fencePeer).length > 0, {
      timeoutMs: 4_000,
      label: 'the coordinator handled everything told to it',
    });

    expect(requestsTo(harness, forgedTarget)).toEqual([]);
    expect(harness.coordinator.regions.has(keyOf(forgedTarget))).toBe(false);
  });
});

describe('a coordinator asks for the registrations it lacks (#853, #849)', () => {
  test('a snapshot load asks every entry it seeds, and only those', async () => {
    const harness = await startCoordinator('registration-requests-load');
    const seededPeer = stagePeer(harness, 'peer-seeded');
    // Named by the snapshot but no member: filtered out by the load, so it
    // must not be asked either.
    const departedPeer = new NodeAddress(harness.system.name, 'peer-departed', 2_551);
    harness.store.snapshot = {
      leader: harness.cluster.selfAddress.toString(),
      takenAt: 0,
      numShards: NUM_SHARDS,
      regions: [seededPeer, departedPeer].map((address) => ({
        key: keyOf(address), node: address.toJSON(), path: PEER_REGION_PATH, proxy: false, shards: [5],
      })),
      shardHome: [[5, keyOf(seededPeer)]],
    };

    harness.coordinator.applyCoordinatorState(harness.store.snapshot);

    expect(harness.coordinator.regions.get(keyOf(seededPeer))?.seededFromSnapshot).toBe(true);
    expect(harness.coordinator.regions.has(keyOf(departedPeer))).toBe(false);
    expect(requestsTo(harness, seededPeer)).toEqual([PEER_REGION_PATH]);
    expect(requestsTo(harness, departedPeer)).toEqual([]);
  });

  test('a beat from a key the coordinator does not hold is answered with a request', async () => {
    const harness = await startCoordinator('registration-requests-beat');
    const peer = stagePeer(harness, 'peer-evicted');

    harness.coordinator.onRegionHeartbeat({ kind: 'sharding.RegionHeartbeat', region: PEER_REGION_PATH, node: peer.toJSON() });

    expect(requestsTo(harness, peer)).toEqual([PEER_REGION_PATH]);
    // A beat is no registration: nothing was invented for the key.
    expect(harness.coordinator.regions.has(keyOf(peer))).toBe(false);
  });

  test('a beat from a known region refreshes it and asks nothing; a refused key is not asked', async () => {
    const harness = await startCoordinator('registration-requests-known');
    const known = stagePeer(harness, 'peer-known');
    const refused = stagePeer(harness, 'peer-refused');
    harness.coordinator.regions.set(keyOf(known), {
      node: known, path: PEER_REGION_PATH, proxy: false, shards: new Set(),
      lastSeenAtMs: 0, lastHeartbeatAtMs: null, seededFromSnapshot: false,
    });
    harness.coordinator.refusedRegions.add(keyOf(refused));

    harness.coordinator.onRegionHeartbeat({ kind: 'sharding.RegionHeartbeat', region: PEER_REGION_PATH, node: known.toJSON() });
    harness.coordinator.onRegionHeartbeat({ kind: 'sharding.RegionHeartbeat', region: PEER_REGION_PATH, node: refused.toJSON() });

    expect(harness.coordinator.regions.get(keyOf(known))?.lastHeartbeatAtMs).not.toBeNull();
    expect(requestsTo(harness, known)).toEqual([]);
    expect(requestsTo(harness, refused)).toEqual([]);
  });

  test('the regions a predecessor knew are asked, except those already registered again', async () => {
    const harness = await startCoordinator('registration-requests-restart');
    const registered = stagePeer(harness, 'peer-registered');
    const seeded = stagePeer(harness, 'peer-seeded');
    const unknown = stagePeer(harness, 'peer-unknown');
    for (const [address, seededFromSnapshot] of [[registered, false], [seeded, true]] as const) {
      harness.coordinator.regions.set(keyOf(address), {
        node: address, path: PEER_REGION_PATH, proxy: false, shards: new Set(),
        lastSeenAtMs: 0, lastHeartbeatAtMs: null, seededFromSnapshot,
      });
    }

    harness.coordinator.onRequestRegistrations({
      kind: 'request-registrations',
      regions: [registered, seeded, unknown].map((address) => ({ path: PEER_REGION_PATH, node: address.toJSON() })),
    });

    expect(requestsTo(harness, registered)).toEqual([]);
    expect(requestsTo(harness, seeded)).toEqual([PEER_REGION_PATH]);
    expect(requestsTo(harness, unknown)).toEqual([PEER_REGION_PATH]);
  });
});
