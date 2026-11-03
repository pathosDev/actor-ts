/**
 * `DistributedDataHandle.subscribe(key, ref)` — a subscriber that is an actor
 * (#1468).
 *
 * The callback form runs its listener on the replicator's turn, so the
 * listener's time is the replicator's: nothing merges, gossips or answers a
 * quorum while it runs.  An actor subscribed instead is told a
 * `DistributedDataChanged` and does its work on its own turn, and what it is
 * told is paced by its own mailbox rather than by a timer: the replicator keeps
 * one slot per subscriber and key, posts a notification into an empty slot,
 * and overwrites the value of the one still queued instead of posting another.
 * The slot empties the moment the subscriber is handed the notification — the
 * release `ActorCell.postSignalEnvelope` fires — so the subscriber always
 * handles the latest value as of its own dispatch.
 *
 * So most cases here hold a subscriber inside its handler on a promise the test
 * opens, and look at what reaches it once it is let go.  The rest pin the
 * bookkeeping around the slot: a subscription is the subscriber's and the
 * key's, a dead subscriber's are dropped through death watch, a replicator
 * restart keeps them, and a bounded mailbox cannot evict the one notification
 * a slot is waiting on.
 *
 * Before this form existed a ref passed from JavaScript was filed as a
 * listener: its replay threw a `TypeError` that the replicator contained, and
 * so did every merge after it, so the actor was never told anything at all.
 *
 * Single node on `InMemoryTransport`.  Two barriers, and neither waits on a
 * clock: `getAsync(key, { consistency: 'local' })` is answered on the
 * replicator's turn after everything told to it before, so every notification
 * those messages produced has been posted when it resolves; and a `probe` told
 * to the subscriber after that is handled after every notification already in
 * its mailbox.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match, P } from 'ts-pattern';
import { Actor } from '../../../src/Actor.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { RemoteActorRef } from '../../../src/cluster/RemoteActorRef.js';
import type { Dispatcher } from '../../../src/Dispatcher.js';
import type { LocalActorRef } from '../../../src/internal/LocalActorRef.js';
import { LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import { ActorRestarted, DeadLetter } from '../../../src/SystemMessages.js';
import { TestProbe } from '../../../src/testkit/TestProbe.js';
import { DistributedDataChanged, DistributedDataId, GCounter } from '../../../src/crdt/index.js';
// Not re-exported by any entry point yet (#1307); the helpers below only need its type.
import type { DistributedDataHandle } from '../../../src/crdt/DistributedData.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/* ============================== fixtures ================================ */

/** A promise the test opens by hand — how a subscriber is held inside its handler. */
type Gate = { readonly opened: Promise<void>; readonly open: () => void };

/**
 * Every gate a case made, so teardown can open the ones a failing assertion
 * left shut: a turn held open forever also holds `system.terminate()`, and the
 * case would report a hook timeout instead of its own failure.
 */
const gates: Gate[] = [];

const newGate = (): Gate => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  const gate = { opened, open };
  gates.push(gate);
  return gate;
};

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];
const transports: InMemoryTransport[] = [];

afterEach(async () => {
  for (const gate of gates.splice(0)) gate.open();
  await Promise.all(transports.splice(0).map((t) => t.shutdown().catch(() => {})));
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

async function startNode(name: string, port: number, logger: Logger = new NoopLogger()): Promise<Cluster> {
  const options = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Debug);
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

/** A bare transport that speaks the wire under its own identity. */
async function peerTransport(name: string, port: number): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport(new NodeAddress(name, 'h', port));
  transport.setHandler(() => {});
  await transport.start();
  transports.push(transport);
  return transport;
}

const KEY = 'hits';
const OTHER_KEY = 'misses';

/* ========================= the subscribing actor ========================= */

type ProbeMessage = { readonly kind: 'probe'; readonly label: string };
type UnstashMessage = { readonly kind: 'unstash' };
type FillerMessage = { readonly kind: 'filler' };
type SubscriberMessage = DistributedDataChanged<GCounter> | ProbeMessage | UnstashMessage | FillerMessage;

/** What a case steers its subscriber with, shared by reference. */
type Control = {
  /** Hold the next notification handled on this gate. */
  park: Gate | null;
  /** Stash every notification until an `unstash` arrives. */
  stashing: boolean;
};

const newControl = (): Control => ({ park: null, stashing: false });

/**
 * Writes what it is handed into the journal as it is handed it — the value is
 * read at that moment, so a notification overwritten after its hand-over would
 * show up as a value the subscriber never saw.
 */
class Subscriber extends Actor<SubscriberMessage> {
  constructor(
    private readonly journal: string[],
    private readonly control: Control,
    /** Subscribe `this.self` to these keys in `preStart`. */
    private readonly keys: readonly string[] = [],
    private readonly received: DistributedDataChanged<GCounter>[] = [],
  ) { super(); }

  override preStart(): void {
    const data = this.system.extension(DistributedDataId).get();
    for (const key of this.keys) {
      data.subscribe<GCounter>(key, this.self);
      this.journal.push(`subscribed:${key}`);
    }
  }

  override onReceive(message: SubscriberMessage): void | Promise<void> {
    return match(message)
      .with(P.instanceOf(DistributedDataChanged), (m) => this.onDistributedDataChanged(m))
      .with({ kind: 'probe' }, (m) => this.onProbe(m))
      .with({ kind: 'unstash' }, () => this.onUnstash())
      .with({ kind: 'filler' }, () => this.onFiller())
      .exhaustive();
  }

  private onDistributedDataChanged(message: DistributedDataChanged<GCounter>): void | Promise<void> {
    const value = message.value.value();
    if (this.control.stashing) {
      this.journal.push(`stashed:${message.key}:${value}`);
      this.context.stash();
      return;
    }
    this.received.push(message);
    this.journal.push(`changed:${message.key}:${value}`);
    const gate = this.control.park;
    if (gate === null) return;
    this.control.park = null;
    this.journal.push(`parked:${value}`);
    return gate.opened.then(() => { this.journal.push(`resumed:${value}`); });
  }

  private onProbe(message: ProbeMessage): void {
    this.journal.push(`probe:${message.label}`);
  }

  private onUnstash(): void {
    this.control.stashing = false;
    this.journal.push('unstash');
    this.context.unstashAll();
  }

  private onFiller(): void {
    this.journal.push('filler');
  }
}

/** The values the subscriber handled for `key`, in the order it handled them. */
const changedValues = (journal: readonly string[], key: string = KEY): number[] =>
  journal
    .filter((entry) => entry.startsWith(`changed:${key}:`))
    .map((entry) => Number(entry.slice(`changed:${key}:`.length)));

let probeSequence = 0;

/** Wait until the subscriber has handled everything already in its mailbox. */
async function drained(subscriber: ActorRef<SubscriberMessage>, journal: readonly string[]): Promise<void> {
  const label = `drained-${++probeSequence}`;
  subscriber.tell({ kind: 'probe', label });
  await awaitCondition(() => journal.includes(`probe:${label}`), {
    label: `the subscriber handled ${label}`,
  });
}

/**
 * Whether the replicator watches `subscriber`.  Read off the subscriber's
 * cell, which records its watchers, because nothing public says when a watch
 * ends — and when it ends is what a subscription that outlives its last
 * unsubscribe has to get right.
 */
const watchedByReplicator = (subscriber: LocalActorRef<SubscriberMessage>): boolean =>
  [...(subscriber.getCell() as unknown as { _watchers: ReadonlySet<ActorRef<unknown>> })._watchers]
    .some((watcher) => watcher.path.toString().endsWith('/cluster/crdt/data'));

/**
 * A third-party dispatcher a case steers.  It runs a unit at once, on the
 * caller's stack, unless it is holding; a held unit waits until
 * {@link HeldDispatcher.runHeld} runs it, on the caller's stack as well.  So a
 * case decides exactly when a subscriber is handed a notification — and with
 * that, when its release reaches the replicator.
 */
class HeldDispatcher implements Dispatcher {
  readonly id = 'held-test-dispatcher';
  holding = false;
  private readonly held: Array<() => void | Promise<void>> = [];

  execute(task: () => void | Promise<void>): void {
    if (this.holding) {
      this.held.push(task);
      return;
    }
    void task();
  }

  /** Stop holding, and run every unit held so far, in order. */
  runHeld(): void {
    this.holding = false;
    for (const task of this.held.splice(0)) void task();
  }
}

/**
 * Wait until the replicator has handled everything told to it so far, and
 * then until the subscriber has handled every notification that produced.
 */
async function settled(
  data: DistributedDataHandle,
  subscriber: ActorRef<SubscriberMessage>,
  journal: readonly string[],
): Promise<void> {
  await data.getAsync(KEY, { consistency: 'local' });
  await drained(subscriber, journal);
}

/* ================================ cases ================================= */

describe('an actor subscribed to a key', () => {
  test('is told a DistributedDataChanged in its own onReceive — for a local update and for a gossip merge', async () => {
    const logger = new RecordingLogger();
    const node = await startNode('ddata-ref-a', 48_801, logger);
    const data = node.system.extension(DistributedDataId).start(node);
    const journal: string[] = [];
    const received: DistributedDataChanged<GCounter>[] = [];
    node.system.spawn(() => new Subscriber(journal, newControl(), [KEY], received), 'subscriber');
    await awaitCondition(() => journal.includes(`subscribed:${KEY}`), {
      label: 'the subscriber subscribed itself in preStart',
    });

    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await awaitCondition(() => received.length === 1, { label: 'the local update was told to the subscriber' });

    const first = received[0]!;
    expect(first).toBeInstanceOf(DistributedDataChanged);
    expect(first.kind).toBe('distributed-data-changed');
    expect(first.key).toBe(KEY);
    expect(first.value.value()).toBe(1);
    // A `{ kind }` matcher reaches it as well as `P.instanceOf`.
    expect(
      match<unknown, boolean>(first)
        .with({ kind: 'distributed-data-changed', key: KEY }, () => true)
        .otherwise(() => false),
    ).toBe(true);

    // A merge from a peer, injected the way the decode-isolation suite does.
    const peer = await peerTransport('ddata-ref-peer-a', 48_802);
    peer.send(node.selfAddress, {
      kind: 'ddata-gossip',
      from: new NodeAddress('ddata-ref-peer-a', 'h', 48_802).toJSON(),
      entries: { [KEY]: GCounter.empty().increment('peer', 5).toJSON() },
    } as unknown as WireMessage);
    await awaitCondition(() => received.length === 2, { label: 'the gossip merge was told to the subscriber' });

    expect(changedValues(journal)).toEqual([1, 6]);
    // A ref filed as a listener threw on every delivery, and the replicator
    // warned about each one.
    expect(logger.records.filter((record) => record.message.includes('subscriber for'))).toEqual([]);
  });

  test("runs on its own turn: the replicator answers while the subscriber is parked in its handler", async () => {
    const node = await startNode('ddata-ref-b', 48_811);
    const data = node.system.extension(DistributedDataId).start(node);
    const journal: string[] = [];
    const control = newControl();
    const subscriber = node.system.spawn(() => new Subscriber(journal, control, [KEY]), 'subscriber');
    await awaitCondition(() => journal.includes(`subscribed:${KEY}`), { label: 'the subscriber subscribed itself' });

    const gate = newGate();
    control.park = gate;
    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await awaitCondition(() => journal.includes('parked:1'), { label: 'the subscriber is parked on the first value' });

    // An unrelated read, and a write to the subscribed key on top: both are
    // answered on the replicator's turn while the subscriber's own turn is
    // still open on a promise only this test can settle.
    const other = await data.getAsync<GCounter>(OTHER_KEY, { consistency: 'local' });
    expect(other).toBeUndefined();
    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    expect((await data.getAsync<GCounter>(KEY, { consistency: 'local' }))?.value()).toBe(2);
    expect(journal).not.toContain('resumed:1');

    gate.open();
    await drained(subscriber, journal);
    expect(journal).toContain('resumed:1');
    expect(changedValues(journal)).toEqual([1, 2]);
  });

  test('is told the latest value rather than every value: 200 updates behind a parked handler arrive as one', async () => {
    const node = await startNode('ddata-ref-c', 48_821);
    const data = node.system.extension(DistributedDataId).start(node);
    const journal: string[] = [];
    const control = newControl();
    const subscriber = node.system.spawn(() => new Subscriber(journal, control, [KEY]), 'subscriber');
    await awaitCondition(() => journal.includes(`subscribed:${KEY}`), { label: 'the subscriber subscribed itself' });

    const gate = newGate();
    control.park = gate;
    const increment = (): void => {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    };
    increment();
    await awaitCondition(() => journal.includes('parked:1'), { label: 'the subscriber is parked on the first value' });
    for (let update = 2; update <= 200; update++) increment();
    await data.getAsync(KEY, { consistency: 'local' });
    expect(journal).not.toContain('resumed:1');

    gate.open();
    await drained(subscriber, journal);
    const values = changedValues(journal);
    expect(values.length).toBeLessThanOrEqual(2);
    expect(values.at(-1)).toBe(200);
    expect(values).toEqual([1, 200]);
  });

  test('that keeps up still ends on the final value', async () => {
    const node = await startNode('ddata-ref-d', 48_831);
    const data = node.system.extension(DistributedDataId).start(node);
    const journal: string[] = [];
    const subscriber = node.system.spawn(() => new Subscriber(journal, newControl(), [KEY]), 'subscriber');
    await awaitCondition(() => journal.includes(`subscribed:${KEY}`), { label: 'the subscriber subscribed itself' });

    for (let update = 1; update <= 200; update++) {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    }
    await settled(data, subscriber, journal);

    const values = changedValues(journal);
    expect(values.at(-1)).toBe(200);
    // Every value it saw was the latest one at its dispatch, so they only grow.
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('replay, repetition and unsubscribe', () => {
  test('a key that holds a value is replayed once, through the mailbox; an absent key waits for its first merge', async () => {
    const node = await startNode('ddata-ref-e', 48_841);
    const data = node.system.extension(DistributedDataId).start(node);
    for (let update = 1; update <= 3; update++) {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    }
    await data.getAsync(KEY, { consistency: 'local' });

    const journal: string[] = [];
    const subscriber = node.system.spawn(() => new Subscriber(journal, newControl()), 'subscriber');
    data.subscribe<GCounter>(KEY, subscriber);
    data.subscribe<GCounter>(OTHER_KEY, subscriber);
    // Asynchronous, unlike the callback's replay: nothing reaches the actor
    // before the replicator has handled the subscription.
    expect(changedValues(journal)).toEqual([]);
    await settled(data, subscriber, journal);

    expect(changedValues(journal)).toEqual([3]);
    expect(changedValues(journal, OTHER_KEY)).toEqual([]);

    data.update<GCounter>(OTHER_KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await settled(data, subscriber, journal);
    expect(changedValues(journal, OTHER_KEY)).toEqual([1]);
    expect(changedValues(journal)).toEqual([3]);
  });

  test('subscribing the same actor to the same key again adds no second subscription', async () => {
    const node = await startNode('ddata-ref-f', 48_851);
    const data = node.system.extension(DistributedDataId).start(node);
    const journal: string[] = [];
    const subscriber = node.system.spawn(() => new Subscriber(journal, newControl(), [KEY]), 'subscriber');
    await awaitCondition(() => journal.includes(`subscribed:${KEY}`), { label: 'the subscriber subscribed itself' });
    // The same path, subscribed again from outside the actor.
    const unsubscribe = data.subscribe<GCounter>(KEY, subscriber);

    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await settled(data, subscriber, journal);
    expect(changedValues(journal)).toEqual([1]);

    // One subscription, so the second call's function ends the first call's too.
    unsubscribe();
    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await settled(data, subscriber, journal);
    expect(changedValues(journal)).toEqual([1]);
  });

  test('and the first call\'s function ends it as well: a repeated subscription is bound to the one it repeats', async () => {
    // The other order of the case above.  A repeated `subscribe` holds the
    // registration the first call made rather than a fresh one of its own;
    // if it took a fresh one, the first call's function would name a
    // registration no slot holds any more, end nothing, and leave the actor
    // subscribed after the only function its owner kept.
    const node = await startNode('ddata-ref-u', 49_021);
    const data = node.system.extension(DistributedDataId).start(node);
    const journal: string[] = [];
    const subscriber = node.system.spawn(() => new Subscriber(journal, newControl()), 'subscriber');
    const unsubscribeFirst = data.subscribe<GCounter>(KEY, subscriber);
    data.subscribe<GCounter>(KEY, subscriber);

    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await settled(data, subscriber, journal);
    expect(changedValues(journal)).toEqual([1]);

    unsubscribeFirst();
    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await settled(data, subscriber, journal);
    expect(changedValues(journal)).toEqual([1]);
  });

  test('unsubscribing stops delivery, and a notification already queued still arrives as it was', async () => {
    const node = await startNode('ddata-ref-g', 48_861);
    const data = node.system.extension(DistributedDataId).start(node);
    const journal: string[] = [];
    const control = newControl();
    const subscriber = node.system.spawn(() => new Subscriber(journal, control), 'subscriber');
    const unsubscribe = data.subscribe<GCounter>(KEY, subscriber);
    const increment = (): void => {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    };

    const gate = newGate();
    control.park = gate;
    increment();
    await awaitCondition(() => journal.includes('parked:1'), { label: 'the subscriber is parked on the first value' });
    increment();
    await data.getAsync(KEY, { consistency: 'local' });
    // The value 2 is queued now.  Unsubscribing leaves it where it is — and
    // leaves it at 2: the update after it no longer reaches the slot.
    unsubscribe();
    increment();
    await data.getAsync(KEY, { consistency: 'local' });

    gate.open();
    await drained(subscriber, journal);
    expect(changedValues(journal)).toEqual([1, 2]);

    increment();
    await settled(data, subscriber, journal);
    expect(changedValues(journal)).toEqual([1, 2]);
  });

  test('an unsubscribe returned for a subscription that already ended does not end a later one', async () => {
    // The same answer the callback form gives: a subscription is the
    // subscriber's and the key's, and a function `subscribe` returned ends the
    // subscription it was returned for, not whichever one holds the slot now.
    const node = await startNode('ddata-ref-h', 48_871);
    const data = node.system.extension(DistributedDataId).start(node);
    const journal: string[] = [];
    const subscriber = node.system.spawn(() => new Subscriber(journal, newControl()), 'subscriber');

    const unsubscribeFirst = data.subscribe<GCounter>(KEY, subscriber);
    unsubscribeFirst();
    data.subscribe<GCounter>(KEY, subscriber);
    unsubscribeFirst();

    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await settled(data, subscriber, journal);
    expect(changedValues(journal)).toEqual([1]);
  });

  test('subscribing again before the notification an ended subscription left is handed over takes it over', async () => {
    // Ending a subscription leaves its queued notification where it is.  A
    // subscription taken out before the actor is handed it used to start a
    // slot of its own, and its replay posted a second notification for the
    // same key behind the first.
    const node = await startNode('ddata-ref-p', 48_971);
    const data = node.system.extension(DistributedDataId).start(node);
    const journal: string[] = [];
    const control = newControl();
    const subscriber = node.system.spawn(() => new Subscriber(journal, control), 'subscriber');
    const increment = (): void => {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    };

    const gate = newGate();
    control.park = gate;
    const unsubscribeFirst = data.subscribe<GCounter>(KEY, subscriber);
    increment();
    await awaitCondition(() => journal.includes('parked:1'), { label: 'the subscriber is parked on the first value' });
    increment();
    await data.getAsync(KEY, { consistency: 'local' });

    // 2 is queued.  End the subscription, and take one out again at once.
    unsubscribeFirst();
    data.subscribe<GCounter>(KEY, subscriber);
    // The function kept from the ended subscription ends nothing — not the
    // subscription that took its notification over.
    unsubscribeFirst();
    // Taken over, so the change lands in the notification still queued.
    increment();
    await data.getAsync(KEY, { consistency: 'local' });

    gate.open();
    await drained(subscriber, journal);
    expect(changedValues(journal)).toEqual([1, 3]);

    // And it is a live subscription: the next change is posted afresh.
    increment();
    await settled(data, subscriber, journal);
    expect(changedValues(journal)).toEqual([1, 3, 4]);
  });

  test('a subscription that ended with a notification queued ends the watch once that notification is handed over', async () => {
    // The replicator keeps watching while a notification the ended
    // subscription left is still to be handed over, so a subscriber that
    // stopped first would still be cleaned up by its `Terminated`.  Handed
    // over, nothing is left to wait for, and the watch goes.
    const node = await startNode('ddata-ref-q', 48_981);
    const data = node.system.extension(DistributedDataId).start(node);
    const journal: string[] = [];
    const control = newControl();
    const subscriber = node.system.spawn(
      () => new Subscriber(journal, control),
      'subscriber',
    ) as LocalActorRef<SubscriberMessage>;
    const increment = (): void => {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    };

    const gate = newGate();
    control.park = gate;
    const unsubscribe = data.subscribe<GCounter>(KEY, subscriber);
    increment();
    await awaitCondition(() => journal.includes('parked:1'), { label: 'the subscriber is parked on the first value' });
    increment();
    await data.getAsync(KEY, { consistency: 'local' });

    unsubscribe();
    await data.getAsync(KEY, { consistency: 'local' });
    expect(watchedByReplicator(subscriber)).toBe(true);

    gate.open();
    await drained(subscriber, journal);
    expect(changedValues(journal)).toEqual([1, 2]);
    await awaitCondition(() => !watchedByReplicator(subscriber), {
      label: 'the replicator ended the watch once the queued notification was handed over',
    });
  });
});

describe('death watch and restarts', () => {
  test("a stopped subscriber's subscriptions are dropped: a later update produces no dead letter for it", async () => {
    const node = await startNode('ddata-ref-i', 48_881);
    const data = node.system.extension(DistributedDataId).start(node);
    const letters: DeadLetter[] = [];
    const unsubscribeLetters = node.system.eventStream.subscribeFunction(DeadLetter, (letter) => {
      letters.push(letter);
    });
    try {
      const journal: string[] = [];
      const subscriber = node.system.spawn(
        () => new Subscriber(journal, newControl(), [KEY, OTHER_KEY]),
        'subscriber',
      ) as LocalActorRef<SubscriberMessage>;
      await awaitCondition(() => journal.includes(`subscribed:${OTHER_KEY}`), {
        label: 'the subscriber subscribed itself to both keys',
      });
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
      data.update<GCounter>(OTHER_KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
      // Both slots empty again: every notification has been handed over, so
      // the next merge would post a fresh one if the slot were still there.
      await settled(data, subscriber, journal);
      expect(changedValues(journal)).toEqual([1]);
      expect(changedValues(journal, OTHER_KEY)).toEqual([1]);

      subscriber.stop();
      await awaitCondition(() => subscriber.getCell().isTerminated(), { label: 'the subscriber terminated' });
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
      data.update<GCounter>(OTHER_KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
      await data.getAsync(KEY, { consistency: 'local' });

      const subscriberPath = subscriber.path.toString();
      expect(letters.filter((letter) => letter.recipient.path.toString() === subscriberPath)).toEqual([]);
    } finally {
      unsubscribeLetters();
    }
  });

  test('a replicator restarted by a throwing mutator keeps the subscription, and its death watch', async () => {
    // Without a durable store, so the restart's own preStart reloads nothing.
    const node = await startNode('ddata-ref-j', 48_891);
    const data = node.system.extension(DistributedDataId).start(node);
    const restarts: ActorRestarted[] = [];
    const letters: DeadLetter[] = [];
    const unsubscribeRestarts = node.system.eventStream.subscribeFunction(ActorRestarted, (event) => {
      restarts.push(event);
    });
    const unsubscribeLetters = node.system.eventStream.subscribeFunction(DeadLetter, (letter) => {
      letters.push(letter);
    });
    try {
      const journal: string[] = [];
      const subscriber = node.system.spawn(
        () => new Subscriber(journal, newControl(), [KEY]),
        'subscriber',
      ) as LocalActorRef<SubscriberMessage>;
      await awaitCondition(() => journal.includes(`subscribed:${KEY}`), { label: 'the subscriber subscribed itself' });
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
      await settled(data, subscriber, journal);
      expect(changedValues(journal)).toEqual([1]);

      data.update<GCounter>(OTHER_KEY, GCounter.empty, () => { throw new Error('mutator failed'); });
      await awaitCondition(
        () => restarts.some((event) => event.actor.path.toString().endsWith('/cluster/crdt/data')),
        { label: 'the replicator restarted' },
      );

      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
      await settled(data, subscriber, journal);
      expect(changedValues(journal)).toEqual([1, 2]);

      // The watch is the cell's, so it outlived the instance as well.
      subscriber.stop();
      await awaitCondition(() => subscriber.getCell().isTerminated(), { label: 'the subscriber terminated' });
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
      await data.getAsync(KEY, { consistency: 'local' });
      const subscriberPath = subscriber.path.toString();
      expect(letters.filter((letter) => letter.recipient.path.toString() === subscriberPath)).toEqual([]);
    } finally {
      unsubscribeRestarts();
      unsubscribeLetters();
    }
  });

  test('a subscriber that stops with an ended subscription still queued leaves nothing behind for the next one on its path', async () => {
    // A slot kept for the notification an ended subscription left belongs to
    // that actor.  Its `Terminated` has to take the slot along: left behind,
    // an actor spawned later on the same path would be bound to it by its
    // first subscription, its replay would land in the dead actor's mailbox,
    // and the slot would wait for ever on a hand-over that cannot come.
    const node = await startNode('ddata-ref-r', 48_991);
    const data = node.system.extension(DistributedDataId).start(node);
    const increment = (): void => {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    };
    const journal: string[] = [];
    const control = newControl();
    const first = node.system.spawn(
      () => new Subscriber(journal, control),
      'subscriber',
    ) as LocalActorRef<SubscriberMessage>;

    const gate = newGate();
    control.park = gate;
    const unsubscribe = data.subscribe<GCounter>(KEY, first);
    increment();
    await awaitCondition(() => journal.includes('parked:1'), { label: 'the subscriber is parked on the first value' });
    increment();
    await data.getAsync(KEY, { consistency: 'local' });
    unsubscribe();
    await data.getAsync(KEY, { consistency: 'local' });

    // Stopped from its system queue, the way a supervisor's stop or a
    // parent's shutdown reaches it, so the terminate overtakes the queued
    // notification and the actor is never handed it.  `stop()` would queue a
    // `PoisonPill` behind the notification, whose hand-over then lets go of
    // the slot by itself.
    first.getCell().stopSelf();
    gate.open();
    // The name is free once the guardian has dropped the child, which the cell
    // tells it after posting its watchers their `Terminated`; the read after
    // that is answered past the replicator's.
    await awaitCondition(() => node.system._resolvePath(['user', 'subscriber']).isNone(), {
      label: 'the first subscriber terminated and its name was freed',
    });
    await data.getAsync(KEY, { consistency: 'local' });

    const nextJournal: string[] = [];
    const next = node.system.spawn(() => new Subscriber(nextJournal, newControl()), 'subscriber');
    expect(next.path.toString()).toBe(first.path.toString());
    data.subscribe<GCounter>(KEY, next);
    await settled(data, next, nextJournal);
    expect(changedValues(nextJournal)).toEqual([2]);

    increment();
    await settled(data, next, nextJournal);
    expect(changedValues(nextJournal)).toEqual([2, 3]);
  });

  test('a notification stashed and unstashed keeps its value, and later ones still arrive', async () => {
    const node = await startNode('ddata-ref-k', 48_901);
    const data = node.system.extension(DistributedDataId).start(node);
    const journal: string[] = [];
    const control = newControl();
    const subscriber = node.system.spawn(() => new Subscriber(journal, control, [KEY]), 'subscriber');
    await awaitCondition(() => journal.includes(`subscribed:${KEY}`), { label: 'the subscriber subscribed itself' });
    const increment = (): void => {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    };

    control.stashing = true;
    increment();
    await awaitCondition(() => journal.includes(`stashed:${KEY}:1`), { label: 'the first value was stashed' });
    increment();
    await awaitCondition(() => journal.includes(`stashed:${KEY}:2`), { label: 'the second value was stashed' });

    subscriber.tell({ kind: 'unstash' });
    await drained(subscriber, journal);
    expect(changedValues(journal)).toEqual([1, 2]);

    increment();
    await settled(data, subscriber, journal);
    expect(changedValues(journal)).toEqual([1, 2, 3]);
  });
});

describe('a bounded subscriber', () => {
  test('with capacity 1 and drop-head still handles the latest value after a burst', async () => {
    // The notification rides the exempt door.  Told like any message, it is
    // the oldest droppable envelope once a filler arrives behind it, and
    // drop-head evicts it — leaving its slot waiting for a hand-over that
    // never comes, so no later value is ever posted either.
    const node = await startNode('ddata-ref-l', 48_911);
    const data = node.system.extension(DistributedDataId).start(node);
    const journal: string[] = [];
    const control = newControl();
    const boundedOptions = ActorOptions.create<SubscriberMessage>()
      .withMailboxCapacity(1)
      .withMailboxOverflow('drop-head');
    const subscriber = node.system.spawn(() => new Subscriber(journal, control), 'subscriber', boundedOptions);
    data.subscribe<GCounter>(KEY, subscriber);
    const increment = (): void => {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    };

    const gate = newGate();
    control.park = gate;
    increment();
    await awaitCondition(() => journal.includes('parked:1'), { label: 'the subscriber is parked on the first value' });
    for (let update = 2; update <= 200; update++) increment();
    await data.getAsync(KEY, { consistency: 'local' });
    for (let filler = 0; filler < 3; filler++) subscriber.tell({ kind: 'filler' });

    gate.open();
    await drained(subscriber, journal);
    expect(changedValues(journal)).toEqual([1, 200]);

    increment();
    await settled(data, subscriber, journal);
    expect(changedValues(journal)).toEqual([1, 200, 201]);
  });

  test('holds at most one notification per key queued, however often it unsubscribes and subscribes again', async () => {
    // The bound that lets a notification past the mailbox's own is one per
    // subscriber and key.  Each unsubscribe and subscribe while the actor was
    // behind used to add one more envelope that no policy could shed — so the
    // overshoot followed the caller's subscribe calls rather than its keys.
    // Capacity 1 makes every such envelope show in the mailbox's size.
    const node = await startNode('ddata-ref-s', 49_001);
    const data = node.system.extension(DistributedDataId).start(node);
    const journal: string[] = [];
    const control = newControl();
    const boundedOptions = ActorOptions.create<SubscriberMessage>()
      .withMailboxCapacity(1)
      .withMailboxOverflow('drop-head');
    const subscriber = node.system.spawn(
      () => new Subscriber(journal, control),
      'subscriber',
      boundedOptions,
    ) as LocalActorRef<SubscriberMessage>;
    const increment = (): void => {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    };

    const gate = newGate();
    control.park = gate;
    let unsubscribe = data.subscribe<GCounter>(KEY, subscriber);
    increment();
    await awaitCondition(() => journal.includes('parked:1'), { label: 'the subscriber is parked on the first value' });
    increment();
    await data.getAsync(KEY, { consistency: 'local' });
    expect(subscriber.getCell().mailboxSize).toBe(1);

    // Subscribing again, with the subscription still in force, replays into
    // the notification already queued.
    for (let repeat = 0; repeat < 5; repeat++) data.subscribe<GCounter>(KEY, subscriber);
    await data.getAsync(KEY, { consistency: 'local' });
    expect(subscriber.getCell().mailboxSize).toBe(1);

    // And so does subscribing again after ending it.
    for (let cycle = 0; cycle < 5; cycle++) {
      unsubscribe();
      unsubscribe = data.subscribe<GCounter>(KEY, subscriber);
    }
    await data.getAsync(KEY, { consistency: 'local' });
    expect(subscriber.getCell().mailboxSize).toBe(1);

    increment();
    await data.getAsync(KEY, { consistency: 'local' });
    expect(subscriber.getCell().mailboxSize).toBe(1);

    gate.open();
    await drained(subscriber, journal);
    expect(changedValues(journal)).toEqual([1, 3]);
  });
});

describe('a subscriber whose dispatcher runs its turn inside the post', () => {
  test('is still told every change, because its release is in place before the hand-over', async () => {
    // A third-party `Dispatcher` may run a unit at once, on the caller's
    // stack.  Then the subscriber's turn — and the hand-over that fires the
    // release — runs inside the replicator's post, before `postSignalEnvelope`
    // has returned.  A release held only after the enqueue is not there yet:
    // it never fires, the slot waits on it for ever, every later change is
    // written into a notification the actor has already handled, and it is
    // never told anything again.  And the replicator marks the slot before it
    // posts, so the release that fires inside the post finds the mark to clear.
    const node = await startNode('ddata-ref-t', 49_011);
    const data = node.system.extension(DistributedDataId).start(node);
    const journal: string[] = [];
    const synchronous: Dispatcher = {
      id: 'synchronous-test-dispatcher',
      execute(task) { void task(); },
    };
    const synchronousOptions = ActorOptions.create<SubscriberMessage>().withDispatcher(synchronous);
    const subscriber = node.system.spawn(
      () => new Subscriber(journal, newControl(), [KEY]),
      'subscriber',
      synchronousOptions,
    ) as LocalActorRef<SubscriberMessage>;
    await awaitCondition(() => journal.includes(`subscribed:${KEY}`), { label: 'the subscriber subscribed itself' });

    for (let update = 1; update <= 3; update++) {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
      await settled(data, subscriber, journal);
    }

    expect(changedValues(journal)).toEqual([1, 2, 3]);
    // Every release fired at its hand-over, and the cell holds none.
    expect(subscriber.getCell()._pendingReleasesForTest()).toBeNull();
  });

  test('keeps a subscription taken out while the hand-over its ended predecessor announced is still on its way', async () => {
    // The release of a notification an ended subscription left tells the
    // replicator, which drops the slot kept for it when that message arrives
    // — unless a subscription has taken the slot over by then.  Taken over is
    // not the same as holding a queued replay: on this dispatcher the replay
    // is handed over inside the post, so the slot is empty again before the
    // replicator reads the message.  Judged by its emptiness alone, the slot
    // would be dropped there, and the new subscription would end in silence.
    const node = await startNode('ddata-ref-v', 49_031);
    const data = node.system.extension(DistributedDataId).start(node);
    const journal: string[] = [];
    const dispatcher = new HeldDispatcher();
    const heldOptions = ActorOptions.create<SubscriberMessage>().withDispatcher(dispatcher);
    const subscriber = node.system.spawn(
      () => new Subscriber(journal, newControl()),
      'subscriber',
      heldOptions,
    ) as LocalActorRef<SubscriberMessage>;
    const increment = (): void => {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    };
    const unsubscribeFirst = data.subscribe<GCounter>(KEY, subscriber);
    await data.getAsync(KEY, { consistency: 'local' });

    // Held, the first value's notification stays queued.
    dispatcher.holding = true;
    increment();
    await data.getAsync(KEY, { consistency: 'local' });
    expect(subscriber.getCell().mailboxSize).toBe(1);

    // Ended with it queued, so the slot is kept for it.
    unsubscribeFirst();
    await data.getAsync(KEY, { consistency: 'local' });

    // Subscribe again — told now, handled on the replicator's next turn — and
    // hand the actor the queued notification first.  Its release finds the
    // subscription ended and tells the replicator, behind the new subscription.
    data.subscribe<GCounter>(KEY, subscriber);
    dispatcher.runHeld();
    expect(changedValues(journal)).toEqual([1]);

    // The replicator takes the new subscription — whose replay the actor is
    // handed inside the post — and only then the hand-over.
    await data.getAsync(KEY, { consistency: 'local' });
    expect(changedValues(journal)).toEqual([1, 1]);

    increment();
    await settled(data, subscriber, journal);
    expect(changedValues(journal)).toEqual([1, 1, 2]);
  });
});

describe('subscribers that are not an actor on this node', () => {
  test('a RemoteActorRef is refused at the call site with a TypeError', async () => {
    const node = await startNode('ddata-ref-m', 48_921);
    const data = node.system.extension(DistributedDataId).start(node);
    const remote = new RemoteActorRef<DistributedDataChanged<GCounter>>(
      new NodeAddress('ddata-ref-elsewhere', 'h', 48_922),
      '/user/subscriber',
      node,
    );

    expect(() => data.subscribe<GCounter>(KEY, remote)).toThrow(TypeError);
    expect(() => data.subscribe<GCounter>(KEY, remote)).toThrow(/own node/);
  });

  test('a TestProbe is told one DistributedDataChanged per change', async () => {
    const node = await startNode('ddata-ref-n', 48_931);
    const data = node.system.extension(DistributedDataId).start(node);
    const probe = new TestProbe(node.system);
    data.subscribe<GCounter>(KEY, probe);

    for (let update = 1; update <= 3; update++) {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    }
    await data.getAsync(KEY, { consistency: 'local' });

    // Told on the replicator's turn, so all three are in the probe already.
    expect(probe.messageCount).toBe(3);
    const changes = await probe.receiveN(3);
    for (const change of changes) expect(change).toBeInstanceOf(DistributedDataChanged);
    expect(changes.map((change) => (change as DistributedDataChanged<GCounter>).value.value())).toEqual([1, 2, 3]);
  });

  test('something that is neither a function nor an ActorRef is refused with a TypeError', async () => {
    const node = await startNode('ddata-ref-o', 48_941);
    const data = node.system.extension(DistributedDataId).start(node);
    const impostor = { tell: () => {} } as unknown as ActorRef<DistributedDataChanged<GCounter>>;

    expect(() => data.subscribe<GCounter>(KEY, impostor)).toThrow(TypeError);
  });
});
