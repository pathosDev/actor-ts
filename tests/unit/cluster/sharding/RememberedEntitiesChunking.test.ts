/**
 * A shard's remembered registry crosses the wire in frames the peer accepts
 * (#1825).
 *
 * `ShardCoordinator.shipRememberedEntities` used to put a shard's whole
 * registry into one `sharding.RememberedEntities` message.  Since #1267 a shard
 * may remember up to 100 000 ids of up to 1 024 characters each, which is up
 * to ~100 MB of payload against a 16 MiB default `max-frame-bytes` — and a
 * peer rejects a frame past its cap on the length prefix and drops the
 * connection.  The region then never learns which entities to start.
 *
 * ## Why the transport is wrapped
 *
 * `InMemoryTransport` hands the message *object* to the peer: no
 * `encodeFrame`, no `FrameDecoder`, no cap.  The defect is invisible through
 * it — the same trap `DistributedDataGossipFrameCap.test.ts` (#691) documents.
 * So the transport below declares a cap, as `TcpTransport` does, and enforces
 * it the way the receiving side would: a frame whose encoded payload a
 * `FrameDecoder` holding that cap refuses never arrives.  Every frame it was
 * asked to send is kept, so the assertions can read the sizes too.
 *
 * ## The shape
 *
 * Two nodes.  The first is the leader, so it hosts the coordinator, and it
 * runs the type as a proxy, so the only region that can own the shard is on
 * the other node — every registry the coordinator ships crosses the wire.  The
 * registry is preloaded through a remember store, so the entities exist only
 * in it: one message for one of them allocates the shard, the coordinator
 * ships the registry, and every other entity can start only from what arrived.
 * One shard, so the first chunk creates the shard and every later chunk lands
 * on a shard that is already running.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport, type Transport, type WireHandler } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { encodeFrame, FrameDecoder, type WireMessage } from '../../../../src/cluster/Protocol.js';
import type { RememberEntitiesStore, RememberEvent } from '../../../../src/cluster/sharding/RememberEntitiesStore.js';
import { rememberedEntityChunks } from '../../../../src/cluster/sharding/ShardCoordinator.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import type { EntityRecoveryStrategy } from '../../../../src/cluster/sharding/ShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const TYPE_NAME = 'entity';

/**
 * The cap both nodes run with.  Small, so a few hundred ids cross it instead
 * of the hundred thousand the default 16 MiB would need — and still several
 * times what membership gossip and heartbeats between two nodes cost.
 */
const FRAME_CAP_BYTES = 8_192;

/** Ids in the preloaded registry: together several times {@link FRAME_CAP_BYTES}. */
const REMEMBERED_COUNT = 300;

type WorkCommand = { readonly kind: 'work'; readonly id: string };

type Command = WorkCommand;

/** Every entity id that reached `preStart`. */
const started = new Set<string>();

class Entity extends Actor<Command> {
  override preStart(): void { started.add(this.entityId); }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { /* the start is the observation */ }
}

/**
 * An `InMemoryTransport` that declares a frame cap and enforces it the way a
 * receiving `TcpTransport` does: a frame its `FrameDecoder` would refuse is
 * not delivered.  Every frame it was asked to send is kept.
 */
class FrameCappedTransport implements Transport {
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
    if (!decoderAccepts(message, this.maxFrameBytes)) return;
    this.inner.send(to, message);
  }

  disconnect(peer: NodeAddress): void { this.inner.disconnect(peer); }
  peers(): NodeAddress[] { return this.inner.peers(); }

  /** The envelopes carrying a `sharding.RememberedEntities` body. */
  rememberedFrames(): WireMessage[] {
    return this.sent.filter((message) => {
      const body = (message as { kind: string; body?: { kind?: unknown } }).body;
      return (message as { kind: string }).kind === 'envelope' && body?.kind === 'sharding.RememberedEntities';
    });
  }
}

/** Would a peer whose decoder holds `cap` accept this frame? */
function decoderAccepts(message: WireMessage, cap: number): boolean {
  try {
    new FrameDecoder(cap).push(encodeFrame(message));
    return true;
  } catch {
    return false;
  }
}

/** A registry loaded once, never written back: the coordinator only reads it here. */
class PreloadedRememberStore implements RememberEntitiesStore {
  constructor(private readonly events: RememberEvent[]) {}

  append(_typeName: string, _event: RememberEvent): Promise<void> { return Promise.resolve(); }
  load(_typeName: string): Promise<RememberEvent[]> { return Promise.resolve(this.events); }
  clear(_typeName: string): Promise<void> { return Promise.resolve(); }
}

/** Ids long enough that {@link REMEMBERED_COUNT} of them overflow one frame several times. */
function rememberedIds(): string[] {
  return Array.from({ length: REMEMBERED_COUNT }, (_, index) => `entity-${String(index).padStart(4, '0')}-${'x'.repeat(90)}`);
}

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  await Promise.all(clusters.splice(0).map((cluster) => cluster.leave().catch(() => { /* best-effort */ })));
  await Promise.all(systems.splice(0).map((system) => system.terminate().catch(() => { /* best-effort */ })));
  started.clear();
});

type Node = { readonly cluster: Cluster; readonly transport: FrameCappedTransport };

async function startNode(name: string, port: number, seeds: string[]): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  const transport = new FrameCappedTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)), FRAME_CAP_BYTES);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(transport)
    .withGossipIntervalMs(40);
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return { cluster, transport };
}

async function shipRegistry(prefix: string, basePort: number, strategy: EntityRecoveryStrategy): Promise<{
  readonly coordinatorNode: Node;
  readonly ids: string[];
}> {
  const a = await startNode(`${prefix}-a`, basePort, []);
  const b = await startNode(`${prefix}-b`, basePort + 1, [`${prefix}-a@h:${basePort}`]);
  await awaitCondition(() => a.cluster.upMembers().length === 2 && b.cluster.upMembers().length === 2, {
    timeoutMs: 4_000,
    intervalMs: 10,
    label: 'the two-node cluster converged',
  });
  // The coordinator runs on the leader; the shape needs it on the proxy node.
  expect(a.cluster.leader().map((member) => member.address.equals(a.cluster.selfAddress)).getOrElse(false)).toBe(true);

  const ids = rememberedIds();
  const store = new PreloadedRememberStore(ids.map((entityId) => ({ kind: 'started', shardId: 0, entityId })));
  const shardingOptions = (proxy: boolean): StartShardingOptions<Command> => StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(1)
    .withProxy(proxy)
    .withRememberEntities(true)
    .withRememberEntitiesStore(store)
    .withEntityRecoveryStrategy(strategy)
    .withEntityRecoveryConstantRateFrequencyMs(10)
    .withEntityRecoveryConstantRateNumberOfEntities(50)
    .withPassivationIdleMs(0);
  a.cluster.sharding.start<Command>(shardingOptions(true));
  const region = b.cluster.sharding.start<Command>(shardingOptions(false));

  region.tell({ kind: 'work', id: ids[0]! });
  await awaitCondition(() => started.size === ids.length, {
    timeoutMs: 8_000,
    intervalMs: 20,
    label: `all ${ids.length} remembered entities started on the hosting region`,
  });
  return { coordinatorNode: a, ids };
}

describe('remembered registry in chunks below the frame cap (#1825)', () => {
  for (const [strategy, basePort] of [['all', 18_250], ['constant-rate', 18_260]] as const) {
    test(`a registry larger than one frame reaches the region and every entity starts (${strategy})`, async () => {
      const { coordinatorNode, ids } = await shipRegistry(`chunks-${strategy}`, basePort, strategy);

      expect(new Set(started)).toEqual(new Set(ids));
      const frames = coordinatorNode.transport.rememberedFrames();
      // More than one: the registry does not fit one frame, which is the case under test.
      expect(frames.length).toBeGreaterThan(1);
      for (const frame of frames) expect(decoderAccepts(frame, FRAME_CAP_BYTES)).toBe(true);
      const shipped = frames.flatMap((frame) => (frame as unknown as { body: { entityIds: string[] } }).body.entityIds);
      expect(new Set(shipped)).toEqual(new Set(ids));
    }, 20_000);
  }
});

describe('rememberedEntityChunks', () => {
  /** Bytes the ids of one chunk cost as a JSON array — what the frame carries for them. */
  const arrayBytes = (chunk: readonly string[]): number => new TextEncoder().encode(JSON.stringify(chunk)).byteLength;

  test('worst-case ids — 1 024 characters, multi-byte and escaped — stay inside the budget', () => {
    const budget = 64 * 1024;
    // Three bytes per character in UTF-8, six per character JSON escapes: the
    // two ways an id's wire size outgrows its length.
    const ids = Array.from({ length: 400 }, (_, index) => {
      const filler = index % 2 === 0 ? '€'.repeat(1_020) : '\u0001'.repeat(1_020);
      return `${String(index).padStart(4, '0')}${filler}`;
    });
    const chunks = rememberedEntityChunks(ids, budget);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(arrayBytes(chunk)).toBeLessThanOrEqual(budget);
    expect(chunks.flat()).toEqual(ids);
  });

  test('an id larger than the budget travels alone rather than never', () => {
    const ids = ['a'.repeat(200), 'b', 'c'];
    const chunks = rememberedEntityChunks(ids, 64);
    expect(chunks).toEqual([['a'.repeat(200)], ['b', 'c']]);
  });

  test('the budget counts the brackets and the commas, to the byte', () => {
    // `["a","b","c"]` is 13 bytes: three 3-byte strings, two commas, two brackets.
    expect(arrayBytes(['a', 'b', 'c'])).toBe(13);
    expect(rememberedEntityChunks(['a', 'b', 'c'], 13)).toEqual([['a', 'b', 'c']]);
    expect(rememberedEntityChunks(['a', 'b', 'c'], 12)).toEqual([['a', 'b'], ['c']]);
  });

  test('a registry that fits travels in one chunk', () => {
    expect(rememberedEntityChunks(['a', 'b', 'c'], 1_024)).toEqual([['a', 'b', 'c']]);
  });
});
