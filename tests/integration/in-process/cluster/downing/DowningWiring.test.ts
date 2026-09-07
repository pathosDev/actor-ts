/**
 * Wiring tests for #61 — DowningProvider plugged into Cluster
 * failure-detection.  Covers:
 *
 *   1. Without `downing` configured: existing heartbeat-only behaviour
 *      stays unchanged (regression guard) — the detector still evicts
 *      the peer itself once `downAfterMs` elapses.
 *   2. Custom DowningProvider gets called on partition view changes,
 *      its decision is applied (members force-downed regardless of
 *      failure-detector elapsed-time state).
 *   3. Self-down — provider asking us to down ourselves triggers
 *      `cluster.leave()`.
 *   4. Throwing provider doesn't crash the cluster (error logged,
 *      no decision applied).
 *   5. With `downing` configured the detector evicts *nothing*: it parks
 *      the peer at `unreachable` and leaves the transition to
 *      `down`/`removed` to the resolver (#929).
 *   6. …and keeps re-asking the resolver past `downAfterMs`, which is what
 *      makes an asynchronous strategy (`LeaseMajority`) and a stability
 *      window (#839) possible at all.
 *   7. The stability window itself (#839), in its own `describe`: the provider
 *      is not consulted while the view is still moving, a settled partition is
 *      still resolved and no earlier than the window, and
 *      `down-all-when-unstable` escalates only when it is switched on.
 *
 * Tests 1, 5 and 6 deliberately run *past* `downAfterMs`, which is the
 * opposite of what the rest of this file does: 2, 3 and 4 keep the
 * detector's own eviction out of the picture by setting a `downAfterMs`
 * their assertions cannot reach.  A guard about what happens after
 * `down-after` has to cross it, so those three carry their own short
 * detector timings rather than the shared 4 s one.
 *
 * The strategies themselves (KeepMajority etc.) are pure-function
 * tested elsewhere; this file exercises the wiring path only with
 * a hand-rolled deterministic stub provider.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { addrKey } from '../../../../../src/cluster/downing/index.js';
import type {
  ClusterPartitionView,
  DowningProvider,
} from '../../../../../src/cluster/downing/index.js';
import type { SplitBrainResolverOptionsType } from '../../../../../src/cluster/downing/index.js';
import { unstableEscalationDeadlineMs } from '../../../../../src/cluster/downing/index.js';
import type { FailureDetectorOptionsType } from '../../../../../src/cluster/FailureDetectorOptions.js';
import { Member } from '../../../../../src/cluster/Member.js';
import type { GossipMessage } from '../../../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

/**
 * Both partition tests assert that the seed *saw* the peer go
 * unreachable.  That transition is driven by the failure detector's
 * `unreachableAfterMs`, which the tests explicitly say they are not
 * measuring — so wait for the status rather than for a wall clock that
 * has to out-run a loaded event loop (#418).
 */
function awaitUnreachable(node: Node, what: string): Promise<void> {
  return awaitCondition(
    () => node.cluster.getMembers().some((m) => m.status === 'unreachable'),
    { timeoutMs: 4_000, intervalMs: 25, label: `${what}: the peer was marked unreachable` },
  );
}

/**
 * Kept as a name so every call site here stays unchanged; the body forwards to
 * the shared helper (#418), and the local `sleep` shim that drove the old
 * deadline loop went with it.
 */
const waitFor = (
  predicate: () => boolean,
  timeoutMs = 3_000,
  stepMs = 25,
  label = 'the awaited downing/membership state',
): Promise<void> => awaitCondition(predicate, { timeoutMs, intervalMs: stepMs, label });

type Node = {
  sys: ActorSystem;
  cluster: Cluster;
};

/**
 * The detector timings the tests that must *not* reach `down-after` use.
 * 4 s is out of reach of every assertion in those tests, which is the point:
 * whatever they observe was the resolver's doing, not the detector's.
 */
const SLOW_EVICTION: FailureDetectorOptionsType = {
  heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 4_000,
};

/**
 * …and the timings for the tests that must cross it.  600 ms is short enough
 * that a test can watch the whole `unreachable-after` → `down-after` sequence
 * play out and still keep a wide margin under Bun's per-test budget.
 */
const FAST_EVICTION: FailureDetectorOptionsType = {
  heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 600,
};

/**
 * Every test outside the `#839` block predates the stability window and was
 * written against a resolver consulted on the first tick that saw a partition.
 * The shipped 20 s window would make every one of them time out, so the shared
 * fixture pins a window shorter than a single failure-detector round: these
 * tests are about the wiring, and the window has its own `describe` below.
 */
const NO_STABILITY_WINDOW: Partial<SplitBrainResolverOptionsType> = { stableAfterMs: 1 };

async function startNode(
  systemName: string, port: number, options: {
    seeds?: string[];
    downing?: DowningProvider;
    failureDetector?: FailureDetectorOptionsType;
    splitBrainResolver?: Partial<SplitBrainResolverOptionsType>;
  } = {},
): Promise<Node> {
  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create(systemName, sysOptions);
  let clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withFailureDetector(options.failureDetector ?? SLOW_EVICTION)
    .withSplitBrainResolver(options.splitBrainResolver ?? NO_STABILITY_WINDOW)
    .withGossipIntervalMs(80);
  if (options.seeds !== undefined) clusterOptions = clusterOptions.withSeeds(options.seeds);
  if (options.downing !== undefined) clusterOptions = clusterOptions.withDowning(options.downing);
  const cluster = await Cluster.join(sys, clusterOptions);
  return { sys, cluster };
}

/**
 * Introduce one member nobody is listening on, as a third-party claim from a
 * live peer (which `maySpeakFor` admits because that peer is `up`).
 *
 * It is the cheapest legal source of view churn there is, and it produces
 * exactly the two conditions `down-all-when-unstable` reacts to: every call
 * moves the fingerprint, and `mergeMember` registers the address with the
 * failure detector, so each phantom becomes `unreachable` a round later and
 * the unreachable set is never empty.  The alternative — starting and killing
 * real nodes on a 60 ms cadence — measures the same thing and spends a second
 * of wall clock doing it.
 */
function introducePhantom(from: Node, to: Node, systemName: string, port: number): void {
  const phantom = new Member(new NodeAddress(systemName, 'h', port), 'up', Date.now(), new Set());
  const frame: GossipMessage = {
    kind: 'gossip',
    from: from.cluster.selfAddress.toJSON(),
    sequence: Date.now(),
    members: [phantom.toData()],
  };
  from.cluster.transport.send(to.cluster.selfAddress, frame);
}

async function stop(n: Node): Promise<void> {
  try { await n.cluster.leave(); } catch { /* may already be left */ }
  await n.sys.terminate();
}

describe('Cluster + DowningProvider — wiring', () => {
  test('without downing: the detector still evicts the peer itself (regression)', async () => {
    const sysName = 'no-down';
    const seed = await startNode(sysName, 64_001, { failureDetector: FAST_EVICTION });
    const peer = await startNode(sysName, 64_002, {
      seeds: [`${sysName}@h:64001`], failureDetector: FAST_EVICTION,
    });

    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);
    const peerKey = peer.cluster.selfAddress.toString();

    // Crash the peer's transport → seed sees it unreachable, then down via FD.
    await peer.cluster.transport.shutdown();
    await awaitUnreachable(seed, 'no downing provider');

    // This used to stop at `unreachable` with a 4 s `downAfterMs` the test
    // could not reach, so the half it was named for — that the detector on
    // its own carries a silent peer all the way out of the membership table —
    // was asserted by nothing.  #929 changes exactly that disposition for the
    // *other* branch, so this one now has to be pinned.
    await waitFor(
      () => !seed.cluster.getMembers().some((m) => m.address.toString() === peerKey),
      3_000,
      25,
      'the detector evicted the peer with no downing provider configured',
    );
    expect(seed.cluster.upMembers().length).toBe(1);

    await stop(seed);
    await peer.sys.terminate();
  }, 10_000);

  test('downing provider invoked on partition; decision applied (others)', async () => {
    const sysName = 'down-others';
    let invocations = 0;
    let lastView: ClusterPartitionView | null = null;
    const provider: DowningProvider = {
      decide(view) {
        invocations++;
        // Force-down anything we see as unreachable.
        const toDown = new Set(view.allMembers
          .filter((m) => view.unreachable.has(addrKey(m)))
          .map(addrKey));
        // The view the DECISION was made on, not merely the last one seen.
        // The tick after an eviction lands legitimately shows a healed
        // cluster, so which of the two a bare `lastView = view` ends up
        // holding depends only on when the poll below happened to return.
        if (toDown.size > 0) lastView = view;
        return toDown;
      },
    };

    const seed = await startNode(sysName, 64_011, { downing: provider });
    const peer = await startNode(sysName, 64_012, { seeds: [`${sysName}@h:64011`] });
    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);

    // Reset counter — initial join may have fingerprint changes that
    // legitimately invoke decide() before the partition.
    invocations = 0;
    const peerKey = peer.cluster.selfAddress.toString();

    // Crash peer → seed marks it unreachable → provider decides to down it.
    await peer.cluster.transport.shutdown();

    // Provider should fire and force a down/removed transition long
    // before the FD's downAfterMs (4s) would.  Waited on the *eviction* and
    // not on `upMembers().length === 1`, which the `unreachable` transition
    // satisfies on its own a tick or two earlier — so the old wait could
    // return before the resolver had been consulted at all and the
    // assertions below would then be about a race rather than about downing.
    await waitFor(
      () => !seed.cluster.getMembers().some((m) => m.address.toString() === peerKey),
      2_000,
      25,
      'the provider\'s decision was applied',
    );
    expect(seed.cluster.upMembers().length).toBe(1);
    expect(invocations).toBeGreaterThan(0);
    expect(lastView).not.toBeNull();
    expect(lastView!.unreachable.size).toBeGreaterThan(0);

    await stop(seed);
    await peer.sys.terminate();
  }, 10_000);

  test('downing provider asking for self-down triggers cluster.leave', async () => {
    const sysName = 'down-self';
    const provider: DowningProvider = {
      decide(view) {
        if (view.unreachable.size > 0) {
          // Down ourselves.
          return new Set([view.self.toString()]);
        }
        return new Set();
      },
    };

    const seed = await startNode(sysName, 64_021, { downing: provider });
    const peer = await startNode(sysName, 64_022, { seeds: [`${sysName}@h:64021`] });
    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);

    // Crash peer so seed sees an unreachable, provider decides to
    // self-down on seed.  `leave()` runs internally — the seed's
    // own membership status flips to 'leaving' and the timers stop.
    await peer.cluster.transport.shutdown();

    await waitFor(() => {
      const me = seed.cluster.getMembers().find(
        (m) => m.address.equals(seed.cluster.selfAddress),
      );
      // After `leave()` runs, self is either marked 'leaving' or has
      // been GC'd from the members map entirely (downing path
      // depending on race).
      return !me || me.status === 'leaving' || me.status === 'removed';
    }, 5_000);

    await seed.sys.terminate();
    await peer.sys.terminate();
  }, 15_000);

  test('downing provider that throws — error logged, cluster keeps running', async () => {
    const sysName = 'down-throws';
    const provider: DowningProvider = {
      decide() { throw new Error('boom'); },
    };

    const seed = await startNode(sysName, 64_031, { downing: provider });
    const peer = await startNode(sysName, 64_032, { seeds: [`${sysName}@h:64031`] });
    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);

    await peer.cluster.transport.shutdown();
    // Even though provider throws, the cluster keeps running — peer
    // stays unreachable but is not force-downed (no decision applied).
    //
    // This assertion used to race: `awaitUnreachable` has a 4 s budget and
    // the fixture's `downAfterMs` was also 4 s, so a slow poll could read
    // the map after the detector had already deleted the peer and the test
    // would fail on a state the fix was not about.  Since #929 a configured
    // provider — including one that only ever throws — stops the detector
    // evicting, so `unreachable` is now a terminal state here rather than a
    // 3 s sliver, and the race is gone.
    await awaitUnreachable(seed, 'throwing downing provider');
    expect(seed.cluster.getMembers().some((m) => m.status === 'unreachable')).toBe(true);
    // We're still alive.
    expect(seed.cluster.upMembers().length).toBeGreaterThanOrEqual(1);

    await stop(seed);
    await peer.sys.terminate();
  }, 10_000);

  test('with downing: the detector parks the peer at unreachable and evicts nothing', async () => {
    const sysName = 'down-parks';
    let sawUnreachable = 0;
    const provider: DowningProvider = {
      decide(view) {
        if (view.unreachable.size > 0) sawUnreachable++;
        // Never decides.  A real strategy below quorum answers exactly this
        // (`KeepMajority` on a minority side that cannot reach `needed`), and
        // `LeaseMajority` answers it on every tick while its acquire is in
        // flight — so "the resolver has not answered yet" must not be a
        // window the detector is allowed to close behind its back.
        return new Set();
      },
    };

    const seed = await startNode(sysName, 64_041, {
      downing: provider, failureDetector: FAST_EVICTION,
    });
    const peer = await startNode(sysName, 64_042, {
      seeds: [`${sysName}@h:64041`], failureDetector: FAST_EVICTION,
    });
    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);
    const peerKey = peer.cluster.selfAddress.toString();

    await peer.cluster.transport.shutdown();
    await awaitUnreachable(seed, 'a provider that never decides');
    const parkedVersion = seed.cluster.getMembers()
      .find((m) => m.address.toString() === peerKey)!.version;

    // A bare sleep, deliberately: the thing under test is that nothing
    // happens for the rest of a window the detector used to act inside.  The
    // wait is 3x `downAfterMs` past a peer that is already `unreachable`, so
    // every subsequent tick decides `down` — roughly 36 of them at the
    // fixture's 50 ms interval.
    await sleep(FAST_EVICTION.downAfterMs * 3);

    const parked = seed.cluster.getMembers().find((m) => m.address.toString() === peerKey);
    expect(parked).toBeDefined();
    expect(parked!.status).toBe('unreachable');
    expect(seed.cluster.upMembers().length).toBe(1);
    // The park is idempotent.  Re-marking an already-`unreachable` member
    // would mint a new `Member` on every tick, and `withStatus` bumps
    // `version` — the gossip merge clock — so a peer nobody can reach would
    // climb the clock forever and win every merge it appeared in.
    expect(parked!.version).toBe(parkedVersion);
    // Not vacuous: the resolver really was consulted about a live partition.
    expect(sawUnreachable).toBeGreaterThan(0);

    await stop(seed);
    await peer.sys.terminate();
  }, 15_000);

  test('with downing: a silent member that was never `up` is parked too', async () => {
    const sysName = 'down-parks-leaving';
    const provider: DowningProvider = { decide: () => new Set() };

    const seed = await startNode(sysName, 64_071, {
      downing: provider, failureDetector: FAST_EVICTION,
    });
    const peer = await startNode(sysName, 64_072, {
      seeds: [`${sysName}@h:64071`], failureDetector: FAST_EVICTION,
    });
    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);
    const peerKey = peer.cluster.selfAddress.toString();
    const viewOfPeer = () => seed.cluster.getMembers().find((m) => m.address.toString() === peerKey);

    // Put the peer at `leaving` in the seed's map and leave it there.  This is
    // the state a node reaches by announcing its shutdown in gossip and then
    // dying before its `leave` frame lands — `onLeave` tombstones on that
    // frame, so `leaving` only persists when the frame never arrives.  It is
    // the reachable member of the class the re-mark exists for: the detector's
    // `unreachable` arm fires only for a member that is `up`, so `leaving`,
    // `joining` and `weakly-up` all arrive at `down-after` unmarked.
    //
    // A member speaking for itself always clears `maySpeakFor`, so the frame
    // needs no privilege; the sequence only has to out-number the peer's own
    // counter (seeded from its wall-clock) while staying inside
    // `maxVersionSkewMs`, which 60 s does on both counts.
    const leavingFrame: GossipMessage = {
      kind: 'gossip',
      from: peer.cluster.selfAddress.toJSON(),
      sequence: Date.now() + 60_000,
      members: [viewOfPeer()!.withStatus('leaving').toData()],
    };
    peer.cluster.transport.send(seed.cluster.selfAddress, leavingFrame);
    await waitFor(() => viewOfPeer()?.status === 'leaving', 2_000, 10,
      'the seed merged the peer at `leaving`');

    await peer.cluster.transport.shutdown();
    // A bare wait, for the same reason as the test above: the assertion is an
    // absence — that no tick past `down-after` evicted the member — and a poll
    // for an absence returns on its first call having checked nothing.
    await sleep(FAST_EVICTION.downAfterMs * 3);

    const parked = viewOfPeer();
    expect(parked).toBeDefined();
    // Not `leaving`: a `leaving` member is a *candidate* for every bundled
    // strategy but is absent from `view.unreachable`, so leaving it unmarked
    // would have it counted on the reachable side of a partition it is not on.
    expect(parked!.status).toBe('unreachable');

    await stop(seed);
    await peer.sys.terminate();
  }, 15_000);

  test('with downing: the resolver is still asked after down-after has elapsed', async () => {
    const sysName = 'down-late';
    let invocationsWithPartition = 0;
    let partitionSeenAt = 0;
    let decidedAt = 0;
    // A resolver that needs longer than `down-after` to make up its mind.
    // That is the ordinary case rather than a pathological one: on the
    // reference timings `LeaseMajority`'s acquire budget (5 s) is exactly
    // `down-after`, so its arbitration could never finish inside the window
    // the detector used to leave open.  Keyed off the clock rather than an
    // invocation count so the threshold cannot drift with the tick rate.
    const thinkingTimeMs = FAST_EVICTION.downAfterMs * 2;
    const provider: DowningProvider = {
      decide(view) {
        if (view.unreachable.size === 0) return new Set();
        invocationsWithPartition++;
        if (partitionSeenAt === 0) partitionSeenAt = Date.now();
        if (Date.now() - partitionSeenAt < thinkingTimeMs) return new Set();
        decidedAt = Date.now();
        return new Set(view.allMembers
          .filter((m) => view.unreachable.has(addrKey(m)))
          .map(addrKey));
      },
    };

    const seed = await startNode(sysName, 64_051, {
      downing: provider, failureDetector: FAST_EVICTION,
    });
    const peer = await startNode(sysName, 64_052, {
      seeds: [`${sysName}@h:64051`], failureDetector: FAST_EVICTION,
    });
    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);
    const peerKey = peer.cluster.selfAddress.toString();

    const shutdownAt = Date.now();
    await peer.cluster.transport.shutdown();
    await waitFor(
      () => !seed.cluster.getMembers().some((m) => m.address.toString() === peerKey),
      6_000,
      25,
      'the late decision was applied',
    );

    // Re-asked, not asked once and cached: `lastDownedView` is only written
    // when a decision is *applied*, so an undecided view is put to the
    // provider again on every tick.
    expect(invocationsWithPartition).toBeGreaterThan(1);
    // The load-bearing assertion: the decision landed on the far side of
    // `down-after` measured from the moment the peer fell silent — the
    // instant at which the detector used to delete it and hand the resolver
    // a view that read as a healed cluster.
    expect(decidedAt - shutdownAt).toBeGreaterThan(FAST_EVICTION.downAfterMs);

    await stop(seed);
    await peer.sys.terminate();
  }, 20_000);
});

/**
 * The stability window and the unstable escalation (#839).
 *
 * Timings are scaled down by roughly two orders of magnitude from the shipped
 * ones (`stable-after = 20s`) so a test can watch a whole window elapse.  The
 * *ratios* are what the assertions rest on — the window is many detector
 * rounds long, and the escalation deadline is
 * {@link unstableEscalationDeadlineMs} of the window — and those are the
 * shipped ones.
 */
describe('Cluster + DowningProvider — the stability window (#839)', () => {
  /**
   * A detector fast enough that a test can see a partition inside one window,
   * and a `down-after` the resolver's presence makes inert anyway (#929).
   */
  const WINDOW_EVICTION: FailureDetectorOptionsType = {
    heartbeatIntervalMs: 40, unreachableAfterMs: 160, downAfterMs: 400,
  };

  test('the provider is not consulted while the view is still moving', async () => {
    const sysName = 'window-suppresses';
    let invocations = 0;
    // Would down every unreachable member the instant it were asked, so the
    // only thing standing between the partition below and an eviction is the
    // window.
    const provider: DowningProvider = {
      decide(view) {
        invocations++;
        return new Set(view.allMembers
          .filter((m) => view.unreachable.has(addrKey(m)))
          .map(addrKey));
      },
    };

    const seed = await startNode(sysName, 64_081, {
      downing: provider,
      failureDetector: WINDOW_EVICTION,
      splitBrainResolver: { stableAfterMs: 4_000 },
    });
    const peer = await startNode(sysName, 64_082, {
      seeds: [`${sysName}@h:64081`], failureDetector: WINDOW_EVICTION,
    });
    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);
    const peerKey = peer.cluster.selfAddress.toString();

    // Reset AFTER the join has settled: forming a cluster moves the view
    // several times, and each of those legitimately restarts the window.
    invocations = 0;
    await peer.cluster.transport.shutdown();
    await awaitUnreachable(seed, 'a partition inside the stability window');

    // A bare sleep, deliberately: the assertion is an absence.  ~30 detector
    // ticks pass inside a 4 s window, and before this change every one of them
    // put the view to the provider — the counter is the difference between
    // "the window suppressed it" and "nothing happened to be scheduled".
    await sleep(1_200);

    expect(invocations).toBe(0);
    const parked = seed.cluster.getMembers().find((m) => m.address.toString() === peerKey);
    expect(parked?.status).toBe('unreachable');
    expect(seed.cluster.upMembers().length).toBe(1);

    await stop(seed);
    await peer.sys.terminate();
  }, 15_000);

  test('a settled partition still resolves, and no earlier than the window', async () => {
    const sysName = 'window-resolves';
    const STABLE_AFTER_MS = 900;
    let decidedAt = 0;
    const provider: DowningProvider = {
      decide(view) {
        if (view.unreachable.size === 0) return new Set();
        decidedAt = Date.now();
        return new Set(view.allMembers
          .filter((m) => view.unreachable.has(addrKey(m)))
          .map(addrKey));
      },
    };

    const seed = await startNode(sysName, 64_091, {
      downing: provider,
      failureDetector: WINDOW_EVICTION,
      splitBrainResolver: { stableAfterMs: STABLE_AFTER_MS },
    });
    const peer = await startNode(sysName, 64_092, {
      seeds: [`${sysName}@h:64091`], failureDetector: WINDOW_EVICTION,
    });
    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);
    const peerKey = peer.cluster.selfAddress.toString();

    const shutdownAt = Date.now();
    await peer.cluster.transport.shutdown();
    await waitFor(
      () => !seed.cluster.getMembers().some((m) => m.address.toString() === peerKey),
      6_000,
      25,
      'the partition was resolved once the window had elapsed',
    );

    // The window is not a decoration on a decision that would have happened
    // anyway: the view cannot have been settled before the peer was even
    // marked unreachable, so the decision has to land at least a whole window
    // after the peer fell silent.  Measured from `shutdownAt` rather than from
    // the `unreachable` transition because that instant is only observable by
    // polling, and a poll's own latency would go into the margin.
    expect(decidedAt - shutdownAt).toBeGreaterThanOrEqual(STABLE_AFTER_MS);

    await stop(seed);
    await peer.sys.terminate();
  }, 20_000);

  test('down-all-when-unstable stops the whole cluster when the view will not settle', async () => {
    const sysName = 'window-escalates';
    const STABLE_AFTER_MS = 300;
    // Never decides anything.  That is what makes the assertion unambiguous:
    // whatever downs this cluster was the escalation, because the strategy
    // returned an empty set every single time it was asked.
    const provider: DowningProvider = { decide: () => new Set() };

    const seed = await startNode(sysName, 64_201, {
      downing: provider,
      failureDetector: WINDOW_EVICTION,
      splitBrainResolver: { stableAfterMs: STABLE_AFTER_MS, downAllWhenUnstable: true },
    });
    const peer = await startNode(sysName, 64_202, {
      seeds: [`${sysName}@h:64201`], failureDetector: WINDOW_EVICTION,
    });
    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);
    const selfKey = seed.cluster.selfAddress.toString();

    // One fresh address every 60 ms, so no 300 ms window can ever elapse
    // without the fingerprint moving — and each one goes unreachable a round
    // later, which is the second condition escalation insists on.
    let phantomPort = 64_900;
    const churn = setInterval(() => introducePhantom(peer, seed, sysName, phantomPort++), 60);
    try {
      await waitFor(
        () => {
          const me = seed.cluster.getMembers().find((m) => m.address.toString() === selfKey);
          return !me || me.status === 'leaving' || me.status === 'removed';
        },
        8_000,
        25,
        'the unstable-escalation downed this node too',
      );
    } finally {
      clearInterval(churn);
    }

    // Self left through `leave()`, and the peer was force-downed — escalation
    // downs everyone, which is the whole of what distinguishes it from a
    // strategy picking a side.
    const peerRecord = seed.cluster.getMembers()
      .find((m) => m.address.toString() === peer.cluster.selfAddress.toString());
    expect(peerRecord === undefined || peerRecord.status === 'removed'
      || peerRecord.status === 'down').toBe(true);
    // Not vacuous about the deadline: the churn started only after both nodes
    // were up, so nothing could have escalated in under one deadline's worth
    // of it.
    expect(unstableEscalationDeadlineMs(STABLE_AFTER_MS)).toBe(STABLE_AFTER_MS * 3);

    await seed.sys.terminate();
    await peer.sys.terminate();
  }, 20_000);

  test('the same churn with the switch unset downs nobody', async () => {
    const sysName = 'window-no-escalation';
    const STABLE_AFTER_MS = 300;
    const provider: DowningProvider = { decide: () => new Set() };

    const seed = await startNode(sysName, 64_211, {
      downing: provider,
      failureDetector: WINDOW_EVICTION,
      splitBrainResolver: { stableAfterMs: STABLE_AFTER_MS },
    });
    const peer = await startNode(sysName, 64_212, {
      seeds: [`${sysName}@h:64211`], failureDetector: WINDOW_EVICTION,
    });
    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);
    const selfKey = seed.cluster.selfAddress.toString();

    let phantomPort = 65_100;
    const churn = setInterval(() => introducePhantom(peer, seed, sysName, phantomPort++), 60);
    try {
      // Several escalation deadlines' worth, so the switch being off is the
      // only thing that kept this cluster alive.
      await sleep(unstableEscalationDeadlineMs(STABLE_AFTER_MS) * 4);
    } finally {
      clearInterval(churn);
    }

    const me = seed.cluster.getMembers().find((m) => m.address.toString() === selfKey);
    expect(me?.status).toBe('up');
    const peerRecord = seed.cluster.getMembers()
      .find((m) => m.address.toString() === peer.cluster.selfAddress.toString());
    expect(peerRecord?.status).toBe('up');

    await stop(seed);
    await peer.sys.terminate();
  }, 20_000);
});
