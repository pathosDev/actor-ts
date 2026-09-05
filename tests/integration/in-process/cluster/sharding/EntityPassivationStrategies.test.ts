import { match } from 'ts-pattern';
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../../../src/config/HoconParser.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { Passivate } from '../../../../../src/cluster/sharding/Passivate.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import type { StartShardingOptionsBuilder } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import type { StartEntities } from '../../../../../src/cluster/sharding/ShardingProtocol.js';
import { regionSegments } from '../../../../util/SystemPaths.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

/**
 * `actor-ts.sharding.passivation.*` end to end (#848).
 *
 * The acceptance criterion of the issue is a *comparison*, not a single green
 * run: a hot working set must survive a scan under segmented LRU with an
 * admission filter, and must NOT survive the identical scan under the plain LRU
 * that ships.  All three arms are here, driven through `ClusterSharding.start`
 * so the keys are proved to reach a live region rather than only the reader —
 * and the middle arm (segmented, no filter) is what says which of the two
 * mechanisms carries which entity.
 *
 * `PassivationStrategy.test.ts` is the other half, exercising the policies
 * directly with no cluster in the way.
 */

type WorkCommand = { id: string; kind: 'work' };
type CheckoutCommand = { id: string; kind: 'checkout' };
/**
 * The stop-message a `Passivate` hands back to the entity — and the entity
 * ignores it, which is the whole point.  It carries an `id` like its siblings
 * only so the union stays uniform for `extractEntityId`; nothing ever routes
 * one, the shard delivers it straight to the entity.
 */
type IgnoredStopCommand = { id: string; kind: 'ignored-stop' };

type Command = WorkCommand | CheckoutCommand | IgnoredStopCommand;

const TYPE_NAME = 'entity';
/**
 * One shard, and that is load-bearing rather than a simplification.
 *
 * A region buffers every message whose shard has no home yet and replays the
 * buffer **per shard**, so with several shards the order the region sees is the
 * ids grouped by shard rather than the order they were sent — and a replacement
 * policy is a function of exactly that order.  The cap is region-wide by design
 * (`ShardRegion` documents why), so collapsing the shard axis removes a variable
 * the policy has no opinion about and leaves the workload the test is written to
 * describe.
 */
const NUM_SHARDS = 1;

/** Entity ids that have been started / stopped since the last reset. */
let started: string[] = [];
let stopped: string[] = [];

/**
 * An entity that can be asked to passivate itself with a stop-message it then
 * ignores — the shape the cooperative stop path had no backstop for.
 */
class Entity extends Actor<Command> {
  override preStart(): void {
    started.push(this.entityId);
  }

  override postStop(): void {
    stopped.push(this.entityId);
  }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .with({ kind: 'checkout' }, () => this.onCheckout())
      .with({ kind: 'ignored-stop' }, () => this.onIgnoredStop())
      .exhaustive();
  }

  /** Receiving anything is what makes an entity "used" as far as the region sees. */
  private onWork(): void {}

  /**
   * Ask to be passivated with a stop-message this actor deliberately does
   * nothing about.  Without `passivation.stop-timeout` the entity then never
   * terminates, the region never sees `EntityStopped`, and the slot is held
   * against `max-entities` for the lifetime of the node.
   */
  private onCheckout(): void {
    const stopMessage: IgnoredStopCommand = { id: this.entityId, kind: 'ignored-stop' };
    this.context.parent.forEach((parent) =>
      parent.tell(new Passivate(stopMessage, this.self) as never, this.self));
  }

  private onIgnoredStop(): void {}
}

const waitFor = (
  predicate: () => boolean,
  timeoutMs = 5_000,
  stepMs = 10,
  label = 'the awaited passivation-strategy state',
): Promise<void> => awaitCondition(predicate, { timeoutMs, intervalMs: stepMs, label });

type Node = {
  system: ActorSystem;
  cluster: Cluster;
  region: ActorRef<Command>;
};

let running: Node | null = null;

async function startNode(
  systemName: string,
  port: number,
  config: ConfigObject,
  options?: (builder: StartShardingOptionsBuilder<Command>) => void,
): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(config);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);

  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS);
  options?.(shardingOptions);

  const region = cluster.sharding.start<Command>(shardingOptions);
  const node = { system, cluster, region };
  running = node;
  return node;
}

afterEach(async () => {
  if (running) {
    await running.cluster.leave();
    await running.system.terminate();
    running = null;
  }
  started = [];
  stopped = [];
});

/* ------------------------------ the scan workload ------------------------- */

/**
 * Six entities used repeatedly, forty used once each, against a cap of twelve.
 *
 * The numbers matter and are chosen against the arithmetic rather than by feel.
 * The cap is twice the hot set, so keeping all six is comfortably possible; the
 * scan is nearly seven times the cap, so no ordering survives it by accident.
 * A window of one entity is the smallest that exists at this cap, and one is
 * enough: it only has to hold a candidate for the filter to have something to
 * judge that is not the entity a message is waiting on.
 */
const HOT = ['hot-1', 'hot-2', 'hot-3', 'hot-4', 'hot-5', 'hot-6'];
const COLD = Array.from({ length: 40 }, (_unused, index) => `cold-${index + 1}`);
const CAPACITY = 12;
/** Every entity is admitted once, and everything over the cap has to go. */
const EXPECTED_EVICTIONS = HOT.length + COLD.length - CAPACITY;

const passivationConfig = (passivation: ConfigObject): ConfigObject => ({
  'actor-ts': { sharding: { 'max-entities': CAPACITY, passivation } },
});

/**
 * Warm the hot set, then scan the cold one, then wait for the region to settle.
 *
 * "Settled" is a count, not a sleep: every one of the 46 ids has been started,
 * and the 34 entities the cap cannot hold have stopped.  Nothing is sent to a
 * hot id after the scan begins, so a hot id appearing in `stopped` was evicted
 * by the policy rather than replaced by traffic.
 */
async function runScan(node: Node): Promise<void> {
  // Three passes: the first creates the entity, and the ones after it are what
  // a segmented policy needs to tell a working set from a scan at all.
  for (let pass = 0; pass < 3; pass++) {
    for (const id of HOT) node.region.tell({ id, kind: 'work' });
  }
  for (const id of COLD) node.region.tell({ id, kind: 'work' });

  await waitFor(
    () => new Set(started).size === HOT.length + COLD.length
      && stopped.length >= EXPECTED_EVICTIONS,
    8_000, 10,
    'every entity started and the cap-driven evictions completed',
  );
}

const survivingHotEntities = (): string[] => HOT.filter((id) => !stopped.includes(id));

describe('entity replacement policies under a scan (#848)', () => {
  test('the shipped least-recently-used policy loses the entire hot set', () => {
    // The baseline the issue is written against, and the WRONG arm of the
    // acceptance comparison: it has to fail for the passing arm to mean
    // anything.  Recency cannot tell "touched once, ever" from "touched
    // constantly until a moment ago", so each cold arrival takes a hot entity.
    return startNode('passivation-lru', 47_700, passivationConfig({
      replacement: 'least-recently-used',
      'admission-filter': 'off',
    })).then(async (node) => {
      await runScan(node);

      expect(survivingHotEntities()).toEqual([]);
    });
  });

  test('segmented least-recently-used with a frequency sketch keeps all six', async () => {
    // The acceptance criterion: same cap, same hot set, same scan, same
    // assertions — only the two keys differ.
    const node = await startNode('passivation-segmented-sketch', 47_701, passivationConfig({
      replacement: 'segmented-least-recently-used',
      'segmented-protected-proportion': 0.8,
      'admission-window-proportion': 0.1,
      'admission-filter': 'frequency-sketch',
    }));

    await runScan(node);

    expect(survivingHotEntities()).toEqual(HOT);
    // And the cap still holds: the survivors are survivors, not an unbounded
    // region that never evicted anything.
    expect(stopped.length).toBe(EXPECTED_EVICTIONS);
  });

  test('segmentation alone keeps five of six — the sketch is what saves the last', async () => {
    // The third arm, and the one that says which mechanism does what.  Only the
    // protected segment is safe from the scan, and one hot entity is still in
    // the admission window when the scan starts, so it reaches probation with
    // the cold ids and a policy with nothing judging admissions evicts it there.
    // The filter is what recognises it as an entity that has been used before.
    const node = await startNode('passivation-segmented-only', 47_702, passivationConfig({
      replacement: 'segmented-least-recently-used',
      'segmented-protected-proportion': 0.8,
      'admission-window-proportion': 0.1,
      'admission-filter': 'off',
    }));

    await runScan(node);

    expect(survivingHotEntities()).toEqual(['hot-1', 'hot-2', 'hot-3', 'hot-4', 'hot-5']);
  });

  test('an explicit replacement option beats the config file', async () => {
    // The usual precedence, on a key whose effect is an ordering rather than a
    // number: HOCON asks for the policy that survives the scan, the builder
    // asks for the one that does not, and the builder wins.
    const node = await startNode(
      'passivation-explicit',
      47_703,
      passivationConfig({
        replacement: 'segmented-least-recently-used',
        'segmented-protected-proportion': 0.8,
      }),
      (builder) => builder.withPassivationReplacement('least-recently-used'),
    );

    await runScan(node);

    expect(survivingHotEntities()).toEqual([]);
  });
});

describe('passivation.stop-timeout (#848)', () => {
  test('an entity that ignores its stop-message is stopped anyway', async () => {
    const node = await startNode('passivation-stop-timeout', 47_704, passivationConfig({
      'stop-timeout': '150ms',
    }));

    node.region.tell({ id: 'e-1', kind: 'work' });
    await waitFor(() => started.includes('e-1'));

    // The entity asks to be passivated and then does nothing with the
    // stop-message it is handed.  Before #848 that was the end of it.
    node.region.tell({ id: 'e-1', kind: 'checkout' });

    await waitFor(() => stopped.includes('e-1'), 4_000, 10, 'the ignored stop-message was forced');
  });

  test('and its slot comes back to the cap', async () => {
    // The reason the timeout is not merely tidiness.  With a cap of one, the
    // region's own eviction of a wedged entity is a no-op — the shard is already
    // passivating it — so the slot was leaked permanently: the node held two
    // entities against a cap of one and never recovered.
    const node = await startNode('passivation-stop-slot', 47_705, {
      'actor-ts': { sharding: { 'max-entities': 1, passivation: { 'stop-timeout': '150ms' } } },
    });

    node.region.tell({ id: 'e-1', kind: 'work' });
    await waitFor(() => started.includes('e-1'));
    node.region.tell({ id: 'e-1', kind: 'checkout' });
    await waitFor(() => stopped.includes('e-1'));

    node.region.tell({ id: 'e-2', kind: 'work' });
    await waitFor(() => started.includes('e-2'));

    // One resident entity, which is what the cap says.  `e-1` is gone for good:
    // nothing re-created it, so its slot is genuinely free rather than held by
    // an actor the region has lost track of.
    expect(stopped).toEqual(['e-1']);
  });

  test('stop-timeout = 0 keeps waiting, which is the pre-#848 behaviour', async () => {
    // Kept expressible on purpose: an entity whose graceful shutdown genuinely
    // has no bound — draining a long-running job — is a real shape, and there a
    // forced stop would be the bug rather than the fix.
    const node = await startNode('passivation-stop-forever', 47_706, passivationConfig({
      'stop-timeout': '0ms',
    }));

    node.region.tell({ id: 'e-1', kind: 'work' });
    await waitFor(() => started.includes('e-1'));
    node.region.tell({ id: 'e-1', kind: 'checkout' });

    // An absence, so there is nothing to poll for: `stopped` is empty at t=0 and
    // nothing in the tree may make it otherwise inside a test window.
    await sleep(500);
    expect(stopped).toEqual([]);
  });
});

describe('the cap sees every admission point (#848)', () => {
  test('an entity started without being routed to still counts against the cap', async () => {
    // The admission hole #848 found, and it is a behaviour change on an existing
    // feature.  `onEntityStarted` is how the region learns of a spawn nothing
    // routed to — the `rememberEntities` recovery path, where a shard is handed
    // a whole registry and materialises it — and until now it wrote the entity
    // index directly, past the cap.  A node handed a registry larger than
    // `max-entities` therefore exceeded it by the size of the registry and
    // stayed over it, because nothing else ever re-checks.
    const node = await startNode('passivation-remembered-cap', 47_707, {
      'actor-ts': { sharding: { 'max-entities': 2, 'passivation-idle': '0ms' } },
    });

    node.region.tell({ id: 'e-1', kind: 'work' });
    await waitFor(() => started.includes('e-1'));

    // `StartEntities` is the exact frame `onRememberedEntities` sends a shard
    // when the coordinator ships it a registry, so this is the recovery path's
    // own message rather than a stand-in for it.
    const shard = node.system._resolvePath([
      ...regionSegments(node.system.name, TYPE_NAME),
      'shard-0',
    ]);
    if (shard.isNone()) throw new Error('shard actor not found');
    const startEntities: StartEntities = {
      kind: 'sharding.StartEntities',
      entityIds: ['e-2', 'e-3', 'e-4'],
    };
    (shard.value as ActorRef<unknown>).tell(startEntities as never);

    await waitFor(() => new Set(started).size === 4, 4_000, 10, 'all four entities started');

    // Four admissions against a cap of two: the two oldest go and the region
    // settles back at the cap instead of holding double it.  Sorted rather than
    // in order — the region decides in order, but the two stops it asks for run
    // as separate actor terminations and nothing sequences them against each
    // other.
    await waitFor(() => stopped.length === 2, 4_000, 10, 'the cap evicted down to two');
    expect([...stopped].sort()).toEqual(['e-1', 'e-2']);
  });
});
