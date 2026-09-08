/**
 * Smoke tests for the new shared-fixture helpers (#263, #284).
 * Verifies that:
 *   - systemFixture / testKitFixture boot once per describe block
 *     and tear down on afterAll.
 *   - MultiNodeClusterFixture boots a real multi-node cluster
 *     and reaches steady state.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { MultiNodeClusterFixture } from '../../../src/testkit/MultiNodeClusterFixture.js';
import { systemFixture, testKitFixture } from '../__shared__/SystemFixture.js';

describe('systemFixture', () => {
  const sys = systemFixture('shared-sys-test');

  /**
   * The instance the fixture booted, recorded by a `beforeAll` of our own —
   * bun runs it after the fixture's, so the system exists by then.
   *
   * Every case below compares against *this* rather than against a value a
   * sibling test happened to store, and that is the whole point: the block used
   * to assert "the same instance across tests" by writing in one test and
   * reading in the next, which makes the test's premise the order of its own
   * block.  Under `bun test --randomize` the reader ran first, compared against
   * an unwritten `null`, and failed in 4 of 5 seeds (#1422).  The property it
   * was reaching for — the fixture boots once, not once per test — is unchanged
   * and is still exactly what the comparison says.
   */
  let booted!: ReturnType<typeof sys>;
  beforeAll(() => { booted = sys(); });

  test('returns a live ActorSystem inside a test()', () => {
    expect(sys().name).toBe('shared-sys-test');
  });

  test('returns the SAME instance the block booted, in whatever order tests run', () => {
    // Same reference — confirms beforeAll booted exactly once, not per-test.
    expect(sys()).toBe(booted);
  });

  test('can spawn actors against the shared system', () => {
    class Counter extends Actor<number> {
      received: number[] = [];
      override onReceive(n: number): void { this.received.push(n); }
    }
    const ref = sys().spawnAnonymous(Counter);
    ref.tell(42);
    expect(ref).toBeDefined();
  });
});

describe('testKitFixture', () => {
  const kit = testKitFixture('shared-kit-test');

  test('returns a live TestKit with a system', () => {
    expect(kit().system.name).toBe('shared-kit-test');
  });

  test('can create test probes against the shared kit', () => {
    const probe = kit().createTestProbe();
    // TestProbe IS the ActorRef — verify the path is present (proves
    // the probe was wired up against the shared system).
    expect(probe.path).toBeDefined();
    expect(probe.path.toString()).toContain('test-probe-');
  });
});

describe('MultiNodeClusterFixture', () => {
  const fixture = MultiNodeClusterFixture.create(
    { roles: ['a', 'b', 'c'], gossipIntervalMs: 30 },
    { beforeAll, afterAll },
  );

  test('starts a 3-role cluster before the first test', async () => {
    expect(fixture.isStarted()).toBe(true);
    const spec = fixture.spec();
    // Verify the spec exposes all three roles.
    expect(spec.clusterFor('a')).toBeDefined();
    expect(spec.clusterFor('b')).toBeDefined();
    expect(spec.clusterFor('c')).toBeDefined();
  });

  test('shares the same MultiNodeSpec across tests', async () => {
    const spec = fixture.spec();
    // Members converge across the cluster.
    await spec.awaitMembers('a', 3);
    await spec.awaitMembers('b', 3);
    await spec.awaitMembers('c', 3);
  }, 10_000);

  test('clusterFor("a").getMembers() lists three peers', () => {
    const cluster = fixture.spec().clusterFor('a');
    const members = cluster.getMembers();
    expect(members.length).toBe(3);
  });
});
