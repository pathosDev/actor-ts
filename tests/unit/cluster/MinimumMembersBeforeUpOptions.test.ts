/**
 * #837 — the option side of `minimumMembersBeforeUp`: what the validator
 * refuses, and what the gate counts.
 *
 * A file of its own rather than a block in `NonBrokerOptionsValidators.test.ts`
 * because the two halves belong together. The threshold is only meaningful in
 * terms of *which members it counts*, and the counting rule — `joining`,
 * `weakly-up` and `up`, and nothing else — is the one decision here that
 * cannot be read off the option's type. Asserting the refusals two files away
 * from the rule they bound would leave neither readable on its own.
 *
 * The counting half reaches the gate through the member map rather than
 * through a running cluster: statuses like `leaving` and `unreachable` take a
 * failure detector or a leave handshake to reach honestly, and what is under
 * test is arithmetic over a map, not how the map got that way.
 * `MinimumMembersBeforeUp.test.ts` under `tests/integration/in-process/`
 * covers the whole path with three real nodes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions, ClusterOptionsValidator } from '../../../src/cluster/ClusterOptions.js';
import type { ClusterOptionsBuilder, ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

describe('ClusterOptionsValidator — minimumMembersBeforeUp (#837)', () => {
  const check = (s: Partial<ClusterOptionsType>): void => new ClusterOptionsValidator().validate(s);

  test('an unset threshold passes, and so does any integer >= 1', () => {
    // The unset case is the load-bearing one: every helper is a no-op on
    // `undefined`, so a required-ness rule that crept in here would refuse
    // every existing caller.
    expect(() => check({})).not.toThrow();
    expect(() => check({ minimumMembersBeforeUp: 1 })).not.toThrow();
    expect(() => check({ minimumMembersBeforeUp: 3 })).not.toThrow();
  });

  test('there is no "0 disables" spelling — the off value is 1', () => {
    // Unlike `weaklyUpAfterMs`, whose `0` really is a disable switch. A
    // threshold of 0 is one nothing can fail, which is what `1` already means,
    // and two spellings for one meaning is how an operator ends up believing
    // the gate is off when it is merely trivial.
    expect(() => check({ minimumMembersBeforeUp: 0 })).toThrow(/minimumMembersBeforeUp/);
    expect(() => check({ minimumMembersBeforeUp: -1 })).toThrow(OptionsError);
  });

  test('a fractional threshold is refused rather than rounded', () => {
    expect(() => check({ minimumMembersBeforeUp: 2.5 })).toThrow(/minimumMembersBeforeUp/);
  });

  test('each per-role threshold is bounded the same way, and named in the message', () => {
    expect(() => check({ minimumMembersBeforeUpPerRole: { backend: 2 } })).not.toThrow();
    // The role has to be in the message: a map with several entries otherwise
    // reports "one of these is wrong" and leaves the operator to find which.
    expect(() => check({ minimumMembersBeforeUpPerRole: { backend: 2, frontend: 0 } }))
      .toThrow(/minimumMembersBeforeUpPerRole\.frontend/);
    expect(() => check({ minimumMembersBeforeUpPerRole: { backend: 1.5 } })).toThrow(OptionsError);
    expect(() => check({ minimumMembersBeforeUpPerRole: { backend: -3 } })).toThrow(OptionsError);
  });

  test('an empty role name is refused — no member ever carries one', () => {
    // The most expensive mistake in this map to diagnose from the outside:
    // `hasRole('')` is false for every member, so the threshold can never be
    // met and the symptom is a cluster that simply never comes up.
    expect(() => check({ minimumMembersBeforeUpPerRole: { '': 1 } }))
      .toThrow(/minimumMembersBeforeUpPerRole/);
  });

  test('a value that is not a map at all is refused', () => {
    // HOCON cannot produce this, but a plain-object caller can, and the
    // failure without the guard is a silent no-op rather than an error.
    expect(() => check({ minimumMembersBeforeUpPerRole: 3 as unknown as Record<string, number> }))
      .toThrow(/minimumMembersBeforeUpPerRole/);
  });
});

/** The private surface these tests reach through — merge internals, by design. */
interface ClusterInternals {
  readonly members: Map<string, Member>;
  upThresholdSatisfied(): boolean;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

describe('what the Up threshold counts (#837)', () => {
  let started: { readonly system: ActorSystem; readonly cluster: Cluster }[] = [];

  afterEach(async () => {
    for (const node of started) {
      try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
      try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
    }
    started = [];
  });

  /**
   * A single node whose seed list points nowhere, so nothing arrives to
   * disturb the member map between `join` and the assertion.
   */
  async function nodeWith(
    port: number, options: (builder: ClusterOptionsBuilder) => void,
  ): Promise<Cluster> {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('threshold', systemOptions);
    const address = new NodeAddress('threshold', '10.0.152.1', port);
    const clusterOptions = ClusterOptions.create()
      .withHost(address.host)
      .withPort(port)
      .withTransport(new InMemoryTransport(address))
      .withSeeds([`threshold@10.0.152.9:${port + 500}`])
      .withSeedRetryIntervalMs(60_000)
      .withGossipIntervalMs(60_000)
      .withFailureDetector({
        heartbeatIntervalMs: 60_000, unreachableAfterMs: 120_000, downAfterMs: 240_000,
      });
    options(clusterOptions);
    const cluster = await Cluster.join(system, clusterOptions);
    started.push({ system, cluster });
    return cluster;
  }

  /** Put a peer in the member map directly — see the file header. */
  function put(
    cluster: Cluster, port: number, status: MemberStatus, roles: string[] = [],
  ): void {
    const address = new NodeAddress('threshold', '10.0.152.2', port);
    internals(cluster).members.set(
      address.toString(), new Member(address, status, 1, roles),
    );
  }

  test('joining, weakly-up and up count; leaving, unreachable, down and removed do not', async () => {
    // Self is `joining` and counts, so a threshold of 4 needs three peers.
    const cluster = await nodeWith(9_811, (b) => b.withMinimumMembersBeforeUp(4));

    put(cluster, 1, 'joining');
    put(cluster, 2, 'weakly-up');
    put(cluster, 3, 'up');
    expect(internals(cluster).upThresholdSatisfied()).toBe(true);

    // The four excluded statuses, one at a time against the same shape: each
    // replaces a member that *was* counting, so a rule that counted everything
    // would keep every one of these at 4.
    for (const status of ['leaving', 'unreachable', 'down', 'removed'] as const) {
      put(cluster, 3, status);
      expect(internals(cluster).upThresholdSatisfied(), `${status} must not count`).toBe(false);
    }
  });

  test('a leaving member does not hold the gate open for its replacement', async () => {
    // The rolling-restart case, and the one place this differs from Akka:
    // Akka counts every non-`removed` member, so the departing node holds the
    // threshold while the replacement starts.  Here the gate closes for
    // exactly as long as the replacement takes to appear.
    const cluster = await nodeWith(9_812, (b) => b.withMinimumMembersBeforeUp(2));

    put(cluster, 1, 'up');
    expect(internals(cluster).upThresholdSatisfied()).toBe(true);
    put(cluster, 1, 'leaving');
    expect(internals(cluster).upThresholdSatisfied()).toBe(false);
    put(cluster, 2, 'joining');
    expect(internals(cluster).upThresholdSatisfied()).toBe(true);
  });

  test('the global and per-role thresholds compose as an AND', async () => {
    const cluster = await nodeWith(9_813, (b) => {
      b.withMinimumMembersBeforeUp(2);
      b.withMinimumMembersBeforeUpPerRole({ backend: 2 });
    });

    // Global met (self + one peer), role not: two members, one backend.
    put(cluster, 1, 'up', ['backend']);
    expect(internals(cluster).upThresholdSatisfied()).toBe(false);
    // Role met too.
    put(cluster, 2, 'joining', ['backend']);
    expect(internals(cluster).upThresholdSatisfied()).toBe(true);
  });

  test('a role nobody carries is a threshold nothing meets', async () => {
    // The reason the validator refuses an empty role name, one step removed:
    // any role no member carries closes the gate for good, and only the empty
    // string is refusable up front.
    const cluster = await nodeWith(9_814, (b) => {
      b.withMinimumMembersBeforeUpPerRole({ 'never-assigned': 1 });
    });

    put(cluster, 1, 'up', ['backend']);
    put(cluster, 2, 'up', ['frontend']);
    expect(internals(cluster).upThresholdSatisfied()).toBe(false);
  });

  test('a role absent from the map is unconstrained, not bounded at zero', async () => {
    const cluster = await nodeWith(9_815, (b) => {
      b.withMinimumMembersBeforeUpPerRole({ backend: 1 });
    });

    // No `frontend` member anywhere, and no `frontend` entry either — which
    // must not be read as a threshold of its own.
    put(cluster, 1, 'up', ['backend']);
    expect(internals(cluster).upThresholdSatisfied()).toBe(true);
  });

  test('the default is 1, so a lone joining node satisfies it', async () => {
    // The whole compatibility story in one assertion: every release before
    // #837 promoted the first node immediately, and the shipped default has to
    // keep doing that.
    const cluster = await nodeWith(9_816, () => {});

    expect(internals(cluster).upThresholdSatisfied()).toBe(true);
  });
});
