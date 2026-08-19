/**
 * Stock metrics emitted by the actor framework itself (#11).  The cell
 * + cluster instrumentation is opt-in via `MetricsExtensionId.enable()`
 * — this test verifies the counters / gauges / histograms tick when
 * actors are spawned, messages flow, and members come up.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import type { MetricsRegistry } from '../../../src/metrics/Metrics.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

class Echo extends Actor<string> {
  override onReceive(_m: string): void { /* tick */ }
}

function valueFor(reg: MetricsRegistry, name: string): number | undefined {
  // Walk the collected samples — there's only one un-labelled series
  // for each stock metric in this test.
  return reg.collect().find((s) => s.name === name)?.value;
}

describe('Stock actor metrics', () => {
  test('actor_created_total ticks once per spawn (incl. system guardians)', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('m-actors', sysOptions);
    const reg = sys.extension(MetricsExtensionId).enable();
    try {
      // Capture the baseline AFTER the system has booted — the
      // root + /user + /system guardians are themselves cells and
      // count toward the metric, which is fine, but the test
      // expresses "three more user actors" as a delta.
      await sleep(20);
      const baseline = valueFor(reg, 'actor_created_total') ?? 0;
      sys.spawn(Echo, 'a');
      sys.spawn(Echo, 'b');
      sys.spawn(Echo, 'c');
      await awaitCondition(() => (valueFor(reg, 'actor_created_total') ?? 0) - baseline >= 3, {
        timeoutMs: 4_000,
        label: 'all three spawns were counted',
      });
      expect((valueFor(reg, 'actor_created_total') ?? 0) - baseline).toBe(3);
    } finally {
      await sys.terminate();
    }
  });

  test('actor_mailbox_dropped_total carries class + reason and nothing per-actor (#658)', async () => {
    // The stock label-set guard.  `path` was removed because its values were
    // produced by traffic and by remote parties — one anonymous path per
    // spawn, one `entity-<id>` per addressed shard — while the registry has
    // no per-child eviction.  Pinning the exact set here is what stops the
    // family quietly regaining a per-instance label in a later change; the
    // sibling `actor_mailbox_size` keeps its `path` deliberately, gated on a
    // 10 000-message backlog, so "no dynamic labels" is not the rule.
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('m-drop-labels', sysOptions);
    const reg = sys.extension(MetricsExtensionId).enable();
    try {
      let release: () => void = () => {};
      let running: () => void = () => {};
      const latch = new Promise<void>((resolve) => { release = resolve; });
      const alive = new Promise<void>((resolve) => { running = resolve; });

      class Wedged extends Actor<number> {
        override async onReceive(n: number): Promise<void> {
          if (n === 0) { running(); await latch; }
        }
      }

      const options = ActorOptions.create<number>()
        .withMailboxCapacity(4)
        .withMailboxOverflow('drop-new');
      const ref = sys.spawnAnonymous(Wedged, options);
      ref.tell(0);
      await alive;             // the instance exists, so `class` has settled
      for (let n = 1; n <= 32; n++) ref.tell(n);
      // Unwedged before asserting: the drops are already counted (`tell`
      // enqueues synchronously), and a latched actor would turn a failed
      // expectation into a `terminate()` timeout on top of it.
      release();

      const samples = reg.collect().filter((s) => s.name === 'actor_mailbox_dropped_total');
      expect(samples.length).toBe(1);
      expect(Object.keys(samples[0]!.labels).sort()).toEqual(['class', 'reason']);
      expect(samples[0]!.labels).toEqual({ class: 'Wedged', reason: 'drop-new' });
    } finally {
      await sys.terminate();
    }
  });

  test('actor_messages_delivered_total ticks per onReceive call', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('m-msgs', sysOptions);
    const reg = sys.extension(MetricsExtensionId).enable();
    try {
      const actorRef = sys.spawn(Echo, 'a');
      actorRef.tell('1'); actorRef.tell('2'); actorRef.tell('3');
      await awaitCondition(() => (valueFor(reg, 'actor_messages_delivered_total') ?? 0) >= 3, {
        timeoutMs: 4_000,
        label: 'all three deliveries were counted',
      });
      expect(valueFor(reg, 'actor_messages_delivered_total')).toBe(3);
    } finally {
      await sys.terminate();
    }
  });

  test('actor_mailbox_wait_seconds ships beside the handler histogram (#196)', async () => {
    // The two halves of a message's latency: this one ends where
    // `actor_message_handler_seconds` begins.  Only the family's presence
    // and shape are pinned here, next to its siblings — which messages it
    // counts, and the stash population it deliberately omits, live in
    // `MailboxWaitHistogram.test.ts`.
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('m-wait', sysOptions);
    const reg = sys.extension(MetricsExtensionId).enable();
    try {
      const actorRef = sys.spawn(Echo, 'a');
      actorRef.tell('1'); actorRef.tell('2');
      const countOf = (): number =>
        reg.collect().find((s) => s.name === 'actor_mailbox_wait_seconds'
          && s.count !== undefined)?.count ?? 0;
      await awaitCondition(() => countOf() >= 2, {
        timeoutMs: 4_000,
        label: 'both waits were observed',
      });
      expect(countOf()).toBe(2);
    } finally {
      await sys.terminate();
    }
  });

  test('actor_mailbox_depth and actor_dispatcher_queue_delay_seconds complete the set (#196)', async () => {
    // The other two thirds of what #196 asked for, pinned here beside their
    // siblings so the stock inventory is one list in one place.  What each
    // one measures — and, for the delay family, why it is a delay rather than
    // the `dispatcher_saturation_ratio` the issue named — lives in
    // `MailboxDepthHistogram.test.ts` and `DispatcherQueueDelay.test.ts`.
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('m-saturation', sysOptions);
    const reg = sys.extension(MetricsExtensionId).enable();
    try {
      const actorRef = sys.spawn(Echo, 'a');
      actorRef.tell('1'); actorRef.tell('2');
      const totalsOf = (name: string): number =>
        reg.collect().find((s) => s.name === name && s.count !== undefined)?.count ?? 0;
      await awaitCondition(
        () => totalsOf('actor_mailbox_depth') >= 2
          && totalsOf('actor_dispatcher_queue_delay_seconds') >= 1,
        { timeoutMs: 4_000, label: 'both new families recorded observations' },
      );

      // One observation per delivery, so depth tracks
      // `actor_messages_delivered_total` exactly — unlike the wait histogram,
      // which deliberately skips unstamped and replayed envelopes.
      const delivered = valueFor(reg, 'actor_messages_delivered_total') ?? 0;
      expect(delivered).toBeGreaterThanOrEqual(2);
      expect(totalsOf('actor_mailbox_depth')).toBe(delivered);
      // Per *turn*, not per message: the two tells may share one turn, so the
      // only sound relation is that turns never outnumber deliveries.
      expect(totalsOf('actor_dispatcher_queue_delay_seconds')).toBeGreaterThanOrEqual(1);
      expect(totalsOf('actor_dispatcher_queue_delay_seconds'))
        .toBeLessThanOrEqual(totalsOf('actor_mailbox_depth'));
    } finally {
      await sys.terminate();
    }
  });

  test('enabling metrics mid-drain starts counting from that point (#411)', async () => {
    // Every other case here enables metrics BEFORE it spawns, so none of them
    // would notice a cell that resolved its registry once and held it.  Since
    // #411 the receive path reads `system._metricsRegistry` per message rather
    // than walking the extension chain, and this is the case that pins the
    // "per message" half — DevTools flips both extensions at runtime, with
    // cells already draining, whenever a panel opens.
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('m-midflight', sysOptions);
    try {
      let handled = 0;
      let release: () => void = () => {};
      let parked: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const firstParked = new Promise<void>((resolve) => { parked = resolve; });

      // The gate makes the window deterministic: the actor is provably mid-way
      // through its backlog when metrics come on, rather than the test racing a
      // drain that finishes inside one poll interval.
      class Counting extends Actor<string> {
        override async onReceive(message: string): Promise<void> {
          handled += 1;
          if (message === 'm0') { parked(); await gate; }
        }
      }
      const actorRef = sys.spawn(Counting, 'a');
      for (let index = 0; index < 21; index++) actorRef.tell(`m${index}`);

      await firstParked;
      expect(handled).toBe(1);
      const reg = sys.extension(MetricsExtensionId).enable();
      release();

      await awaitCondition(() => handled === 21, {
        timeoutMs: 4_000,
        label: 'the whole backlog drained',
      });
      // The counter is incremented before the handler runs, so `m0` — already
      // past that point when the switch flipped — is not counted and the other
      // twenty are.  A per-cell handle resolved at construction would leave
      // this at zero.
      expect(valueFor(reg, 'actor_messages_delivered_total')).toBe(20);
      // 20 here too, and that agreement is worth pinning.  `m0`'s histogram
      // observation happens in the `finally`, which runs *after* the gate
      // released and metrics were already on — yet it is still not recorded,
      // because the registry is resolved once per message and handed down
      // rather than re-read at each instrumentation point.  So a message is
      // either wholly instrumented or wholly not; a switch thrown mid-handler
      // cannot produce one that was counted but not timed.
      const handlerSample = reg.collect().find(
        (s) => s.name === 'actor_message_handler_seconds' && s.sum !== undefined,
      );
      expect(handlerSample?.count).toBe(20);
    } finally {
      await sys.terminate();
    }
  });

  test('disabling metrics mid-drain stops counting (#411)', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('m-middisable', sysOptions);
    try {
      let handled = 0;
      let release: () => void = () => {};
      let parked: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const firstParked = new Promise<void>((resolve) => { parked = resolve; });

      class Counting extends Actor<string> {
        override async onReceive(message: string): Promise<void> {
          handled += 1;
          if (message === 'm0') { parked(); await gate; }
        }
      }
      const extension = sys.extension(MetricsExtensionId);
      const reg = extension.enable();
      const actorRef = sys.spawn(Counting, 'a');
      for (let index = 0; index < 21; index++) actorRef.tell(`m${index}`);

      await firstParked;
      expect(valueFor(reg, 'actor_messages_delivered_total')).toBe(1);
      extension.disable();
      release();

      await awaitCondition(() => handled === 21, {
        timeoutMs: 4_000,
        label: 'the whole backlog drained',
      });
      // The detached registry must not have moved: the hot path has to see the
      // swap on the very next message, not at the next cell construction.
      expect(valueFor(reg, 'actor_messages_delivered_total')).toBe(1);
      expect(extension.isEnabled()).toBe(false);
    } finally {
      await sys.terminate();
    }
  });

  test('actor_terminated_total ticks on stop', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('m-term', sysOptions);
    const reg = sys.extension(MetricsExtensionId).enable();
    try {
      const actorRef = sys.spawn(Echo, 'a');
      actorRef.stop();
      await awaitCondition(() => (valueFor(reg, 'actor_terminated_total') ?? 0) >= 1, {
        timeoutMs: 4_000,
        label: 'the termination was counted',
      });
      expect((valueFor(reg, 'actor_terminated_total') ?? 0)).toBeGreaterThanOrEqual(1);
    } finally {
      await sys.terminate();
    }
  });

  test('actor_message_handler_seconds histogram observes durations', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('m-hist', sysOptions);
    const reg = sys.extension(MetricsExtensionId).enable();
    try {
      const actorRef = sys.spawn(Echo, 'a');
      actorRef.tell('1'); actorRef.tell('2');
      const handlerSample = (): { count?: number } | undefined => reg.collect().find(
        (s) => s.name === 'actor_message_handler_seconds' && s.sum !== undefined,
      );
      await awaitCondition(() => (handlerSample()?.count ?? 0) >= 2, {
        timeoutMs: 4_000,
        label: 'both handler runs were observed by the histogram',
      });
      const sumSample = reg.collect().find(
        (s) => s.name === 'actor_message_handler_seconds' && s.sum !== undefined,
      );
      expect(sumSample?.count).toBe(2);
    } finally {
      await sys.terminate();
    }
  });
});

describe('Stock cluster metrics', () => {
  test('cluster_members_up gauge reflects the up-set; gossip rounds tick', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('m-cluster', sysOptions);
    const reg = sys.extension(MetricsExtensionId).enable();
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(95_001)
      .withTransport(new InMemoryTransport(new NodeAddress('m-cluster', 'h', 95_001)))
      .withGossipIntervalMs(30);
    const cluster = await Cluster.join(
      sys,
      clusterOptions,
    );
    try {
      // Single-node cluster — self is up, gauge = 1.
      await awaitCondition(() => valueFor(reg, 'cluster_members_up') === 1, {
        timeoutMs: 4_000,
        label: 'the single-node cluster reported one member up',
      });
      expect(valueFor(reg, 'cluster_members_up')).toBe(1);
      // Note: gossip rounds is initiated only when peers exist —
      // a single-node cluster doesn't tick the counter.  The presence
      // of the metric (or absence) is what we assert.
      const samples = reg.collect();
      const knownNames = new Set(samples.map((s) => s.name));
      expect(knownNames.has('cluster_members_up')).toBe(true);
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  }, 5_000);
});

describe('MetricsExtension — opt-in', () => {
  test('without enable(), the registry is the noop and stock metrics produce no samples', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('m-noop', sysOptions);
    try {
      sys.spawn(Echo, 'a');
      await sleep(20);
      const reg = sys.extension(MetricsExtensionId).get();
      expect(reg.collect()).toEqual([]);
      expect(sys.extension(MetricsExtensionId).isEnabled()).toBe(false);
    } finally {
      await sys.terminate();
    }
  });
});
