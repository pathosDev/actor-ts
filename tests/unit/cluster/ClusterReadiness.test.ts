/**
 * #1355 — the readiness surface on `Cluster`.
 *
 * Starts with the observables the readiness API is built from:
 * `selfMember()` (the node's own record, tombstone included, which
 * `getMembers()` deliberately hides) and `selfElected` (formed-vs-joined —
 * the mechanism #943 asks callers to be able to see, and the one #1087's
 * integration test binds to).  The `awaitReady` / `isReady` cases share the
 * same fixtures.
 *
 * Nodes run on the in-memory transport with fast gossip (50 ms), so the one
 * cross-node wait settles well inside its 4 s budget; the failure detector's
 * thresholds are pushed past the test's lifetime because reachability is not
 * under test here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { ActorSystemOptionsType } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { SelfElectionPolicy } from '../../../src/cluster/ClusterOptions.js';
import { readClusterBootstrapDefaultsFromConfig } from '../../../src/cluster/ClusterBootstrapOptions.js';
import { ClusterReadyTimeoutError } from '../../../src/cluster/ClusterReadiness.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const HOST = '10.0.164.1';

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

/** The private surface these tests drive — bookkeeping-safe writes, listener count. */
interface ClusterInternals {
  setMember(member: Member): void;
  readonly _listeners: ReadonlyArray<unknown>;
}

const internals = (cluster: Cluster): ClusterInternals =>
  cluster as unknown as ClusterInternals;

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

async function startNode(args: {
  readonly systemName: string;
  readonly port: number;
  readonly seeds?: ReadonlyArray<string>;
  readonly selfElection?: SelfElectionPolicy;
  readonly config?: NonNullable<ActorSystemOptionsType['config']>;
}): Promise<NodeHandle> {
  const address = new NodeAddress(args.systemName, HOST, args.port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (args.config !== undefined) systemOptions.withConfig(args.config);
  const system = ActorSystem.create(args.systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(args.port)
    .withTransport(new InMemoryTransport(address))
    .withSeeds([...(args.seeds ?? [])])
    .withGossipIntervalMs(50)
    .withSeedRetryIntervalMs(80)
    .withFailureDetector({
      heartbeatIntervalMs: 60_000,
      unreachableAfterMs: 60_000,
      downAfterMs: 120_000,
    });
  if (args.selfElection !== undefined) clusterOptions.withSelfElection(args.selfElection);
  const cluster = await Cluster.join(system, clusterOptions);
  const handle = { system, cluster, address };
  nodes.push(handle);
  return handle;
}

/** A seed nobody answers — the address is never registered with the transport. */
const deadSeed = (systemName: string): string => `${systemName}@${HOST}:65001`;

describe('selfMember()', () => {
  test('reports the joining record while seed contact is still pending', async () => {
    const node = await startNode({
      systemName: 'self-view-joining',
      port: 9_401,
      seeds: [deadSeed('self-view-joining')],
    });
    expect(node.cluster.selfMember()?.status).toBe('joining');
    expect(node.cluster.selfElected).toBe(false);
  });

  test('does not filter a removed self, unlike getMembers()', async () => {
    const node = await startNode({ systemName: 'self-view-removed', port: 9_402 });
    const me = node.cluster.selfMember();
    expect(me?.status).toBe('up');
    internals(node.cluster).setMember(me!.withRemoved(Date.now()));
    expect(node.cluster.getMembers().some((m) => m.address.equals(node.address))).toBe(false);
    expect(node.cluster.selfMember()?.status).toBe('removed');
  });
});

describe('selfElected', () => {
  test('a node with no seeds elects itself and says so', async () => {
    const node = await startNode({ systemName: 'self-elected-solo', port: 9_403 });
    expect(node.cluster.selfMember()?.status).toBe('up');
    expect(node.cluster.selfElected).toBe(true);
  });

  test('a node promoted by an existing cluster reports false', async () => {
    const seedNode = await startNode({ systemName: 'self-elected-join', port: 9_404 });
    const joiner = await startNode({
      systemName: 'self-elected-join',
      port: 9_405,
      seeds: [seedNode.address.toString()],
    });
    await awaitCondition(
      () => joiner.cluster.selfMember()?.status === 'up',
      { timeoutMs: 4_000, label: 'the seed node promoted the joiner' },
    );
    expect(joiner.cluster.selfElected).toBe(false);
    expect(seedNode.cluster.selfElected).toBe(true);
  });
});

describe('isReady()', () => {
  test('false while joining, true once up', async () => {
    const joining = await startNode({
      systemName: 'is-ready-joining',
      port: 9_406,
      seeds: [deadSeed('is-ready-joining')],
    });
    expect(joining.cluster.isReady()).toBe(false);

    const solo = await startNode({ systemName: 'is-ready-solo', port: 9_407 });
    expect(solo.cluster.isReady()).toBe(true);
  });

  test('minimumMembers above the up count keeps it false', async () => {
    const solo = await startNode({ systemName: 'is-ready-bar', port: 9_408 });
    expect(solo.cluster.isReady({ minimumMembers: 2 })).toBe(false);
  });

  test('the HOCON minimum-members layer applies, and an explicit option overrides it', async () => {
    const node = await startNode({
      systemName: 'is-ready-hocon',
      port: 9_409,
      config: { 'actor-ts': { cluster: { bootstrap: { 'minimum-members': 2 } } } },
    });
    expect(node.cluster.isReady()).toBe(false);
    expect(node.cluster.isReady({ minimumMembers: 1 })).toBe(true);
  });

  test('out-of-domain options are an OptionsError; unset fields pass', async () => {
    const node = await startNode({ systemName: 'is-ready-domain', port: 9_410 });
    expect(() => node.cluster.isReady({ minimumMembers: 0 })).toThrow(OptionsError);
    expect(() => node.cluster.isReady({ minimumMembers: -1 })).toThrow(OptionsError);
    expect(() => node.cluster.isReady({ minimumMembers: 1.5 })).toThrow(OptionsError);
    // The probe ignores timeoutMs, but its domain is still checked — strictly
    // positive, so 0 is out (a probe with no wait *is* isReady()).
    expect(() => node.cluster.isReady({ timeoutMs: 0 })).toThrow(OptionsError);
    expect(() => node.cluster.awaitReady({ timeoutMs: -1 })).toThrow(OptionsError);
    expect(node.cluster.isReady({})).toBe(true);
  });
});

describe('awaitReady()', () => {
  test('already-ready fast path resolves without subscribing', async () => {
    const node = await startNode({ systemName: 'await-fast-path', port: 9_411 });
    const listenersBefore = internals(node.cluster)._listeners.length;
    await node.cluster.awaitReady();
    expect(internals(node.cluster)._listeners.length).toBe(listenersBefore);
  });

  test('resolves through the subscribe path when a deferred election fires', async () => {
    const node = await startNode({
      systemName: 'await-deferred',
      port: 9_412,
      seeds: [deadSeed('await-deferred')],
      selfElection: 50,
    });
    const listenersBefore = internals(node.cluster)._listeners.length;
    expect(node.cluster.isReady()).toBe(false);
    await node.cluster.awaitReady({ timeoutMs: 4_000 });
    expect(node.cluster.selfElected).toBe(true);
    // The wait's own listener is gone again — no subscription leak.
    expect(internals(node.cluster)._listeners.length).toBe(listenersBefore);
  });

  test('minimumMembers: 2 resolves when the second node is promoted', async () => {
    const seedNode = await startNode({ systemName: 'await-two', port: 9_413 });
    const pending = seedNode.cluster.awaitReady({ minimumMembers: 2, timeoutMs: 4_000 });
    await startNode({
      systemName: 'await-two',
      port: 9_414,
      seeds: [seedNode.address.toString()],
    });
    await pending;
    expect(seedNode.cluster.isReady({ minimumMembers: 2 })).toBe(true);
  });

  test('rejects with ClusterReadyTimeoutError carrying the diagnostics', async () => {
    const node = await startNode({
      systemName: 'await-timeout',
      port: 9_415,
      seeds: [deadSeed('await-timeout')],
    });
    let caught: unknown;
    try {
      await node.cluster.awaitReady({ timeoutMs: 150 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClusterReadyTimeoutError);
    const err = caught as ClusterReadyTimeoutError;
    expect(err.name).toBe('ClusterReadyTimeoutError');
    expect(err.selfStatus).toBe('joining');
    expect(err.upMemberCount).toBe(0);
    expect(err.minimumMembers).toBe(1);
    expect(err.timeoutMs).toBe(150);
    expect(err.message).toContain("'joining'");
    expect(err.message).toContain('0 of 1');
  });
});

describe('readClusterBootstrapDefaultsFromConfig', () => {
  test('reads the pair when present; an unset await-ready stays absent', async () => {
    const configured = await startNode({
      systemName: 'reader-configured',
      port: 9_416,
      config: { 'actor-ts': { cluster: { bootstrap: { 'await-ready': '7s', 'minimum-members': 3 } } } },
    });
    expect(readClusterBootstrapDefaultsFromConfig(configured.system.config)).toEqual({
      awaitReadyMs: 7_000,
      minimumMembers: 3,
    });

    const plain = await startNode({ systemName: 'reader-plain', port: 9_417 });
    // `minimum-members` ships as a real reference.conf leaf (1); `await-ready`
    // is comment-only there, so "unset" is expressible and stays absent.
    expect(readClusterBootstrapDefaultsFromConfig(plain.system.config)).toEqual({
      minimumMembers: 1,
    });
  });
});
