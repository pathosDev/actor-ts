import { match } from 'ts-pattern';
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Passivate } from '../../../../src/cluster/sharding/Passivate.js';
import { Shard } from '../../../../src/cluster/sharding/Shard.js';
import type { ShardConfig, ShardInbox } from '../../../../src/cluster/sharding/Shard.js';
import type { EntityEnvelope } from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

/**
 * `Shard`'s cooperative-stop backstop, driven directly rather than through a
 * region (#848).
 *
 * The layer matters: `ShardConfig` is exported from the `actor-ts/cluster`
 * entry point, so an application may build one itself, and what an *omitted*
 * `passivationStopTimeoutMs` means is a published contract rather than an
 * internal detail.  Reaching the same code through `ClusterSharding.start`
 * would never leave the field absent, which is exactly why nothing here
 * noticed when the field arrived required.
 */

type WorkCommand = { id: string; kind: 'work' };
type CheckoutCommand = { id: string; kind: 'checkout' };
/** The stop-message a `Passivate` hands back — and the entity ignores it. */
type IgnoredStopCommand = { id: string; kind: 'ignored-stop' };

type Command = WorkCommand | CheckoutCommand | IgnoredStopCommand;

const TYPE_NAME = 'entity';

let stopped: string[] = [];

/** An entity that asks to passivate and then never acts on the stop-message. */
class WedgedEntity extends Actor<Command> {
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

  private onWork(): void {}

  private onCheckout(): void {
    const stopMessage: IgnoredStopCommand = { id: this.entityId, kind: 'ignored-stop' };
    this.context.parent.forEach((parent) =>
      parent.tell(new Passivate(stopMessage, this.self) as never, this.self));
  }

  private onIgnoredStop(): void {}
}

let system: ActorSystem | null = null;

function startShard(config: ShardConfig): void {
  system = ActorSystem.create('shard-stop-timeout', ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off));
  const shard = system.spawn<ShardInbox>(() => new Shard(config), 'shard-0');
  const envelope: EntityEnvelope<Command> = {
    kind: 'sharding.EntityEnvelope',
    entityId: 'e-1',
    message: { id: 'e-1', kind: 'work' },
  };
  shard.tell(envelope as ShardInbox);
  const checkout: EntityEnvelope<Command> = {
    kind: 'sharding.EntityEnvelope',
    entityId: 'e-1',
    message: { id: 'e-1', kind: 'checkout' },
  };
  shard.tell(checkout as ShardInbox);
}

afterEach(async () => {
  if (system) {
    await system.terminate();
    system = null;
  }
  stopped = [];
});

describe('Shard passivation stop-timeout (#848)', () => {
  test('a ShardConfig that names no stop-timeout waits forever', async () => {
    // The field is optional and its absence means "no backstop", which is the
    // only reading that is safe for a caller who cannot know the key exists.
    // While it was required-and-unset the shard scheduled the forced stop with
    // an `undefined` delay — `undefined <= 0` is false, and `setTimeout` reads
    // `undefined` as zero — so every cooperative passivation was force-stopped
    // on the next tick.
    const config: ShardConfig = { typeName: TYPE_NAME, shardId: 0, entityActor: WedgedEntity };
    startShard(config);

    // An absence, so there is nothing to poll for.
    await sleep(300);
    expect(stopped).toEqual([]);
  });

  test('a positive stop-timeout stops an entity that ignores its stop-message', async () => {
    // The other half, so the test above cannot pass by the backstop being
    // broken outright.
    startShard({
      typeName: TYPE_NAME,
      shardId: 0,
      entityActor: WedgedEntity,
      passivationStopTimeoutMs: 120,
    });

    await awaitCondition(() => stopped.includes('e-1'), {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'the ignored stop-message was forced',
    });
  });

  test('an explicit 0 is the same unbounded wait as omitting the field', async () => {
    startShard({
      typeName: TYPE_NAME,
      shardId: 0,
      entityActor: WedgedEntity,
      passivationStopTimeoutMs: 0,
    });

    // An absence, so there is nothing to poll for.
    await sleep(300);
    expect(stopped).toEqual([]);
  });
});
