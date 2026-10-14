/**
 * The synchronous subscriber contract of `DistributedDataHandle.subscribe`
 * (#1468).
 *
 * A listener runs on the replicator's own turn, inside the merge, and a key
 * that already holds a value is replayed to a new listener on the caller's
 * stack.  Both halves stay; what this file pins is the two places they used to
 * disagree with each other:
 *
 *  - The fan-out walked the live listener `Set`, and a `Set` iterator visits
 *    members added while it runs — so a listener subscribed from inside a
 *    notification for the same key got that value twice, once from its own
 *    replay and once from the merge still in progress.
 *  - A listener that threw during a merge was warned about; the same throw
 *    during the replay was swallowed without a word.
 *
 * Single node on `InMemoryTransport`, as the other suites in this directory
 * run it.  `getAsync(key, { consistency: 'local' })` is the mailbox barrier:
 * it is answered on the replicator's turn, after every `update` told before
 * it, so the listeners have already run when it resolves — nothing here waits
 * on a clock.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import { DistributedDataId, GCounter } from '../../../src/crdt/index.js';

/* ============================== fixtures ================================ */

type CapturedRecord = {
  readonly level: string;
  readonly source: string;
  readonly message: string;
  readonly args: readonly unknown[];
};

/**
 * Collects every record into one list, through `withSource` / `withFields`
 * children too, and keeps the arguments and the source.
 * `tests/util/RecordingLogger.ts` keeps the message only, and the error a
 * warning carries — and which logger it came through — is half of what is
 * asserted here.
 */
class CapturingLogger implements Logger {
  readonly level: LogLevel = LogLevel.Debug;

  constructor(
    readonly records: CapturedRecord[] = [],
    private readonly source: string = '',
  ) {}

  private record(level: string, message: string, args: readonly unknown[]): void {
    this.records.push({ level, source: this.source, message, args });
  }

  debug(message: string, ...args: unknown[]): void { this.record('debug', message, args); }
  info(message: string, ...args: unknown[]): void { this.record('info', message, args); }
  warn(message: string, ...args: unknown[]): void { this.record('warn', message, args); }
  error(message: string, ...args: unknown[]): void { this.record('error', message, args); }

  withSource(source: string): Logger { return new CapturingLogger(this.records, source); }
  withFields(_fields: LogContextData): Logger { return new CapturingLogger(this.records, this.source); }
}

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

async function startNode(name: string, port: number, logger: Logger = new NoopLogger()): Promise<Cluster> {
  const options = ActorSystemOptions.create().withLogger(logger);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)));
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return cluster;
}

const KEY = 'hits';

/** The warnings a throwing subscriber of {@link KEY} produced, in order. */
function subscriberWarnings(logger: CapturingLogger): CapturedRecord[] {
  return logger.records.filter(
    (record) => record.level === 'warn' && record.message.includes('subscriber for'),
  );
}

/* ================ subscribing from inside a notification ================ */

describe('a subscribe from inside a notification', () => {
  test('receives the value in flight once, by its own replay', async () => {
    // The live-`Set` walk handed the late listener `2` from its replay and
    // then again from the fan-out it was added during: `[2, 2]`, and
    // `[2, 2, 3]` after the next update.
    const node = await startNode('ddata-subscribers-a', 48_601);
    const data = node.system.extension(DistributedDataId).start(node);
    const increment = (): void => {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    };

    const late: number[] = [];
    let lateSubscribed = false;
    data.subscribe<GCounter>(KEY, (counter) => {
      if (counter.value() !== 2 || lateSubscribed) return;
      lateSubscribed = true;
      data.subscribe<GCounter>(KEY, (seen) => late.push(seen.value()));
    });

    increment();
    increment();
    await data.getAsync(KEY, { consistency: 'local' });
    expect(late).toEqual([2]);

    increment();
    await data.getAsync(KEY, { consistency: 'local' });
    expect(late).toEqual([2, 3]);
  });

  test('a listener unsubscribed earlier in the same fan-out is not called for that value', async () => {
    // The other half of the same walk, and the half a bare copy of the set
    // would break: it would still call `second`, which `first` had already
    // let go of.
    const node = await startNode('ddata-subscribers-b', 48_611);
    const data = node.system.extension(DistributedDataId).start(node);

    const calls: string[] = [];
    let unsubscribeSecond: () => void = () => {};
    data.subscribe<GCounter>(KEY, (counter) => {
      calls.push(`first:${counter.value()}`);
      unsubscribeSecond();
    });
    unsubscribeSecond = data.subscribe<GCounter>(KEY, (counter) => {
      calls.push(`second:${counter.value()}`);
    });

    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await data.getAsync(KEY, { consistency: 'local' });
    expect(calls).toEqual(['first:1']);

    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await data.getAsync(KEY, { consistency: 'local' });
    expect(calls).toEqual(['first:1', 'first:2']);
  });

  test('a listener re-subscribed after every listener left gets the value in flight once', async () => {
    // Every listener leaving drops the key's set, so a listener of this
    // fan-out that subscribes again lands in a new set and takes the value
    // through its own replay.  The fan-out in flight must not call it a second
    // time: it asks the set it captured, not whatever the key holds by now.
    const node = await startNode('ddata-subscribers-e', 48_641);
    const data = node.system.extension(DistributedDataId).start(node);

    const seen: number[] = [];
    const second = (counter: GCounter): void => { seen.push(counter.value()); };
    let resubscribed = false;
    let unsubscribeFirst: () => void = () => {};
    let unsubscribeSecond: () => void = () => {};
    unsubscribeFirst = data.subscribe<GCounter>(KEY, () => {
      if (resubscribed) return;
      resubscribed = true;
      unsubscribeFirst();
      unsubscribeSecond();
      data.subscribe<GCounter>(KEY, second);
    });
    unsubscribeSecond = data.subscribe<GCounter>(KEY, second);

    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await data.getAsync(KEY, { consistency: 'local' });
    expect(seen).toEqual([1]);

    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await data.getAsync(KEY, { consistency: 'local' });
    expect(seen).toEqual([1, 2]);
  });
});

/* =========================== a throwing listener ========================= */

describe('a subscriber that throws', () => {
  test('on its replay is warned as a merge warns it, and stays subscribed', async () => {
    // The replay swallowed this throw silently — no warning at all — while the
    // identical throw during a merge produced one.
    const logger = new CapturingLogger();
    const node = await startNode('ddata-subscribers-c', 48_621, logger);
    const data = node.system.extension(DistributedDataId).start(node);
    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await data.getAsync(KEY, { consistency: 'local' });

    const failure = new Error('listener failed');
    let calls = 0;
    const unsubscribe = data.subscribe<GCounter>(KEY, () => {
      calls++;
      throw failure;
    });

    // Synchronously: the replay ran, threw and was reported before
    // `subscribe` returned, and the caller still got its handle back.
    expect(calls).toBe(1);
    expect(typeof unsubscribe).toBe('function');
    const afterReplay = subscriberWarnings(logger);
    expect(afterReplay).toHaveLength(1);
    expect(afterReplay[0]!.message).toBe(`DistributedData: subscriber for "${KEY}" threw`);
    expect(afterReplay[0]!.args).toHaveLength(1);
    expect(afterReplay[0]!.args[0]).toBe(failure);

    // Still registered: the next merge reaches it, and warns once for it.
    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await data.getAsync(KEY, { consistency: 'local' });
    expect(calls).toBe(2);
    const afterMerge = subscriberWarnings(logger);
    expect(afterMerge).toHaveLength(2);
    expect(afterMerge[1]!.message).toBe(afterReplay[0]!.message);
    expect(afterMerge[1]!.args[0]).toBe(failure);
    // One logger for both deliveries — the replicator's own.
    expect(afterMerge[1]!.source).toBe(afterReplay[0]!.source);

    // And the handle it got back is the one that removes it.
    unsubscribe();
    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await data.getAsync(KEY, { consistency: 'local' });
    expect(calls).toBe(2);
    expect(subscriberWarnings(logger)).toHaveLength(2);
  });

  test('during a merge is contained to that listener: the next one is still called', async () => {
    const logger = new CapturingLogger();
    const node = await startNode('ddata-subscribers-d', 48_631, logger);
    const data = node.system.extension(DistributedDataId).start(node);

    const failure = new Error('listener failed');
    const seenByNext: number[] = [];
    data.subscribe<GCounter>(KEY, () => { throw failure; });
    data.subscribe<GCounter>(KEY, (counter) => seenByNext.push(counter.value()));

    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await data.getAsync(KEY, { consistency: 'local' });

    expect(seenByNext).toEqual([1]);
    const warnings = subscriberWarnings(logger);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.args[0]).toBe(failure);
  });
});
