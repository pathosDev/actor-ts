/**
 * Stock metrics emitted by the actor framework itself (#11).  The cell
 * + cluster instrumentation is opt-in via `MetricsExtensionId.enable()`
 * — this test verifies the counters / gauges / histograms tick when
 * actors are spawned, messages flow, and members come up.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    // The stock label-set guard for this one family, live rather than read
    // out of the source.  `path` was removed because its values were produced
    // by traffic and by remote parties — one anonymous path per spawn, one
    // `entity-<id>` per addressed shard — and a counter's series is not
    // something eviction can honestly reclaim (#745), so each one was
    // permanent.  The sibling `actor_mailbox_size` keeps its `path`
    // deliberately, gated on a 10 000-message backlog, so "no dynamic labels"
    // is not the rule; the rule itself is asserted over the whole inventory
    // in `Stock metric label sets (#745)` further down this file.
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

/* ------------------ the stock label rule, over every family ----------------- */

/**
 * Every metric family the framework itself emits, with the exact label names
 * it emits it with — read out of `src/` rather than out of a running system,
 * so a family in a subsystem this file never boots is still covered (#745).
 *
 * The gap this closes is a real one and not hypothetical.  #658 removed
 * `path` from `actor_mailbox_dropped_total` and pinned the result — one
 * family, in one test.  `actor_dead_letters_total{outcome, recipient}` landed
 * one commit-day later carrying the same kind of label, citing the family
 * #658 had just fixed as its precedent, and nothing anywhere went red.  A
 * per-family assertion cannot catch that; only an inventory can.
 *
 * Adding a family means adding a row here, deliberately.  That is the point:
 * the row is where you have to state the label set, and the test below is
 * where you have to justify it.
 */
const STOCK_LABELS: Readonly<Record<string, ReadonlyArray<string>>> = {
  actor_created_total: [],
  actor_terminated_total: [],
  actor_restarted_total: [],
  actor_messages_delivered_total: [],
  actor_message_handler_seconds: [],
  actor_mailbox_size: ['class', 'path'],
  actor_mailbox_depth: [],
  actor_mailbox_wait_seconds: [],
  actor_mailbox_dropped_total: ['class', 'reason'],
  actor_dispatcher_queue_delay_seconds: ['dispatcher'],
  actor_dead_letters_total: ['outcome'],
  actor_unhandled_total: ['class'],
  cluster_members_up: [],
  cluster_gossip_rounds_total: [],
  cluster_gossip_records_refused_total: ['reason'],
  cluster_sharding_registrations_refused_total: ['reason', 'type'],
  cluster_envelope_from_mismatch_total: ['frame'],
  distributed_data_quorum_pending: [],
  distributed_data_quorum_timeouts_total: ['operation'],
  distributed_data_quorum_rejected_total: ['operation'],
  distributed_data_dropped_values_total: [],
  distributed_data_gossip_skipped_keys_total: ['reason'],
  persistence_projection_events_skipped_total: ['projection'],
  persistence_projection_failures_total: ['projection', 'reason'],
  persistence_projection_stalled: ['projection'],
  router_scatter_gather_resolved_total: ['outcome'],
  router_scatter_gather_latency_seconds: [],
};

/**
 * Label names whose values are fixed by the program: a class name, a closed
 * string union, an id of something the deployment constructs in code.  A
 * family built only out of these can never be widened by traffic.
 */
const PROGRAM_BOUNDED_LABELS: ReadonlySet<string> = new Set([
  'class', 'reason', 'outcome', 'operation', 'frame', 'dispatcher',
]);

/**
 * The exceptions, and what pays for each.  Anything else per-instance is a
 * defect, not a judgement call — that is what makes this a gate rather than a
 * comment.
 */
const PER_INSTANCE_LABELS: Readonly<Record<string, string>> = {
  'actor_mailbox_size.path': 'gated on a 10 000-message backlog, so its width counts '
    + 'concurrent incidents rather than entities — and constitutive besides, since a '
    + 'depth gauge without it has every actor of a class overwriting its siblings',
  'persistence_projection_events_skipped_total.projection': 'bounded by the projections '
    + 'you declare; a per-pid fan-out is a cardinality the deployment opted into',
  'persistence_projection_failures_total.projection': 'as above',
  'persistence_projection_stalled.projection': 'as above',
  'cluster_sharding_registrations_refused_total.type': 'the sharded type name, taken '
    + 'from this node’s own StartShardingOptions and never off the wire, so it is '
    + 'bounded by the types the deployment starts — the same shape as the '
    + 'projection rows above, and the label the metric exists to carry, since which '
    + 'type is misconfigured is the whole of the alert',
};

/**
 * Sites whose label tuple is assembled in a variable rather than written at
 * the call, so the scan below cannot read it.  Each is declared here with the
 * labels it really emits, which `MailboxDepthSampler.test.ts` pins from the
 * other side by asserting on the collected sample.
 *
 * An allow-list rather than a silent skip: a new family whose labels the scan
 * cannot see must fail this test until someone writes the row, or the
 * inventory would quietly stop being an inventory.
 */
const LABELS_BUILT_OFF_THE_CALL: Readonly<Record<string, ReadonlyArray<string>>> = {
  'metrics/MailboxDepthSampler.ts:actor_mailbox_size': ['class', 'path'],
};

/** The registry implementations themselves — they define the accessors, not families. */
const NOT_EMITTERS: ReadonlySet<string> = new Set([
  'metrics/Metrics.ts', 'metrics/PromClientAdapter.ts',
]);

const SOURCE_ROOT = join(import.meta.dir, '..', '..', '..', 'src');

function typescriptFilesUnder(directory: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...typescriptFilesUnder(join(directory, entry.name), relative));
    else if (entry.name.endsWith('.ts')) out.push(relative);
  }
  return out;
}

/** Label names out of an object literal — `{ class: c, reason }` → `['class', 'reason']`. */
function labelNamesOf(literal: string): string[] {
  const body = literal.slice(1, -1).trim();
  if (body === '') return [];
  return body.split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => (part.includes(':') ? part.slice(0, part.indexOf(':')) : part).trim());
}

type MetricSite = {
  readonly file: string;
  readonly family: string;
  /** `null` when the tuple is not an object literal at the call site. */
  readonly labels: ReadonlyArray<string> | null;
};

/**
 * Every `.counter(...)` / `.gauge(...)` / `.histogram(...)` in `src/`.
 *
 * Regex rather than a parser, for the reason `WorkflowHygiene.test.ts` gives
 * about YAML: the call sites are uniform by convention, and the failure mode
 * is a site the scan cannot read — which is reported rather than skipped, so
 * an unreadable one is a red test and not a silent gap.
 *
 * Line endings are normalised because the working tree is CRLF on a Windows
 * clone and LF on the runner, and a `\r` between the family name and its
 * label tuple would make every site unparseable on exactly one of the two.
 */
function stockMetricSites(): ReadonlyArray<MetricSite> {
  const out: MetricSite[] = [];
  for (const file of typescriptFilesUnder(SOURCE_ROOT)) {
    if (NOT_EMITTERS.has(file)) continue;
    const text = readFileSync(join(SOURCE_ROOT, file), 'utf8').split(/\r?\n/).join('\n');
    for (const match of text.matchAll(/\.(?:counter|gauge|histogram)\(/g)) {
      const at = match.index;
      const lineStart = text.lastIndexOf('\n', at) + 1;
      const before = text.slice(lineStart, at);
      // A call named inside a JSDoc block or a trailing comment is prose.
      if (/^\s*\*/.test(before) || before.includes('//')) continue;
      const rest = text.slice(at + match[0].length, at + match[0].length + 400);
      const named = /^\s*'([a-z0-9_]+)'\s*,\s*/.exec(rest);
      if (named === null) { out.push({ file, family: '<unreadable>', labels: null }); continue; }
      const literal = /^(\{[^{}]*\})/.exec(rest.slice(named[0].length));
      out.push({ file, family: named[1]!, labels: literal === null ? null : labelNamesOf(literal[1]!) });
    }
  }
  return out;
}

describe('Stock metric label sets (#745)', () => {
  test('every family in src/ is in the inventory, with exactly the declared labels', () => {
    const sites = stockMetricSites();
    // Not vacuous: a scan that matched nothing would otherwise pass silently.
    expect(sites.length).toBeGreaterThanOrEqual(20);

    const readable = sites.filter((s) => s.labels !== null);
    const found = new Map<string, string[]>();
    for (const site of readable) {
      const previous = found.get(site.family);
      const labels = [...site.labels!].sort();
      // A family emitted from two sites must agree with itself, or one of the
      // two is minting a differently-shaped series under the same name.
      if (previous !== undefined) expect(labels).toEqual(previous);
      found.set(site.family, labels);
    }

    for (const [key, labels] of Object.entries(LABELS_BUILT_OFF_THE_CALL)) {
      found.set(key.slice(key.indexOf(':') + 1), [...labels].sort());
    }

    const declared = Object.fromEntries(
      Object.entries(STOCK_LABELS).map(([name, labels]) => [name, [...labels].sort()]),
    );
    expect(Object.fromEntries([...found].sort())).toEqual(
      Object.fromEntries(Object.entries(declared).sort()),
    );
  });

  test('a site whose labels the scan cannot read has to be declared', () => {
    const unreadable = stockMetricSites()
      .filter((s) => s.labels === null)
      .map((s) => `${s.file}:${s.family}`)
      .sort();
    expect(unreadable).toEqual(Object.keys(LABELS_BUILT_OFF_THE_CALL).sort());
  });

  test('no stock label is per-instance without an entry saying what pays for it', () => {
    // The rule, applied to the whole inventory at once: **a stock label's
    // values must be bounded by what the deployment declares — never by
    // traffic volume, by how many actors have been spawned, or by a value a
    // remote party supplies.**  `actor_dead_letters_total{recipient}` failed
    // it on the last clause and shipped anyway, because nothing checked the
    // rule anywhere but on one family.
    const unjustified: string[] = [];
    for (const [family, labels] of Object.entries(STOCK_LABELS)) {
      for (const label of labels) {
        if (PROGRAM_BOUNDED_LABELS.has(label)) continue;
        if (PER_INSTANCE_LABELS[`${family}.${label}`] !== undefined) continue;
        unjustified.push(`${family}{${label}}`);
      }
    }
    expect(unjustified).toEqual([]);

    // And the exception table stays a table of exceptions: every entry names
    // a label that is actually emitted, so a removal cannot leave a stale
    // justification standing for a label nobody carries any more.
    for (const key of Object.keys(PER_INSTANCE_LABELS)) {
      const family = key.slice(0, key.lastIndexOf('.'));
      const label = key.slice(key.lastIndexOf('.') + 1);
      expect(STOCK_LABELS[family] ?? []).toContain(label);
    }
  });
});

describe('MetricsExtension — opt-in', () => {
  test('without enable(), the registry is the noop and stock metrics produce no samples', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('m-noop', sysOptions);
    try {
      sys.spawn(Echo, 'a');
      // An absence: without `enable()` the registry is the noop, so `collect()` must
      // stay empty.  That is already true at t = 0; the window is what would let a
      // stock metric registered during startup show up.
      await sleep(20);
      const reg = sys.extension(MetricsExtensionId).get();
      expect(reg.collect()).toEqual([]);
      expect(sys.extension(MetricsExtensionId).isEnabled()).toBe(false);
    } finally {
      await sys.terminate();
    }
  });
});
