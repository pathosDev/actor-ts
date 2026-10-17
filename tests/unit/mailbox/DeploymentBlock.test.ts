/**
 * #868 — the per-path deployment layer reaches the actors its keys name, and
 * only those, each leaf layered between the spawn site and the system default.
 *
 * The block ships comment-only, so no leaf-driven guard can say whether it is
 * wired: `NoDeadConfigKeys` sees it only as the object the reader registry
 * introduces, and that proves the reader answers, not that a cell asks.  These
 * cases are that proof, made on the queue an actor actually got and on the
 * batches its run loop actually took.  Before the layer existed the decided
 * block was silently ignored: an unbounded `Mailbox` with all 32 messages
 * queued and no rejection, and a throughput of 16.
 *
 * The bound is asserted where it can be told apart from its neighbours: under
 * `reject`, `n` messages fit and the next one throws `MailboxFullError` at the
 * sender, naming the capacity — so a bound of 2 cannot pass for one of 4, and
 * a policy that did not travel cannot pass for `reject`.  How the record is
 * read and ranked is `tests/unit/config/DeploymentConfigDefaults.test.ts`'s
 * business; this file is about the cell.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Shard } from '../../../src/cluster/sharding/Shard.js';
import type { ShardConfig, ShardInbox } from '../../../src/cluster/sharding/Shard.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { type Dispatcher, type DispatcherErrorSink, Dispatchers } from '../../../src/Dispatcher.js';
import type { LocalActorRef } from '../../../src/internal/LocalActorRef.js';
import { SystemGroups } from '../../../src/internal/SystemPaths.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { BoundedMailbox, ControlAwareMailbox, Mailbox, MailboxFullError } from '../../../src/mailbox/index.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const systems: ActorSystem[] = [];
const shutGates: Array<() => void> = [];

afterEach(async () => {
  // Open every gate first: an actor parked behind one holds `terminate()` open.
  for (const open of shutGates.splice(0)) open();
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

/**
 * A system configured with `actorTs` under `actor-ts`.  Nested and not dotted:
 * a dotted string stays one literal top-level key, and every assertion would
 * be about the reference configuration instead.
 */
function systemWith(name: string, actorTs: ConfigObject): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    // Pinned for the reason `ActorBatching.test.ts` gives: these cases make
    // dispatcher turns observable, and the default dispatcher can resume a
    // cell between two messages of one batch.
    .withDispatcher(Dispatchers.Immediate())
    .withConfig({ 'actor-ts': actorTs });
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  return system;
}

/** A gate the test may open; the hook above opens it otherwise. */
function newGate(): Promise<void> {
  let open = (): void => { /* replaced below */ };
  const opened = new Promise<void>((resolve) => { open = resolve; });
  shutGates.push(open);
  return opened;
}

/** The queue an actor actually got, through the cell's test seam. */
function mailboxOf(ref: object): unknown {
  return (ref as LocalActorRef<unknown>).getCell()._mailboxForTest();
}

/** The cell behind a ref, for the children it spawned. */
function cellOf(ref: object): ReturnType<LocalActorRef<unknown>['getCell']> {
  return (ref as LocalActorRef<unknown>).getCell();
}

/**
 * Under `reject`: `capacity` messages fit, and the next is refused at the
 * sender with a `MailboxFullError` naming that capacity.  The actor must not
 * drain in between — it is either not started yet (every `tell` here is
 * synchronous) or parked in its handler.
 */
function expectRejectingBoundOf<T>(ref: ActorRef<T>, capacity: number, message: (index: number) => T): void {
  for (let index = 0; index < capacity; index++) ref.tell(message(index));
  let refusal: unknown = null;
  try { ref.tell(message(capacity)); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(MailboxFullError);
  expect((refusal as Error).message).toContain(`(capacity=${capacity})`);
}

const aNumber = (index: number): number => index + 1;

/** Parks on message 0 so that everything after it has to queue. */
class Latched extends Actor<number> {
  constructor(private readonly gate: Promise<void>) { super(); }

  override async onReceive(message: number): Promise<void> {
    if (message === 0) await this.gate;
  }
}

describe('a deployment entry bounds the actors its key matches (#868)', () => {
  test('an exact key bounds its actor and rejects at the sender, and leaves its sibling unbounded', () => {
    const system = systemWith('deployment-exact', {
      deployment: { '/user/ingest': { throughput: 4, 'mailbox-capacity': 2, 'mailbox-overflow': 'reject' } },
    });
    const gate = newGate();
    const ingest = system.spawn(() => new Latched(gate), 'ingest');
    const other = system.spawn(() => new Latched(gate), 'other');

    expect(mailboxOf(ingest)).toBeInstanceOf(BoundedMailbox);
    expectRejectingBoundOf(ingest, 2, aNumber);

    expect(mailboxOf(other)).not.toBeInstanceOf(BoundedMailbox);
    for (let index = 0; index < 32; index++) other.tell(index);
    expect((mailboxOf(other) as Mailbox<number>).size).toBe(32);
  });

  test('patterns reach actors no spawn site names: routees by a glob, a grandchild by **', async () => {
    const system = systemWith('deployment-patterns', {
      deployment: {
        '/user/pool/worker-*': { 'mailbox-capacity': 2, 'mailbox-overflow': 'reject' },
        '/user/hub/**': { 'mailbox-capacity': 3, 'mailbox-overflow': 'reject' },
      },
    });
    const gate = newGate();

    class Pool extends Actor<number> {
      override preStart(): void {
        for (const index of [1, 2, 3]) this.context.spawn(() => new Latched(gate), `worker-${index}`);
      }
      override onReceive(): void {}
    }
    class Connection extends Actor<number> {
      override preStart(): void { this.context.spawn(() => new Latched(gate), 'session'); }
      override onReceive(): void {}
    }
    class Hub extends Actor<number> {
      override preStart(): void { this.context.spawn(Connection, 'connection'); }
      override onReceive(): void {}
    }

    const pool = system.spawn(Pool, 'pool');
    const hub = system.spawn(Hub, 'hub');
    const outside = system.spawn(() => new Latched(gate), 'outside');
    const poolCell = cellOf(pool);
    const hubCell = cellOf(hub);
    await awaitCondition(() => poolCell.children.length === 3, { label: 'the pool spawned its three workers' });
    await awaitCondition(
      () => hubCell.children.length === 1 && cellOf(hubCell.children[0]!).children.length === 1,
      { label: 'the hub spawned its connection, and the connection its session' },
    );

    for (const worker of poolCell.children) {
      expect(worker.path.name).toMatch(/^worker-[123]$/);
      expectRejectingBoundOf(worker as ActorRef<number>, 2, aNumber);
    }
    // The pattern names the children, not the parent that spawned them.
    expect(mailboxOf(pool)).not.toBeInstanceOf(BoundedMailbox);

    const session = cellOf(hubCell.children[0]!).children[0] as ActorRef<number>;
    expect(session.path.toString()).toEndWith('/user/hub/connection/session');
    expectRejectingBoundOf(session, 3, aNumber);
    // `**` is one or more segments below `/user/hub`, so the hub is not one.
    expect(mailboxOf(hub)).not.toBeInstanceOf(BoundedMailbox);

    expect(mailboxOf(outside)).not.toBeInstanceOf(BoundedMailbox);
  });

  test('mailbox-capacity = 0 exempts the matched actor from a global bound its sibling keeps', () => {
    const system = systemWith('deployment-exempt', {
      mailbox: { default: { capacity: 4, overflow: 'reject' } },
      deployment: { '/user/exempt': { 'mailbox-capacity': 0 } },
    });
    const gate = newGate();
    const exempt = system.spawn(() => new Latched(gate), 'exempt');
    const sibling = system.spawn(() => new Latched(gate), 'sibling');

    expect(mailboxOf(exempt)).not.toBeInstanceOf(BoundedMailbox);
    for (let index = 0; index < 64; index++) exempt.tell(index);
    expect((mailboxOf(exempt) as Mailbox<number>).size).toBe(64);

    expectRejectingBoundOf(sibling, 4, aNumber);
  });
});

describe('the spawn site still wins over a deployment entry (#868)', () => {
  test('withMailboxCapacity(32) beats an entry capacity of 4', () => {
    const system = systemWith('deployment-spawn-capacity', {
      deployment: { '/user/roomy': { 'mailbox-capacity': 4, 'mailbox-overflow': 'reject' } },
    });
    const gate = newGate();
    const roomyOptions = ActorOptions.create<number>().withMailboxCapacity(32);
    const roomy = system.spawn(() => new Latched(gate), 'roomy', roomyOptions);

    // The entry's policy still applies, which is what makes 32 observable.
    expectRejectingBoundOf(roomy, 32, aNumber);
  });

  test('withMailbox yields exactly the supplied queue, and no OptionsError although the entry sets a capacity', () => {
    const system = systemWith('deployment-spawn-mailbox', {
      deployment: { '/user/custom': { 'mailbox-capacity': 4, 'mailbox-overflow': 'reject' } },
    });
    const gate = newGate();
    const supplied = new Mailbox<number>();
    const customOptions = ActorOptions.create<number>().withMailbox(() => supplied);
    const custom = system.spawn(() => new Latched(gate), 'custom', customOptions);

    expect(mailboxOf(custom)).toBe(supplied);
    for (let index = 0; index < 16; index++) custom.tell(index);
    expect(supplied.size).toBe(16);
  });

  test('an entry overflow applies to a spawn-site capacity that names no policy', () => {
    const system = systemWith('deployment-spawn-overflow', {
      deployment: { '/user/tight': { 'mailbox-overflow': 'reject' } },
    });
    const gate = newGate();
    const tightOptions = ActorOptions.create<number>().withMailboxCapacity(2);
    const tight = system.spawn(() => new Latched(gate), 'tight', tightOptions);

    // The built-in drop-head would swallow the third message without a word.
    expectRejectingBoundOf(tight, 2, aNumber);
  });
});

/**
 * An `ImmediateDispatcher` that counts the units it is handed — the shape
 * `ActorBatching.test.ts` uses, for its reason: messages handled under one
 * count were handled in one turn.
 */
class CountingDispatcher implements Dispatcher {
  readonly id = 'counting-dispatcher';
  onError?: DispatcherErrorSink;
  turns = 0;

  execute(task: () => void | Promise<void>): void {
    this.turns += 1;
    setImmediate(() => { void task(); });
  }
}

/** Records the dispatcher turn each message was handled in. */
class TurnRecorder extends Actor<string> {
  constructor(private readonly turns: number[], private readonly readTurn: () => number) { super(); }

  override onReceive(): void { this.turns.push(this.readTurn()); }
}

/** Sizes of consecutive runs of equal turn numbers, in order. */
function batchSizesOf(turns: ReadonlyArray<number>): number[] {
  const sizes: number[] = [];
  let previous: number | null = null;
  for (const turn of turns) {
    if (turn === previous) sizes[sizes.length - 1] += 1;
    else { sizes.push(1); previous = turn; }
  }
  return sizes;
}

/** The batches `count` messages took on a fresh counting dispatcher, for the actor spawned at `name`. */
async function batchesAt(
  system: ActorSystem,
  name: string,
  count: number,
  pinnedThroughput?: number,
): Promise<number[]> {
  const turns: number[] = [];
  const dispatcher = new CountingDispatcher();
  const recorderOptions = pinnedThroughput === undefined
    ? ActorOptions.create<string>().withDispatcher(dispatcher)
    : ActorOptions.create<string>()
      .withDispatcher(dispatcher)
      .withThroughput(pinnedThroughput);
  const ref = system.spawn(() => new TurnRecorder(turns, () => dispatcher.turns), name, recorderOptions);
  // `tell` is synchronous and the dispatcher runs on the next macrotask, so
  // all of them are queued before the first turn starts.
  for (let index = 0; index < count; index++) ref.tell(`m${index}`);
  await awaitCondition(() => turns.length === count, { label: `${name} handled ${count} messages` });
  return batchSizesOf(turns);
}

describe('a deployment entry sets the batch the run loop takes (#868)', () => {
  test('an entry throughput of 3 gives batches of 3', async () => {
    const system = systemWith('deployment-throughput', { deployment: { '/user/batched': { throughput: 3 } } });

    expect(await batchesAt(system, 'batched', 10)).toEqual([3, 3, 3, 1]);
  });

  test('withThroughput(1) at the spawn site beats the entry', async () => {
    const system = systemWith('deployment-throughput-spawn', { deployment: { '/user/pinned': { throughput: 3 } } });

    expect(await batchesAt(system, 'pinned', 5, 1)).toEqual([1, 1, 1, 1, 1]);
  });

  test('the entry is chosen whole: an empty exact entry falls through to actor.throughput, not to /user/**', async () => {
    const system = systemWith('deployment-throughput-whole', {
      actor: { throughput: 5 },
      deployment: { '/user/**': { throughput: 8 }, '/user/special': {} },
    });

    // The most specific key matched, and it sets no throughput: the system
    // layer answers.  A field-wise merge across entries would answer 8.
    expect(await batchesAt(system, 'special', 12)).toEqual([5, 5, 2]);
    // And the less specific entry is live for everyone else.
    expect(await batchesAt(system, 'elsewhere', 12)).toEqual([8, 4]);
  });
});

type PingCommand = { readonly kind: 'ping' };

/**
 * A sharded entity that records itself and parks on its first message, so a
 * test can reach the queue of an actor nothing hands it a ref to — and find it
 * empty, with the actor busy, when it does.
 */
class ParkingEntity extends Actor<PingCommand> {
  static spawned: ParkingEntity[] = [];
  static gate: Promise<void> = Promise.resolve();
  parked = false;

  override preStart(): void { ParkingEntity.spawned.push(this); }

  /** The cell seam wants a ref, and only the instance can reach its own. */
  get ref(): ActorRef<PingCommand> { return this.self; }

  override async onReceive(_message: PingCommand): Promise<void> {
    if (this.parked) return;
    this.parked = true;
    await ParkingEntity.gate;
  }
}

const pingEnvelope = (entityId: string): ShardInbox => ({
  kind: 'sharding.EntityEnvelope',
  entityId,
  message: { kind: 'ping' } satisfies PingCommand,
}) as ShardInbox;

describe('who wrote the class decides what an entry reaches (#868)', () => {
  test('"/**" and "/system/**" leave a framework actor and the /user guardian unbounded', () => {
    const everything = { 'mailbox-capacity': 2, 'mailbox-overflow': 'reject' };
    const system = systemWith('deployment-provenance-framework', {
      deployment: { '/**': everything, '/system/**': everything },
    });
    const gate = newGate();

    const framework = system._spawnSystemActor(() => new Latched(gate), SystemGroups.delivery, 'bound-probe');
    expect(mailboxOf(framework)).not.toBeInstanceOf(BoundedMailbox);
    for (let index = 0; index < 8; index++) framework.tell(index);

    const guardian = (system as unknown as { userGuardianCell: { _mailboxForTest(): unknown } }).userGuardianCell;
    expect(guardian._mailboxForTest()).not.toBeInstanceOf(BoundedMailbox);

    // The entries are live: the application's own actor is bounded by them.
    const application = system.spawn(() => new Latched(gate), 'application');
    expectRejectingBoundOf(application, 2, aNumber);
  });

  test('a sharded entity under /system takes its entry, and the shard spawning it does not', async () => {
    ParkingEntity.spawned = [];
    ParkingEntity.gate = newGate();
    const system = systemWith('deployment-provenance-entity', {
      deployment: {
        '/system/cluster/sharding/shard-0/*': { 'mailbox-capacity': 3, 'mailbox-overflow': 'reject' },
        '/system/cluster/sharding/**': { 'mailbox-capacity': 2, 'mailbox-overflow': 'reject' },
      },
    });
    // Driven directly under `/system`, where `ClusterSharding` puts a region,
    // because the only thing deciding the entity's queue is the tree it lands in.
    const config: ShardConfig = { typeName: 'probe', shardId: 0, entityActor: ParkingEntity };
    const shard = system._spawnSystemActor<ShardInbox>(
      () => new Shard(config),
      SystemGroups.clusterSharding,
      'shard-0',
    );
    expect(shard.path.toString()).toEndWith('/system/cluster/sharding/shard-0');
    shard.tell(pingEnvelope('e-1'));
    await awaitCondition(() => ParkingEntity.spawned.length === 1 && ParkingEntity.spawned[0]!.parked, {
      label: 'the shard spawned its entity, and the entity parked on its first message',
    });
    const entity = ParkingEntity.spawned[0]!.ref;

    // 3, not 2: the entity matches both keys, and the `*` key is the more
    // specific of the two.
    expectRejectingBoundOf(entity, 3, () => ({ kind: 'ping' }));
    // The shard matches `/system/cluster/sharding/**` too, and is the
    // framework's actor: shedding its traffic loses entity mail.
    expect(mailboxOf(shard)).not.toBeInstanceOf(BoundedMailbox);
  });
});

/** Control messages are the negative numbers — a stateless, module-level predicate, as the hook asks. */
const isNegative = (message: unknown): boolean => typeof message === 'number' && message < 0;

/** Declares control messages through the internal hook the WebSocket hub uses. */
class DeclaringLatched extends Latched {
  started = false;

  override preStart(): void { this.started = true; }

  override _controlMessages(): (message: unknown) => boolean { return isNegative; }
}

describe('a declaring actor keeps its entry bound on the control-aware queue (#868)', () => {
  test('the queue swapped in at first start is bounded at the entry capacity, control messages exempt', async () => {
    const system = systemWith('deployment-control-lane', {
      deployment: { '/user/declaring': { 'mailbox-capacity': 3, 'mailbox-overflow': 'reject' } },
    });
    const gate = newGate();
    const built: { instance: DeclaringLatched | null } = { instance: null };
    const declaring = system.spawn(() => (built.instance = new DeclaringLatched(gate)), 'declaring');
    await awaitCondition(() => built.instance?.started === true, { label: 'the declaring actor started' });

    expect(mailboxOf(declaring)).toBeInstanceOf(ControlAwareMailbox);
    // Park it on message 0, so the queue is empty and nothing drains.
    declaring.tell(0);
    await awaitCondition(() => (mailboxOf(declaring) as Mailbox<number>).size === 0, {
      label: 'the actor took message 0',
    });
    expectRejectingBoundOf(declaring, 3, aNumber);
    // A control message is neither counted nor refused by the full bound.
    declaring.tell(-1);
  });
});

describe('the lookup costs nothing without a block, and renders no path (#868)', () => {
  test('a system without the block holds no index', () => {
    const system = systemWith('deployment-none', {});

    expect(system._deployment).toBeNull();
  });

  const renderCases: Array<[string, ConfigObject]> = [
    ['no block', {}],
    ['a block whose key matches the actor', { deployment: { '/user/**': { throughput: 2 } } }],
    ['a block whose keys match nothing', { deployment: { '/user/elsewhere': { throughput: 2 }, '/user/x-*': {} } }],
  ];

  test.each(renderCases)('with %s, a plain actor\'s path is still unrendered after spawn and start', async (_label, actorTs) => {
    const system = systemWith('deployment-render', actorTs);
    let started = false;
    class Plain extends Actor<number> {
      override preStart(): void { started = true; }
      override onReceive(): void {}
    }
    const plain = system.spawn(Plain, 'plain');
    const renderedOf = (): unknown => (plain.path as unknown as { rendered: string | undefined }).rendered;

    expect(renderedOf()).toBeUndefined();
    await awaitCondition(() => started, { label: 'the plain actor started' });
    expect(renderedOf()).toBeUndefined();
  });
});
