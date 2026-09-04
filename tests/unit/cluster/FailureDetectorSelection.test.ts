/**
 * #840 — the φ-accrual detector shipped as a public, exported, documented
 * class that nothing could ever install.  `Cluster` typed its detector field
 * as the concrete `FailureDetector` and constructed one unconditionally, so
 * `PhiAccrualFailureDetector` was reachable only by instantiating it yourself
 * and never handing it to anything.  The config keys the issue asked for had
 * nowhere to land until that seam existed.
 *
 * What is pinned here is the seam, not the algorithm — `PhiAccrualFailureDetector`
 * has its own suite.  Three separable promises:
 *
 *  - `createFailureDetector` returns the implementation it is asked for, and
 *    imposes the cluster's heartbeat cadence on it whatever the φ settings say
 *    (#1142 — swapping the algorithm must not change how often the node talks
 *    to its peers, which is why there is no `phi.heartbeat-interval` leaf);
 *  - the choice survives `Cluster.join`, from HOCON and from explicit options,
 *    with explicit winning;
 *  - and the installed detector actually *decides differently* — an
 *    `instanceof` alone would still pass if the cluster kept consulting a
 *    second, simple detector it built for itself.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions, ClusterOptionsBuilder } from '../../../src/cluster/ClusterOptions.js';
import {
  createFailureDetector,
  defaultFailureDetectorOptions,
  FailureDetector,
  type FailureDetectorLike,
} from '../../../src/cluster/FailureDetector.js';
import {
  defaultPhiAccrualOptions,
  PhiAccrualFailureDetector,
} from '../../../src/cluster/PhiAccrualFailureDetector.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Config } from '../../../src/config/Config.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

const SELF_HOST = '10.0.840.1';
const PEER_HOST = '10.0.840.2';

/** The private field these tests read — the whole point is *which* one it is. */
interface ClusterInternals {
  readonly failureDetector: FailureDetectorLike;
}

const internals = (cluster: Cluster): ClusterInternals => cluster as unknown as ClusterInternals;

const started: ActorSystem[] = [];

afterEach(async () => {
  const systems = started.splice(0, started.length);
  for (const system of systems) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

/**
 * A one-node cluster over `InMemoryTransport`, with every periodic task pushed
 * past the test's lifetime.  `hocon` is layered over the shipped defaults, the
 * same way `ActorSystem.create` layers a deployment's `application.conf`, so
 * the reference `implementation = simple` is genuinely underneath.
 */
async function joinNode(
  name: string,
  port: number,
  hocon: string,
  tune: (options: ClusterOptionsBuilder) => ClusterOptionsBuilder = (o) => o,
): Promise<Cluster> {
  const address = new NodeAddress(name, SELF_HOST, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon));
  const system = ActorSystem.create(name, systemOptions);
  started.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withGossipIntervalMs(60_000)
    .withTombstonePruneIntervalMs(60_000);
  return Cluster.join(system, tune(clusterOptions));
}

const peer = (port: number): NodeAddress => new NodeAddress('peer', PEER_HOST, port);

describe('createFailureDetector builds the implementation it is named', () => {
  test("'simple' builds the elapsed-time detector, thresholds intact", () => {
    const detector = createFailureDetector('simple', {
      heartbeatIntervalMs: 700,
      unreachableAfterMs: 1_000,
      downAfterMs: 4_000,
    });

    expect(detector).toBeInstanceOf(FailureDetector);
    expect(detector.interval).toBe(700);
    const target = peer(1);
    detector.heartbeat(target, 0);
    expect(detector.decide(target, 1_500)).toBe('unreachable');
    expect(detector.decide(target, 4_500)).toBe('down');
  });

  test("'phi' builds the φ-accrual detector", () => {
    const detector = createFailureDetector('phi', defaultFailureDetectorOptions);

    expect(detector).toBeInstanceOf(PhiAccrualFailureDetector);
  });

  test('the φ detector runs on the cluster heartbeat cadence, not its own (#1142)', () => {
    // The trap: `defaultPhiAccrualOptions` carries a `heartbeatIntervalMs` of
    // its own, and `Cluster` schedules both its heartbeat tick and its
    // detection tick from `failureDetector.interval`.  A φ detector that kept
    // its own copy would change how often the node talks to its peers purely
    // by being selected — which is what aff9d371 collapsed onto one constant,
    // and why no `phi.heartbeat-interval` leaf exists to reinstate it.
    const detector = createFailureDetector(
      'phi',
      { ...defaultFailureDetectorOptions, heartbeatIntervalMs: 1_750 },
    );

    expect(detector.interval).toBe(1_750);
    expect(detector.interval).not.toBe(defaultPhiAccrualOptions.heartbeatIntervalMs);
  });

  test('a φ heartbeat interval smuggled in through the options is overruled', () => {
    // Unreachable from HOCON — there is no leaf for it — but reachable from
    // `withPhiAccrual({ heartbeatIntervalMs })`, and the cadence has to be
    // single-sourced from whichever door it is pushed at.
    const detector = createFailureDetector(
      'phi',
      { ...defaultFailureDetectorOptions, heartbeatIntervalMs: 900 },
      { heartbeatIntervalMs: 60_000, downThreshold: 20 },
    );

    expect(detector.interval).toBe(900);
  });

  test('unset φ fields fall through to the built-in defaults, per field', () => {
    // One field set must not blank the other four: the detector spreads
    // `defaultPhiAccrualOptions` underneath, which is what makes a partial
    // object from config or code safe to pass.
    const detector = createFailureDetector(
      'phi',
      defaultFailureDetectorOptions,
      { maxSampleSize: 4 },
    ) as PhiAccrualFailureDetector;
    const target = peer(2);

    // Only reachable through behaviour: with `unreachableThreshold` left at 8
    // and `minStdDeviationMs` at 100, a single heartbeat 1.5 s stale is well
    // into the tail.
    detector.heartbeat(target, 0);
    expect(detector.decide(target, 1_500)).not.toBe('healthy');
    // …and a fresh one is not.
    expect(detector.decide(target, 0)).toBe('healthy');
  });

  test('an explicitly undefined φ field does not shadow the default', () => {
    const detector = createFailureDetector(
      'phi',
      defaultFailureDetectorOptions,
      { downThreshold: undefined },
    );

    expect(detector).toBeInstanceOf(PhiAccrualFailureDetector);
    expect(detector.interval).toBe(defaultFailureDetectorOptions.heartbeatIntervalMs);
  });
});

describe('Cluster.join installs the configured detector', () => {
  test('the shipped default is still the simple detector', async () => {
    const cluster = await joinNode('fd-default', 28_401, 'actor-ts.cluster.gossip-interval = 60s');

    expect(internals(cluster).failureDetector).toBeInstanceOf(FailureDetector);
  });

  test('implementation = phi in HOCON installs the φ-accrual detector', async () => {
    const cluster = await joinNode(
      'fd-phi',
      28_402,
      'actor-ts.cluster.failure-detector.implementation = phi',
    );

    expect(internals(cluster).failureDetector).toBeInstanceOf(PhiAccrualFailureDetector);
  });

  test('an explicit implementation beats the file, in both directions', async () => {
    const overCode = await joinNode(
      'fd-explicit-simple',
      28_403,
      'actor-ts.cluster.failure-detector.implementation = phi',
      (options) => options.withFailureDetectorImplementation('simple'),
    );
    expect(internals(overCode).failureDetector).toBeInstanceOf(FailureDetector);

    const overFile = await joinNode(
      'fd-explicit-phi',
      28_404,
      'actor-ts.cluster.failure-detector.implementation = simple',
      (options) => options.withFailureDetectorImplementation('phi'),
    );
    expect(internals(overFile).failureDetector).toBeInstanceOf(PhiAccrualFailureDetector);
  });

  test('the installed φ detector decides by φ, not by the elapsed-time thresholds', async () => {
    // `instanceof` on its own would still pass if the cluster consulted a
    // simple detector it kept alongside, so the discriminating assertion is a
    // verdict the two implementations do not share.  At 2 s of silence after a
    // single heartbeat the simple detector says `unreachable` (2 s ≤ elapsed
    // < 5 s); φ sees a 15-σ gap against a 500 ms mean and a 100 ms floor, and
    // says `down`.
    const cluster = await joinNode(
      'fd-phi-decides',
      28_405,
      'actor-ts.cluster.failure-detector.implementation = phi',
    );
    const detector = internals(cluster).failureDetector;
    const target = peer(28_406);

    detector.heartbeat(target, 0);

    expect(detector.decide(target, 2_000)).toBe('down');
    // The control: the same input through the detector the default installs.
    expect(createFailureDetector('simple', defaultFailureDetectorOptions).decide(target, 2_000))
      .toBe('healthy');
  });

  test('the φ block from HOCON reaches the installed detector', async () => {
    // Thresholds far enough from the shipped 8 / 12 that the verdict at a
    // fixed instant can only have come from the file.
    // `unreachable-threshold` is fractional on purpose: the reader is
    // `getNumber`, and `getInt` would have thrown on the way in — so this
    // cluster does not start at all if the block is read with the wrong
    // accessor.
    const cluster = await joinNode(
      'fd-phi-tuned',
      28_407,
      `
        actor-ts.cluster.failure-detector {
          implementation = phi
          phi {
            unreachable-threshold = 0.5
            down-threshold        = 1000000
          }
        }
      `,
    );
    const detector = internals(cluster).failureDetector;
    const target = peer(28_408);
    const shipped = createFailureDetector('phi', defaultFailureDetectorOptions);

    detector.heartbeat(target, 0);
    shipped.heartbeat(target, 0);

    // One second of silence against a 500 ms mean is a φ of about 6.5: past
    // the file's 0.5 and nowhere near its 1e6, but short of the shipped 8.
    // Stated as the *difference* between the two detectors rather than as a
    // number, so the assertion survives a change to the normal-CDF
    // approximation that would move φ without moving the ordering.
    expect(detector.decide(target, 1_000)).toBe('unreachable');
    expect(shipped.decide(target, 1_000)).toBe('healthy');
  });

  test('an unknown implementation is refused at join, naming the field', async () => {
    // It arrives from HOCON as often as from code, and the two legal spellings
    // have to be in the message: a cluster that quietly ran the detector the
    // operator did not ask for is the failure this key exists to prevent.
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig(Config.parseString('actor-ts.cluster.failure-detector.implementation = phi-accrual'));
    const system = ActorSystem.create('fd-bad', systemOptions);
    started.push(system);
    const address = new NodeAddress('fd-bad', SELF_HOST, 28_409);
    const clusterOptions = ClusterOptions.create()
      .withHost(address.host)
      .withPort(address.port)
      .withTransport(new InMemoryTransport(address));

    await expect(Cluster.join(system, clusterOptions)).rejects.toThrow(OptionsError);
    await expect(Cluster.join(system, clusterOptions))
      .rejects.toThrow(/failureDetectorImplementation/);
    await expect(Cluster.join(system, clusterOptions)).rejects.toThrow(/simple/);
  });
});
