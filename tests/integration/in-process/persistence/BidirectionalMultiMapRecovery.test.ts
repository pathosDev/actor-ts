import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  everyNEvents,
  PersistenceExtensionId,
  PersistentActor,
  SqliteJournal,
  SqliteJournalOptions,
  SqliteSnapshotStore,
  SqliteSnapshotStoreOptions,
  type SnapshotPolicy,
} from '../../../../src/persistence/index.js';
import { BidirectionalMultiMap } from '../../../../src/util/BidirectionalMultiMap.js';

import { gracefulStop } from '../../../../src/pattern/GracefulStop.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/**
 * The same promise #1035 made for the 1:1 map, made again for the
 * many-to-many one (#1037): it can simply be held in an actor's state — no
 * `SnapshotAdapter`, no serializer registration, no `toJSON` call at the
 * boundary.  So this actor declares **no adapter of any kind** and the
 * assertions check `instanceof`, not just the data.
 *
 * SQLite rather than an in-memory store, for the reason
 * `BidirectionalMapRecovery.test.ts` gives: an in-memory store that kept
 * object references would pass while a real backend corrupted the row.
 *
 * The event sequence is built so recovery has to do the hard version of the
 * job.  Snapshotting every 2nd event over five events stores one at sequence
 * 4 and leaves a trailing journal event — and that trailing event is the
 * *unsubscribe*, so the participant-pruning invariant is exercised while
 * folding a decoded snapshot rather than on a freshly built relation.  A
 * decoder that restored an empty participant, or a reducer that lost the
 * pruning across the snapshot boundary, fails here and nowhere else.
 */

type SubscribeCommand = { kind: 'subscribe'; topic: string; subscriber: string };
type UnsubscribeCommand = { kind: 'unsubscribe'; topic: string; subscriber: string };
type Command = SubscribeCommand | UnsubscribeCommand;

type SubscribedEvent = { kind: 'subscribed'; topic: string; subscriber: string };
type UnsubscribedEvent = { kind: 'unsubscribed'; topic: string; subscriber: string };
type Event = SubscribedEvent | UnsubscribedEvent;

type State = { subscriptions: BidirectionalMultiMap<string, string> };

class TopicRegistry extends PersistentActor<Command, Event, State> {
  readonly persistenceId: string;

  constructor(persistenceId: string, private readonly replyTo?: (state: State) => void) {
    super();
    this.persistenceId = persistenceId;
  }

  initialState(): State {
    return { subscriptions: new BidirectionalMultiMap<string, string>() };
  }

  override snapshotPolicy(): SnapshotPolicy<State, Event> {
    return everyNEvents(2);
  }

  onEvent(state: State, event: Event): State {
    return match(event)
      .with({ kind: 'subscribed' }, (e) => this.onSubscribed(state, e))
      .with({ kind: 'unsubscribed' }, (e) => this.onUnsubscribed(state, e))
      .exhaustive();
  }

  async onCommand(_state: State, command: Command): Promise<void> {
    await match(command)
      .with({ kind: 'subscribe' }, (c) => this.onSubscribe(c))
      .with({ kind: 'unsubscribe' }, (c) => this.onUnsubscribe(c))
      .exhaustive();
  }

  override onRecoveryComplete(state: State): void {
    this.replyTo?.(state);
  }

  private onSubscribed(state: State, event: SubscribedEvent): State {
    const next = new BidirectionalMultiMap([...state.subscriptions]);
    next.add(event.topic, event.subscriber);
    return { subscriptions: next };
  }

  private onUnsubscribed(state: State, event: UnsubscribedEvent): State {
    const next = new BidirectionalMultiMap([...state.subscriptions]);
    next.delete(event.topic, event.subscriber);
    return { subscriptions: next };
  }

  private async onSubscribe(command: SubscribeCommand): Promise<void> {
    await this.persist({ kind: 'subscribed', topic: command.topic, subscriber: command.subscriber });
  }

  private async onUnsubscribe(command: UnsubscribeCommand): Promise<void> {
    await this.persist({ kind: 'unsubscribed', topic: command.topic, subscriber: command.subscriber });
  }
}

describe('PersistentActor — a BidirectionalMultiMap in state, with no adapter (#1037)', () => {
  test('recovers as a real instance with the reverse direction intact', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('bidirectional-multi-map-recovery', systemOptions);
    const journalOptions = SqliteJournalOptions.create().withPath(':memory:');
    const journal = new SqliteJournal(journalOptions);
    const snapshotOptions = SqliteSnapshotStoreOptions.create().withPath(':memory:');
    const snapshots = new SqliteSnapshotStore(snapshotOptions);
    const extension = system.extension(PersistenceExtensionId);
    extension.setJournal(journal);
    extension.setSnapshotStore(snapshots);

    const writer = system.spawn(() => new TopicRegistry('registry-1'), 'writer');
    writer.tell({ kind: 'subscribe', topic: 'news', subscriber: 'ada' });
    writer.tell({ kind: 'subscribe', topic: 'news', subscriber: 'grace' });
    writer.tell({ kind: 'subscribe', topic: 'sport', subscriber: 'ada' });
    writer.tell({ kind: 'subscribe', topic: 'sport', subscriber: 'linus' });
    // The trailing event, folded on top of the snapshot at recovery: it leaves
    // 'linus' holding nothing, so the participant must not survive at all.
    writer.tell({ kind: 'unsubscribe', topic: 'sport', subscriber: 'linus' });

    await awaitCondition(async () => (await journal.read('registry-1', 1)).length === 5, {
      timeoutMs: 4_000,
      label: 'all five registry events reached the SQLite journal',
    });

    const storedSnapshot = (await snapshots.loadLatest<State>('registry-1')).toNullable();
    expect(storedSnapshot?.sequenceNr).toBe(4);
    // The snapshot came back off disk as an instance, not just as data.
    expect(storedSnapshot?.state.subscriptions).toBeInstanceOf(BidirectionalMultiMap);
    expect(storedSnapshot?.state.subscriptions.size).toBe(4);

    // The reader below recovers the same persistenceId, so the writer has to be
    // really gone and not merely asked to stop.  `gracefulStop` resolves on the
    // termination itself, which is what the 50 ms was guessing at (#418).
    expect(await gracefulStop(writer, 4_000)).toBe(true);

    let recovered: State | undefined;
    system.spawn(() => new TopicRegistry('registry-1', (s) => { recovered = s; }), 'reader');
    await awaitCondition(() => recovered !== undefined, {
      timeoutMs: 4_000,
      label: 'the reader finished recovering from snapshot + journal',
    });

    const state = recovered!;
    expect(state.subscriptions).toBeInstanceOf(BidirectionalMultiMap);
    expect([...state.subscriptions]).toEqual([
      ['news', 'ada'],
      ['news', 'grace'],
      ['sport', 'ada'],
    ]);

    // The half that is never written: reconstructed on decode, or this is a
    // plain object wearing the right data.
    expect([...state.subscriptions.getKeys('ada')]).toEqual(['news', 'sport']);
    expect(state.subscriptions.hasRight('grace')).toBe(true);
    expect([...state.subscriptions.inverse().get('ada')]).toEqual(['news', 'sport']);

    // The pruning invariant, across the snapshot boundary.
    expect(state.subscriptions.hasRight('linus')).toBe(false);
    expect([...state.subscriptions.rights()]).toEqual(['ada', 'grace']);
    expect(state.subscriptions.size).toBe(3);

    await system.terminate();
  });
});
