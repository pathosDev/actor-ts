/**
 * DistributedData gossip respects the wire frame cap (#691).
 *
 * `gossipTick` used to serialise the entire key set into one `ddata-gossip`
 * frame with no size check anywhere on the send path — `writeFrame` guards
 * serialisability only, and `encodeFrame` writes the payload length into the
 * header without comparing it to anything.  Past the receiver's
 * `maxFrameBytes` the frame is rejected on its 4-byte length prefix, *before*
 * any payload byte is buffered, and `TcpTransport.onData` answers that decoder
 * throw by dropping the connection.  So an oversized store did not converge
 * slowly: not one key ever reached `onGossip`, on that tick or any later one,
 * while the link — carrying heartbeats, membership gossip and every cross-node
 * `tell` — died once per gossip interval and reconnected to die again.
 *
 * **Why this file cannot use a bare `InMemoryTransport`, which is how the
 * defect survived.**  Every other DistributedData unit test drives
 * `InMemoryTransport`, which hands the message *object* to the peer through a
 * microtask: no `encodeFrame`, no `FrameDecoder`, no `maxFrameBytes` at all.
 * The bug is structurally invisible through it, and a test that only checked
 * "a gossip frame was sent" passes against the broken code.  So the transport
 * below wraps one, declares a cap, and every assertion runs the captured frame
 * through a real {@link FrameDecoder} holding that same cap — the exact
 * comparison that kills the association in production.
 *
 * The assertions are on *every* frame plus eventual arrival of the full key
 * set, because either one alone is satisfiable by a broken fix: capping
 * without a cursor keeps the frames small and never sends the tail, and a
 * cursor without a measured budget keeps converging and keeps overflowing.
 *
 * The store shapes are deliberately **few and large**.  A fix that batched by
 * key *count* rather than by measured bytes passes a many-small-keys test and
 * fails here, which is the case AC3 of the issue is actually about: nothing
 * bounds a CRDT's byte size — `MAX_CRDT_ENTRIES` bounds an entry count — so a
 * handful of legitimate values reach the cap on their own.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport, type Transport, type WireHandler } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame, FrameDecoder, type WireMessage } from '../../../src/cluster/Protocol.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { LogLevel, type Logger } from '../../../src/Logger.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { DistributedDataId, DistributedDataOptions, GSet } from '../../../src/crdt/index.js';
// Not re-exported from the crdt barrel, though it is what `start()` returns —
// so it is imported the way `src/cluster/sharding/CoordinatorState.ts` does.
import type { DistributedDataHandle } from '../../../src/crdt/DistributedData.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * Size of the wire format's length prefix.  Not exported from `Protocol.ts`,
 * so it is restated — and never trusted on its own: every numeric assertion
 * below is paired with a `FrameDecoder` push, which would reject a frame this
 * constant mis-sized in the lenient direction.
 */
const FRAME_HEADER_BYTES = 4;

/**
 * The cap every node in this file runs with — small enough that a few
 * kilobyte-sized values cross it, so the multi-tick sweep happens within a
 * test's budget instead of needing a 16 MiB store.
 */
const FRAME_CAP_BYTES = 4_096;

/** Gossip period for the replicator under test: fast, so ticks are cheap. */
const GOSSIP_INTERVAL_MS = 20;

type LogRecord = { readonly level: string; readonly message: string };

/** Collects everything the system logger was told, including via `withSource`. */
class RecordingLogger implements Logger {
  readonly records: LogRecord[] = [];

  constructor(
    readonly level: LogLevel = LogLevel.Debug,
    private readonly root: RecordingLogger | null = null,
  ) {}

  private get sink(): RecordingLogger { return this.root ?? this; }

  private record(level: string, message: string): void {
    this.sink.records.push({ level, message });
  }

  debug(message: string): void { this.record('debug', message); }
  info(message: string): void { this.record('info', message); }
  warn(message: string): void { this.record('warn', message); }
  error(message: string): void { this.record('error', message); }

  withSource(_source: string): Logger { return new RecordingLogger(this.level, this.sink); }
  withFields(_fields: LogContextData): Logger { return new RecordingLogger(this.level, this.sink); }
}

/**
 * An `InMemoryTransport` that declares a frame cap and keeps every message it
 * was asked to send.
 *
 * A decorator rather than a fork: delivery, the peer registry and the two-tier
 * inbound guard stay exactly the shipped in-memory behaviour, so the only
 * difference from the harness every sibling test uses is that this one can be
 * *asked* what it would have put on a wire.  It does not enforce the cap —
 * enforcement is the receiver's job and the assertions reproduce it — because
 * a transport that refused oversized frames itself would make the send-side fix
 * untestable by hiding the very frames under test.
 */
class FrameCapturingTransport implements Transport {
  readonly sent: WireMessage[] = [];

  constructor(
    private readonly inner: InMemoryTransport,
    readonly maxFrameBytes: number,
  ) {}

  get self(): NodeAddress { return this.inner.self; }

  start(): Promise<void> { return this.inner.start(); }
  shutdown(): Promise<void> { return this.inner.shutdown(); }
  setHandler(handler: WireHandler): void { this.inner.setHandler(handler); }

  send(to: NodeAddress, message: WireMessage): void {
    this.sent.push(message);
    this.inner.send(to, message);
  }

  disconnect(peer: NodeAddress): void { this.inner.disconnect(peer); }
  peers(): NodeAddress[] { return this.inner.peers(); }

  /**
   * Only the replicator's frames — membership and heartbeats share the wire.
   *
   * Widened before the comparison because `WireMessage` names only the built-in
   * kinds: every extension registers its own through `Cluster._onWire` and
   * casts on the way out, which is why `'ddata-gossip'` is not in that union.
   */
  gossipFrames(): WireMessage[] {
    return this.sent.filter((message) => (message as { kind: string }).kind === 'ddata-gossip');
  }
}

/** Payload length the receiver's decoder compares against its cap. */
function payloadBytesOf(message: WireMessage): number {
  return encodeFrame(message).byteLength - FRAME_HEADER_BYTES;
}

/**
 * The production consequence, reproduced: would a peer holding `cap` accept
 * this frame, or throw and cost the association?
 */
function decoderAccepts(message: WireMessage, cap: number): boolean {
  try {
    new FrameDecoder(cap).push(encodeFrame(message));
    return true;
  } catch {
    return false;
  }
}

/** Keys named in a frame's `entries` map. */
function keysIn(message: WireMessage): string[] {
  const entries = (message as unknown as { entries: Record<string, unknown> }).entries;
  return Object.keys(entries);
}

/** The replicator's "this key cannot be gossiped" lines, in order. */
function warningsOf(node: Node): string[] {
  return node.log.records
    .filter((record) => record.level === 'warn' && record.message.includes('out of gossip'))
    .map((record) => record.message);
}

/**
 * The replicator's "this key is large but travelling" lines, in order (#856).
 *
 * A different substring from {@link warningsOf} on purpose: the two lines are
 * emitted from different reporters behind different rate limiters, and a
 * filter loose enough to catch both would make every assertion below satisfied
 * by the oversize warning that was already there.
 */
function sizeWarningsOf(node: Node): string[] {
  return node.log.records
    .filter((record) => record.level === 'warn' && record.message.includes('reporting threshold'))
    .map((record) => record.message);
}

type Node = {
  readonly cluster: Cluster;
  readonly transport: FrameCapturingTransport;
  readonly log: RecordingLogger;
};

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

async function startNode(name: string, port: number, seeds?: string[]): Promise<Node> {
  const log = new RecordingLogger();
  const system = ActorSystem.create(name, ActorSystemOptions.create().withLogger(log));
  systems.push(system);
  const address = new NodeAddress(name, 'h', port);
  const transport = new FrameCapturingTransport(new InMemoryTransport(address), FRAME_CAP_BYTES);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(transport)
    .withGossipIntervalMs(80);
  if (seeds !== undefined) clusterOptions.withSeeds(seeds);
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return { cluster, transport, log };
}

type Pair = {
  readonly a: Node;
  readonly b: Node;
  readonly handleA: DistributedDataHandle;
  readonly handleB: DistributedDataHandle;
};

/**
 * Two joined nodes, both running the replicator, so a frame leaving A can be
 * observed *and* its effect on B's store read back.  Node B needs the
 * extension for the convergence half — without it there is no `onGossip` to
 * merge anything and "the key set arrived" is unobservable.
 */
async function twoReplicas(prefix: string, basePort: number, options?: DistributedDataOptions): Promise<Pair> {
  const a = await startNode(`${prefix}-a`, basePort);
  const b = await startNode(`${prefix}-b`, basePort + 1, [`${prefix}-a@h:${basePort}`]);
  await awaitCondition(() => a.cluster.upMembers().length >= 2 && b.cluster.upMembers().length >= 2, {
    timeoutMs: 4_000,
    intervalMs: 10,
    label: 'the two-node cluster converged',
  });
  const optionsA = options ?? gossipOptions();
  const optionsB = gossipOptions();
  const handleA = a.cluster.system.extension(DistributedDataId).start(a.cluster, optionsA);
  const handleB = b.cluster.system.extension(DistributedDataId).start(b.cluster, optionsB);
  return { a, b, handleA, handleB };
}

/** The replicator options every node here shares unless a test overrides them. */
function gossipOptions(): DistributedDataOptions {
  return DistributedDataOptions.create().withGossipInterval(GOSSIP_INTERVAL_MS);
}

/**
 * Seed `count` keys, each carrying `bytes`-ish of payload in a one-element
 * `GSet`.  Few and large on purpose — see this file's header for why a
 * count-based batch has to fail here.
 */
function seedKeys(handle: DistributedDataHandle, count: number, bytes: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    const key = `key-${i}`;
    keys.push(key);
    handle.update<GSet<string>>(key, () => GSet.empty<string>(), (set) => set.add(`${i}:${'x'.repeat(bytes)}`));
  }
  return keys;
}

describe('#691 — a gossip frame never outgrows the transport frame cap', () => {
  test('every outbound frame is one a peer holding the same cap accepts', async () => {
    const { a, handleA } = await twoReplicas('cap-frames', 49_501);
    // 8 × ~1 200 bytes ≈ 9.6 KiB against a 4 096-byte cap: three-ish frames.
    // One frame would be 2.3× the cap, and so would any count-based batch that
    // did not measure — which is the fix this assertion has to reject.
    seedKeys(handleA, 8, 1_200);

    await awaitCondition(() => a.transport.gossipFrames().length >= 4, {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'the replicator emitted several gossip frames',
    });

    const frames = a.transport.gossipFrames();
    const oversized = frames.filter((frame) => !decoderAccepts(frame, FRAME_CAP_BYTES));
    expect(oversized.map((frame) => payloadBytesOf(frame))).toEqual([]);
    for (const frame of frames) {
      expect(payloadBytesOf(frame)).toBeLessThanOrEqual(FRAME_CAP_BYTES);
    }
    // And it really did slice: a single frame carrying all eight keys would
    // satisfy nothing above only because it was rejected, not because it fit.
    expect(Math.max(...frames.map((frame) => keysIn(frame).length))).toBeLessThan(8);
  });

  test('the whole key set still converges, across as many ticks as it takes', async () => {
    const { handleA, handleB } = await twoReplicas('cap-converge', 49_511);
    const keys = seedKeys(handleA, 8, 1_200);

    await awaitCondition(() => keys.every((key) => handleB.get<GSet<string>>(key) !== undefined), {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'every key reached the peer replica',
    });

    for (const key of keys) {
      expect(handleB.get<GSet<string>>(key)?.value()).toEqual(handleA.get<GSet<string>>(key)?.value());
    }
  });

  test('a key too large for any frame is warned about, with its size and the store size', async () => {
    const { a, handleA } = await twoReplicas('cap-oversize', 49_521);
    const registry = a.cluster.system.extension(MetricsExtensionId).enable();
    // A value past the whole cap.  Nothing bounds a CRDT's byte size —
    // `MAX_CRDT_ENTRIES` bounds an entry *count* — so this is a legitimate,
    // perfectly decodable store, not a hostile one.
    handleA.update<GSet<string>>('too-big', () => GSet.empty<string>(), (set) => set.add('y'.repeat(FRAME_CAP_BYTES * 2)));

    // Seeded alone, and asserted before anything else is added, because the
    // warning is rate-limited: only the first one in the window is emitted, so
    // the store size it quotes is the size at that moment and a test that
    // seeded more keys first would be racing its own setup.
    await awaitCondition(() => warningsOf(a).length > 0, {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'the replicator warned about the key it cannot gossip',
    });

    const warning = warningsOf(a)[0]!;
    expect(warning).toContain('"too-big"');
    // The measured size of the offending value, and the store size — the two
    // numbers the issue asks the warning to carry.
    expect(warning).toMatch(/at \d+ bytes/);
    expect(warning).toContain('of 1 key(s) out of gossip');
    // Named so the line is actionable rather than merely alarming.
    expect(warning).toContain('max-gossip-bytes');
    expect(registry.counter('distributed_data_gossip_skipped_keys_total', { reason: 'oversize' }).value)
      .toBeGreaterThan(0);
  });

  test('the keys behind an oversized one still gossip', async () => {
    const { a, handleA, handleB } = await twoReplicas('cap-skip', 49_551);
    handleA.update<GSet<string>>('too-big', () => GSet.empty<string>(), (set) => set.add('y'.repeat(FRAME_CAP_BYTES * 2)));
    const small = seedKeys(handleA, 3, 200);

    await awaitCondition(() => small.every((key) => handleB.get<GSet<string>>(key) !== undefined), {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'the keys that fit reached the peer replica',
    });

    // Stepped over, not waited for.  Parked on itself, an unsendable key would
    // hold the cursor and starve everything behind it for the life of the
    // process — one divergent key turning into a store that stops converging.
    expect(handleB.get('too-big')).toBeUndefined();
    for (const frame of a.transport.gossipFrames()) {
      expect(decoderAccepts(frame, FRAME_CAP_BYTES)).toBe(true);
      expect(keysIn(frame)).not.toContain('too-big');
    }
  });

  test('a configured budget above the transport cap is clamped down to it', async () => {
    // The configuration that reintroduces the defect if the clamp is missing:
    // `remote.max-frame-bytes` lowered for a semi-trusted network (which
    // `ClusterOptions.maxFrameBytes` explicitly recommends) while the
    // replicator still believes it may fill 1 MiB.
    const generous = DistributedDataOptions.create()
      .withGossipInterval(GOSSIP_INTERVAL_MS)
      .withMaxGossipBytes(1024 * 1024);
    const { a, handleA } = await twoReplicas('cap-clamp', 49_531, generous);
    seedKeys(handleA, 8, 1_200);

    await awaitCondition(() => a.transport.gossipFrames().length >= 4, {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'the replicator emitted several gossip frames',
    });

    for (const frame of a.transport.gossipFrames()) {
      expect(payloadBytesOf(frame)).toBeLessThanOrEqual(FRAME_CAP_BYTES);
      expect(decoderAccepts(frame, FRAME_CAP_BYTES)).toBe(true);
    }
  });

  test('a store that fits keeps travelling in one frame', async () => {
    // The other direction: slicing must not become the normal case.  A small
    // store is what DistributedData is built for, and a cursor that dribbled
    // one key per tick would be a regression nothing else here would catch.
    const { a, handleA, handleB } = await twoReplicas('cap-small', 49_541);
    const keys = seedKeys(handleA, 5, 40);

    await awaitCondition(() => keys.every((key) => handleB.get<GSet<string>>(key) !== undefined), {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'the small store reached the peer replica',
    });

    const frames = a.transport.gossipFrames();
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(keysIn(frame).length).toBe(keys.length);
    }
  });
});

/**
 * #856 — `log-data-size-exceeding` names a key that is large but still fits.
 *
 * The gap it closes sits *under* everything the suite above tests.  A key past
 * the whole frame budget is skipped, warned about and counted; a key at a
 * large fraction of it travels perfectly and is invisible, while consuming
 * that fraction of every tick it appears in and slowing the sweep for
 * everything else in the store.  Nothing anywhere said so.
 *
 * Every assertion below therefore pairs the warning with **convergence**: a
 * threshold implemented as a second skip would satisfy "it warned" and be a
 * far worse bug than the silence it replaced, so "the key still reached the
 * peer" is asserted in the same test rather than in a sibling.
 */
describe('#856 — a large-but-sendable key is reported without being skipped', () => {
  test('a key over the threshold is named, and still converges on the peer', async () => {
    const reportingOptions = DistributedDataOptions.create()
      .withGossipInterval(GOSSIP_INTERVAL_MS)
      .withLogDataSizeExceeding(500);
    const { a, handleA, handleB } = await twoReplicas('size-warn', 49_561, reportingOptions);
    // ~1 230 measured bytes: comfortably over the 500-byte threshold and
    // comfortably under the 4 096-byte frame cap, which is the whole band this
    // option exists for.
    seedKeys(handleA, 1, 1_200);

    await awaitCondition(() => sizeWarningsOf(a).length > 0, {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'the replicator reported the large key',
    });

    const warning = sizeWarningsOf(a)[0]!;
    expect(warning).toContain('"key-0"');
    expect(warning).toMatch(/at \d+ bytes/);
    // Actionable, not merely alarming — the same standard the oversize line is
    // held to two describes up.
    expect(warning).toContain('log-data-size-exceeding');

    // The half that separates a report from a second cap.
    await awaitCondition(() => handleB.get<GSet<string>>('key-0') !== undefined, {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'the reported key reached the peer replica anyway',
    });
    expect(handleB.get<GSet<string>>('key-0')?.value())
      .toEqual(handleA.get<GSet<string>>('key-0')?.value());
    // And it was never counted as a skip: the two conditions share a packer
    // loop, so a fix that reported by reusing the skip path would pass every
    // assertion above.
    expect(warningsOf(a)).toEqual([]);
  });

  test('0 never reports, however large the key', async () => {
    const silentOptions = DistributedDataOptions.create()
      .withGossipInterval(GOSSIP_INTERVAL_MS)
      .withLogDataSizeExceeding(0);
    const { a, handleA, handleB } = await twoReplicas('size-off', 49_571, silentOptions);
    seedKeys(handleA, 1, 1_200);

    // Waited on the convergence rather than on a timer: it is the observable
    // proof that the packer measured this key, so the absence asserted
    // afterwards is an absence of *reporting* and not of activity.
    await awaitCondition(() => handleB.get<GSet<string>>('key-0') !== undefined, {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'the key reached the peer replica',
    });

    expect(sizeWarningsOf(a)).toEqual([]);
  });

  test('a key under the threshold is not reported', async () => {
    // The other direction: a threshold that fired on everything would pass the
    // first test here and be worthless in production.
    const reportingOptions = DistributedDataOptions.create()
      .withGossipInterval(GOSSIP_INTERVAL_MS)
      .withLogDataSizeExceeding(2_000);
    const { a, handleA, handleB } = await twoReplicas('size-under', 49_581, reportingOptions);
    const keys = seedKeys(handleA, 3, 200);

    await awaitCondition(() => keys.every((key) => handleB.get<GSet<string>>(key) !== undefined), {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'every small key reached the peer replica',
    });

    expect(sizeWarningsOf(a)).toEqual([]);
  });

  test('an oversized key is reported by BOTH lines, on independent quiet periods', async () => {
    // The placement decision, made observable.  The size check runs before the
    // budget check, so a key past the frame budget trips both — and it must,
    // because raising `max-gossip-bytes` is precisely the fix for the oversize
    // line and precisely the change that makes the size line more relevant.
    // Sharing one timestamp between the two reporters would let the first
    // suppress the second for a minute at a time, which is why they do not.
    const reportingOptions = DistributedDataOptions.create()
      .withGossipInterval(GOSSIP_INTERVAL_MS)
      .withLogDataSizeExceeding(500);
    const { a, handleA } = await twoReplicas('size-both', 49_591, reportingOptions);
    handleA.update<GSet<string>>('too-big', () => GSet.empty<string>(), (set) => set.add('y'.repeat(FRAME_CAP_BYTES * 2)));

    await awaitCondition(() => warningsOf(a).length > 0 && sizeWarningsOf(a).length > 0, {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'the replicator emitted both the skip line and the size line',
    });

    expect(warningsOf(a)[0]).toContain('"too-big"');
    expect(sizeWarningsOf(a)[0]).toContain('"too-big"');
  });
});
