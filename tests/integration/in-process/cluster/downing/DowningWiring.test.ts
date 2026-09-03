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
import type { FailureDetectorOptionsType } from '../../../../../src/cluster/FailureDetectorOptions.js';
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

async function startNode(
  systemName: string, port: number, options: {
    seeds?: string[];
    downing?: DowningProvider;
    failureDetector?: FailureDetectorOptionsType;
  } = {},
): Promise<Node> {
  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create(systemName, sysOptions);
  let clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withFailureDetector(options.failureDetector ?? SLOW_EVICTION)
    .withGossipIntervalMs(80);
  if (options.seeds !== undefined) clusterOptions = clusterOptions.withSeeds(options.seeds);
  if (options.downing !== undefined) clusterOptions = clusterOptions.withDowning(options.downing);
  const cluster = await Cluster.join(sys, clusterOptions);
  return { sys, cluster };
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
        lastView = view;
        // Force-down anything we see as unreachable.
        return new Set(view.allMembers
          .filter((m) => view.unreachable.has(addrKey(m)))
          .map(addrKey));
      },
    };

    const seed = await startNode(sysName, 64_011, { downing: provider });
    const peer = await startNode(sysName, 64_012, { seeds: [`${sysName}@h:64011`] });
    await waitFor(() =>
      seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2);

    // Reset counter — initial join may have fingerprint changes that
    // legitimately invoke decide() before the partition.
    invocations = 0;

    // Crash peer → seed marks it unreachable → provider decides to down it.
    await peer.cluster.transport.shutdown();

    // Provider should fire and force a down/removed transition long
    // before the FD's downAfterMs (4s) would.
    await waitFor(() => seed.cluster.upMembers().length === 1, 2_000);
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
