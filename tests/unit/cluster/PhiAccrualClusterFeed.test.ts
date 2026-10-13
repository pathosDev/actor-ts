/**
 * #1451, #1452 — what the cluster feeds the φ-accrual detector, measured on two
 * real nodes rather than on the detector alone.
 *
 * φ models one thing: the inter-arrival times of a peer's heartbeats.  The
 * cluster used to hand it every inbound frame instead, and heartbeat and gossip
 * frames twice — once from `handleWire` and once more from the frame's own
 * handler, at the same instant.  Every such frame therefore recorded a 0 ms
 * sample.  The history described the traffic mix, not the peer: a first
 * heartbeat left a mean of 0, so a new peer read `down` some 700 ms after it
 * last spoke whatever the cadence was, and at a 1 s or 2 s cadence a healthy
 * peer joining at the wrong phase was downed and removed again every second.
 *
 * The contract now separates the two questions.  `heartbeat()` is a heartbeat
 * frame — one inter-arrival sample, measured heartbeat to heartbeat — and
 * `heardFrom()` is any frame: liveness, the instant silence is measured from,
 * never a sample.
 *
 * The harness is two nodes over `InMemoryTransport`, each on its own
 * `ManualScheduler`, advanced in lockstep in 10 ms steps, with B joining at a
 * chosen phase after A.  `acceptable-heartbeat-pause` is pinned to `0s` wherever
 * a case is about the feed: a pause is a pure offset added to every verdict, so
 * a non-zero one hides a collapsed history without fixing it.
 *
 * Every assertion is a first verdict or an absence, never an event count, so
 * how often one transition is announced (#1428) and what a `down` verdict does
 * to the member map are both beside the point here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import {
  MemberDown,
  MemberUnreachable,
  ReachabilityChanged,
  type ClusterEvent,
} from '../../../src/cluster/ClusterEvents.js';
import {
  createFailureDetector,
  defaultFailureDetectorOptions,
  type FailureDetectorLike,
} from '../../../src/cluster/FailureDetector.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberData, WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Config } from '../../../src/config/Config.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';

const SYSTEM = 'phi-feed';
const HOST = '10.0.145.1';
/** The lockstep resolution: both schedulers move this far, then the microtasks the move queued run. */
const STEP_MS = 10;
/** How long a healthy peer is watched for a verdict it should never get. */
const OBSERVATION_MS = 10_000;
/** `acceptable-heartbeat-pause` at zero: what the feed itself does, with no offset on top. */
const NO_PAUSE = 'phi.acceptable-heartbeat-pause = 0s';

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
  readonly scheduler: ManualScheduler;
  readonly transport: InMemoryTransport;
};

/** The private surface these tests reach through — the wire entry and the installed detector. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: WireMessage): void;
  readonly failureDetector: FailureDetectorLike;
}

const internals = (cluster: Cluster): ClusterInternals => cluster as unknown as ClusterInternals;

/** φ's own state, read where a case is about what the history holds rather than what it concludes. */
type PhiHistory = {
  readonly peers: Map<string, { readonly intervals: number[]; readonly intervalsCount: number }>;
};

const running: Node[] = [];
let nextPort = 41_451;

afterEach(async () => {
  for (const node of running.splice(0, running.length)) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

function phiHocon(cadenceMs: number, extra: string = NO_PAUSE): string {
  return `
    actor-ts.cluster.failure-detector {
      implementation     = phi
      heartbeat-interval = ${cadenceMs}ms
      ${extra}
    }
  `;
}

async function startNode(hocon: string, seeds: readonly NodeAddress[] = []): Promise<Node> {
  const port = nextPort++;
  const scheduler = new ManualScheduler();
  const address = new NodeAddress(SYSTEM, HOST, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(scheduler)
    .withConfig(Config.parseString(hocon));
  const system = ActorSystem.create(SYSTEM, systemOptions);
  const transport = new InMemoryTransport(address);
  const clusterOptions = ClusterOptions.create()
    .withHost(HOST)
    .withPort(port)
    .withTransport(transport)
    .withSeeds(seeds.map((seed) => seed.toString()));
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, address, scheduler, transport };
  running.push(node);
  return node;
}

/** One lockstep step's worth of delivery: every frame the move queued runs before the next one. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function advanceTogether(nodes: readonly Node[], ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
    for (const node of nodes) node.scheduler.advance(STEP_MS);
    await flush();
  }
}

/** A started alone, B joining it `offsetMs` later: the phase between their tick schedules. */
async function pairAtPhase(cadenceMs: number, offsetMs: number, extra?: string): Promise<{ a: Node; b: Node }> {
  const hocon = phiHocon(cadenceMs, extra);
  const a = await startNode(hocon);
  await advanceTogether([a], offsetMs);
  const b = await startNode(hocon, [a.address]);
  return { a, b };
}

type Verdict = { readonly what: string; readonly at: number };

/** Every verdict `observer` announces against `subject`: the three a healthy peer must never draw. */
function recordVerdictsAgainst(observer: Node, subject: NodeAddress): Verdict[] {
  const verdicts: Verdict[] = [];
  observer.cluster.subscribe((event: ClusterEvent) => {
    const at = observer.scheduler.now();
    if (event instanceof ReachabilityChanged && !event.reachable && event.address.equals(subject)) {
      verdicts.push({ what: 'ReachabilityChanged(false)', at });
    } else if (event instanceof MemberUnreachable && event.member.address.equals(subject)) {
      verdicts.push({ what: 'MemberUnreachable', at });
    } else if (event instanceof MemberDown && event.member.address.equals(subject)) {
      verdicts.push({ what: 'MemberDown', at });
    }
  });
  return verdicts;
}

/**
 * The first instant in `[from, to]` at which `holds` is true, or `undefined`.
 * Binary search, because every predicate here is monotonic in time: φ only
 * rises while nothing arrives.
 */
function firstInstant(holds: (now: number) => boolean, from: number, to: number): number | undefined {
  if (!holds(to)) return undefined;
  let low = from;
  let high = to;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (holds(middle)) high = middle; else low = middle + 1;
  }
  return low;
}

/**
 * Silence until φ first leaves `healthy`, on a detector that saw nothing but a
 * clean series at `cadenceMs` — the yardstick a peer whose history was not
 * collapsed by traffic is measured against.
 */
function cleanSeriesCrossing(cadenceMs: number): number {
  const reference = createFailureDetector(
    'phi',
    { ...defaultFailureDetectorOptions, heartbeatIntervalMs: cadenceMs },
    { acceptableHeartbeatPauseMs: 0 },
  );
  const peer = new NodeAddress(SYSTEM, HOST, 1);
  const beats = 20;
  for (let beat = 0; beat <= beats; beat++) reference.heartbeat(peer, beat * cadenceMs);
  const last = beats * cadenceMs;
  const crossing = firstInstant((now) => reference.decide(peer, now) !== 'healthy', last, last + 60_000);
  if (crossing === undefined) throw new Error('the reference detector never left healthy');
  return crossing - last;
}

function selfRecord(peer: NodeAddress): MemberData {
  return { address: peer.toJSON(), status: 'up', version: Date.now(), roles: [] };
}

describe('what one inbound frame credits', () => {
  type Credit = { readonly method: 'heartbeat' | 'heardFrom'; readonly peer: string };

  /** Wrap the installed detector's two inputs, so every credit is seen with the peer it named. */
  function recordCredits(detector: FailureDetectorLike): Credit[] {
    const credits: Credit[] = [];
    const heartbeat = detector.heartbeat.bind(detector);
    const heardFrom = detector.heardFrom.bind(detector);
    detector.heartbeat = (peer, now) => {
      credits.push({ method: 'heartbeat', peer: peer.toString() });
      heartbeat(peer, now);
    };
    detector.heardFrom = (peer, now) => {
      credits.push({ method: 'heardFrom', peer: peer.toString() });
      heardFrom(peer, now);
    };
    return credits;
  }

  test('a heartbeat frame is one liveness credit and one sample; every other frame is liveness only', async () => {
    const node = await startNode(phiHocon(500));
    const peer = new NodeAddress(SYSTEM, HOST, nextPort++);
    const third = new NodeAddress(SYSTEM, HOST, nextPort++);
    const credits = recordCredits(internals(node.cluster).failureDetector);
    const deliver = (message: WireMessage): Credit[] => {
      credits.length = 0;
      internals(node.cluster).handleWire(peer, message);
      return [...credits];
    };
    const liveness: Credit = { method: 'heardFrom', peer: peer.toString() };
    const sample: Credit = { method: 'heartbeat', peer: peer.toString() };

    expect(deliver({ kind: 'gossip', from: peer.toJSON(), sequence: 1, members: [selfRecord(peer)] }))
      .toEqual([liveness]);
    expect(deliver({ kind: 'heartbeat', from: peer.toJSON(), seq: 1, ts: Date.now() }))
      .toEqual([liveness, sample]);
    // The acknowledgment of *our* heartbeat arrives on our cadence, not the
    // peer's: sampled beside its heartbeats it would interleave two schedules.
    expect(deliver({ kind: 'heartbeat-ack', from: peer.toJSON(), seq: 1 })).toEqual([liveness]);
    // Refused frames are still bytes that arrived on the connection.
    expect(deliver({ kind: 'heartbeat', from: peer.toJSON(), seq: -1, ts: Date.now() })).toEqual([liveness]);
    expect(deliver({ kind: 'gossip', from: peer.toJSON(), sequence: 1, members: [] })).toEqual([liveness]);
    // A frame of a kind nothing claims is still traffic from the peer.
    expect(deliver({ kind: 'not-a-core-kind' } as unknown as WireMessage)).toEqual([liveness]);
    // The payload's `from` is a claim, not the connection: it credits no one.
    expect(deliver({ kind: 'gossip', from: third.toJSON(), sequence: 2, members: [] })).toEqual([liveness]);
  });
});

describe('a healthy peer is never flagged, at any phase (acceptable-heartbeat-pause = 0s)', () => {
  /**
   * Both directions: A about the peer that joined it, and B about the seed it
   * registered before anything had arrived from it — the two start from
   * different first contacts, and a defect in either one's origin shows only
   * on its own side.
   */
  async function verdictsOverObservation(cadenceMs: number, offsetMs: number): Promise<Verdict[]> {
    const { a, b } = await pairAtPhase(cadenceMs, offsetMs);
    const aboutB = recordVerdictsAgainst(a, b.address);
    const aboutA = recordVerdictsAgainst(b, a.address);
    await advanceTogether([a, b], OBSERVATION_MS);
    return [
      ...aboutB.map((verdict) => ({ ...verdict, what: `A about B: ${verdict.what}` })),
      ...aboutA.map((verdict) => ({ ...verdict, what: `B about A: ${verdict.what}` })),
    ];
  }

  // The phases that drew a verdict before the feed was split: at a 1 s cadence
  // B joining 200 ms after A was downed and removed every second, and 400 ms
  // after A it was marked unreachable.
  test.each([200, 400])('1 s cadence, B joining %d ms after A', async (offsetMs) => {
    expect(await verdictsOverObservation(1_000, offsetMs)).toEqual([]);
  }, 30_000);

  test.each([0, 150, 300, 450])('500 ms cadence, B joining %d ms after A', async (offsetMs) => {
    expect(await verdictsOverObservation(500, offsetMs)).toEqual([]);
  }, 30_000);

  test.each([0, 600, 1_000, 1_200, 1_400, 1_800])('2 s cadence, B joining %d ms after A', async (offsetMs) => {
    expect(await verdictsOverObservation(2_000, offsetMs)).toEqual([]);
  }, 30_000);
});

describe('traffic does not reach the history (acceptable-heartbeat-pause = 0s)', () => {
  test('300 acknowledgments at one instant, then death: the verdict still waits for the clean-series crossing', async () => {
    const cadenceMs = 500;
    const { a, b } = await pairAtPhase(cadenceMs, 130);
    const verdicts = recordVerdictsAgainst(a, b.address);
    // Half a cadence off B's schedule, so the burst is the last thing A hears
    // and not a heartbeat that happens to share its instant: what holds the
    // verdict back below has to be the burst's liveness.
    await advanceTogether([a, b], 6_000 + cadenceMs / 2);
    expect(verdicts).toEqual([]);

    const burstAt = a.scheduler.now();
    for (let seq = 0; seq < 300; seq++) {
      internals(a.cluster).handleWire(b.address, { kind: 'heartbeat-ack', from: b.address.toJSON(), seq });
    }
    // B dies at the same instant: from here on nothing of it reaches A.
    await b.transport.shutdown();
    const detector = internals(a.cluster).failureDetector;
    const cleanCrossing = cleanSeriesCrossing(cadenceMs);

    // Before the split the burst left 200 samples of 0 ms, and B read `down`
    // 704 ms after the burst.
    expect(detector.decide(b.address, burstAt + 800)).toBe('healthy');
    const firstVerdictAt = firstInstant(
      (now) => detector.decide(b.address, now) !== 'healthy', burstAt, burstAt + 60_000,
    );
    expect(firstVerdictAt).toBeDefined();
    expect(firstVerdictAt! - burstAt).toBeGreaterThanOrEqual(cleanCrossing);

    // And the cluster acts on it no earlier either: its first verdict lands on
    // a detection tick at or after the clean-series crossing.
    await advanceTogether([a], 3_000);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts[0]!.at - burstAt).toBeGreaterThanOrEqual(cleanCrossing);
  }, 30_000);

  test.each([500, 1_000])('the history is heartbeat to heartbeat at a %d ms cadence: no sample below half of it', async (cadenceMs) => {
    const { a, b } = await pairAtPhase(cadenceMs, 130);
    await advanceTogether([a, b], OBSERVATION_MS);

    const history = (internals(a.cluster).failureDetector as unknown as PhiHistory).peers.get(b.address.toString());
    expect(history).toBeDefined();
    const samples = history!.intervals.slice(0, history!.intervalsCount);
    // Enough of a history that "none below half" is a statement about it.
    expect(samples.length).toBeGreaterThanOrEqual(OBSERVATION_MS / cadenceMs / 2);
    expect(samples.filter((sample) => sample < cadenceMs / 2)).toEqual([]);
  }, 30_000);
});

describe('the shipped settings, end to end (#1452)', () => {
  test('a healthy pair draws no verdict; a dead peer is flagged on the first detection tick after the crossing', async () => {
    const cadenceMs = defaultFailureDetectorOptions.heartbeatIntervalMs;
    // No pause override: the shipped 3 s, with everything else shipped too.
    const { a, b } = await pairAtPhase(cadenceMs, 130, '');
    const aboutB = recordVerdictsAgainst(a, b.address);
    const aboutA = recordVerdictsAgainst(b, a.address);
    await advanceTogether([a, b], OBSERVATION_MS);
    expect([...aboutB, ...aboutA]).toEqual([]);

    // B dies.  Silence runs from the last frame A received from it.
    await b.transport.shutdown();
    const detector = internals(a.cluster).failureDetector;
    const lastSeen = detector.lastSeen(b.address);
    expect(lastSeen.isSome()).toBe(true);
    const lastFrameAt = lastSeen.isSome() ? lastSeen.value : 0;
    const crossingAt = firstInstant(
      (now) => detector.decide(b.address, now) !== 'healthy', lastFrameAt, lastFrameAt + 60_000,
    );
    expect(crossingAt).toBeDefined();
    // The clean-series crossing at shipped settings: ~4 062 ms of silence.
    expect(crossingAt! - lastFrameAt).toBeGreaterThanOrEqual(4_052);
    expect(crossingAt! - lastFrameAt).toBeLessThanOrEqual(4_072);

    await advanceTogether([a], 6_000);
    // A's detection tick runs every cadence from its start, so the first one
    // at or after the crossing is where the verdict has to land.
    const firstTickAfterCrossing = Math.ceil(crossingAt! / cadenceMs) * cadenceMs;
    expect(aboutB.length).toBeGreaterThan(0);
    expect(aboutB[0]!.at).toBe(firstTickAfterCrossing);
  }, 30_000);
});

describe('a member learned of through gossip and never heard from (acceptable-heartbeat-pause = 0s)', () => {
  /**
   * One node; B is an `up` member with standing, and C exists only as the
   * record B gossips about it — registered by the merge, never heard from.
   * Returns how long after the registration the node first flagged C.
   */
  async function flaggedAfterRegistration(implementation: 'simple' | 'phi'): Promise<number | undefined> {
    const node = await startNode(`
      actor-ts.cluster.failure-detector {
        implementation = ${implementation}
        ${NO_PAUSE}
      }
    `);
    const vouching = new NodeAddress(SYSTEM, HOST, nextPort++);
    const neverHeard = new NodeAddress(SYSTEM, HOST, nextPort++);
    const wire = internals(node.cluster);
    wire.handleWire(vouching, { kind: 'gossip', from: vouching.toJSON(), sequence: 1, members: [selfRecord(vouching)] });
    const verdicts = recordVerdictsAgainst(node, neverHeard);
    wire.handleWire(vouching, { kind: 'gossip', from: vouching.toJSON(), sequence: 2, members: [selfRecord(neverHeard)] });
    const registeredAt = node.scheduler.now();
    for (let beat = 1; beat <= 20 && verdicts.length === 0; beat++) {
      wire.handleWire(vouching, { kind: 'heartbeat', from: vouching.toJSON(), seq: beat, ts: Date.now() });
      await advanceTogether([node], 500);
    }
    return verdicts.length > 0 ? verdicts[0]!.at - registeredAt : undefined;
  }

  test('φ judges it from the registration with the first-contact estimate, as the simple detector always has', async () => {
    // It used to answer 0 for a peer it had never heard from — healthy an
    // hour later — while the simple detector flagged it two seconds in.
    const simple = await flaggedAfterRegistration('simple');
    const phi = await flaggedAfterRegistration('phi');

    expect(simple).toBeDefined();
    expect(simple!).toBeGreaterThanOrEqual(defaultFailureDetectorOptions.unreachableAfterMs);
    expect(phi).toBeDefined();
    // E = 500 ms with a deviation of 125 ms crosses at ~1 202 ms; the verdict
    // lands on the first detection tick after it.
    expect(phi!).toBeGreaterThanOrEqual(1_192);
    expect(phi!).toBeLessThanOrEqual(1_202 + defaultFailureDetectorOptions.heartbeatIntervalMs);
  }, 30_000);
});

describe('a third party naming a crashed member does not keep it alive (#939)', () => {
  /**
   * One node, with a third party B and a member C that crashes, both existing
   * only as frames injected with an explicit connection peer.  B keeps
   * heartbeating; in the attacked run it also gossips once per interval with a
   * payload `from` naming C.  Returns when C was first flagged, and whether a
   * frame naming C moved what the detector remembers of it.
   */
  async function firstVerdictOnCrashedMember(
    implementation: 'simple' | 'phi',
    thirdPartyNamesCrashed: boolean,
  ): Promise<{ readonly flaggedAfterCrashMs: number | undefined; readonly lastSeenMoved: boolean }> {
    const node = await startNode(`
      actor-ts.cluster.failure-detector {
        implementation = ${implementation}
        ${NO_PAUSE}
      }
    `);
    const thirdParty = new NodeAddress(SYSTEM, HOST, nextPort++);
    const crashed = new NodeAddress(SYSTEM, HOST, nextPort++);
    const wire = internals(node.cluster);
    let gossipSequence = 0;
    const gossipFrom = (peer: NodeAddress, named: NodeAddress, members: MemberData[]): void => {
      gossipSequence += 1;
      wire.handleWire(peer, { kind: 'gossip', from: named.toJSON(), sequence: gossipSequence, members });
    };
    let heartbeatSequence = 0;
    const heartbeatFrom = (peer: NodeAddress): void => {
      heartbeatSequence += 1;
      wire.handleWire(peer, { kind: 'heartbeat', from: peer.toJSON(), seq: heartbeatSequence, ts: Date.now() });
    };

    gossipFrom(thirdParty, thirdParty, [selfRecord(thirdParty)]);
    gossipFrom(crashed, crashed, [selfRecord(crashed)]);
    const verdicts = recordVerdictsAgainst(node, crashed);
    for (let beat = 0; beat < 4; beat++) {
      heartbeatFrom(thirdParty);
      heartbeatFrom(crashed);
      await advanceTogether([node], 500);
    }
    const crashedAt = node.scheduler.now();
    const lastSeenAtCrash = wire.failureDetector.lastSeen(crashed);
    let lastSeenMoved = false;
    for (let elapsed = 0; elapsed < 8_000; elapsed += 500) {
      heartbeatFrom(thirdParty);
      if (thirdPartyNamesCrashed) {
        gossipFrom(thirdParty, crashed, [selfRecord(thirdParty)]);
        const lastSeen = wire.failureDetector.lastSeen(crashed);
        if (lastSeen.isSome() && lastSeenAtCrash.isSome() && lastSeen.value !== lastSeenAtCrash.value) {
          lastSeenMoved = true;
        }
      }
      await advanceTogether([node], 500);
      if (verdicts.length > 0) break;
    }
    return {
      flaggedAfterCrashMs: verdicts.length > 0 ? verdicts[0]!.at - crashedAt : undefined,
      lastSeenMoved,
    };
  }

  test.each(['simple', 'phi'] as const)('%s: flagged on schedule, and the naming frames touch nothing', async (implementation) => {
    const quiet = await firstVerdictOnCrashedMember(implementation, false);
    const attacked = await firstVerdictOnCrashedMember(implementation, true);

    expect(quiet.flaggedAfterCrashMs).toBeDefined();
    expect(attacked.lastSeenMoved).toBe(false);
    expect(attacked.flaggedAfterCrashMs).toBe(quiet.flaggedAfterCrashMs);
  }, 30_000);
});
