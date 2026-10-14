/**
 * The chat and voice samples' DistributedData wrappers, subscribed as actors
 * (#1468).
 *
 * `ChatRoomDirectoryActor`, `OnlineUsersActor` and `ReadReceiptsActor` (chat)
 * and `VoicePresenceActor` (voice) each hold one DistributedData subscription
 * per key and fan every change out to the sessions subscribed to them.  They
 * used to subscribe a callback, which runs on the replicator's turn — so the
 * fan-out, and the writes to the actor's own fields that came with it, ran on
 * the replicator's time and outside the actor's mailbox order.  Each now
 * subscribes its own ref and is told a `DistributedDataChanged`, handled on
 * its own turn like any other message.  Three things follow from that, and
 * each block pins them:
 *
 *   - the notification is a message in the actor's protocol, so an actor that
 *     cannot match it fails — the first case tells one by hand;
 *   - the replay of a key's current value arrives later, as a message, so the
 *     actor starts from `get(key)` instead, or a session subscribing first
 *     would be told an empty list;
 *   - a notification queued before a key's last session left still arrives
 *     after the subscription has ended, and has nobody to go to.
 *
 * Single node on `InMemoryTransport`, as the crdt suites set it up.  No wait
 * here is on a clock: `getAsync(key, { consistency: 'local' })` is answered on
 * the replicator's turn after everything told to it before, so every
 * notification that produced is already in the actor's mailbox when it
 * resolves; a reply-bearing command told to the actor after that is answered
 * after every one of them; and a `TestProbe` is told synchronously, so what
 * the actor sent before that reply is already in the probe.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { isDeepStrictEqual } from 'node:util';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { DistributedDataChanged, DistributedDataId } from '../../../src/crdt/index.js';
// Not re-exported by any entry point yet (#1307); only its type is needed.
import type { DistributedDataHandle } from '../../../src/crdt/DistributedData.js';
import { ORSet } from '../../../src/crdt/ORSet.js';
import { NoopLogger } from '../../../src/Logger.js';
import { TestProbe } from '../../../src/testkit/TestProbe.js';
import {
  ChatRoomDirectoryActor,
  ROOMS_DD_KEY,
  type ChatRoomDirectoryCommand,
} from '../../../examples/chat/backend/actors/ChatRoomDirectoryActor.js';
import { DEFAULT_ROOMS } from '../../../examples/chat/shared/rooms.js';

/* ============================== fixtures ================================ */

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

/** In-memory addresses: nothing binds, and a node's name and port make its address unique. */
let nextPort = 49_501;

type Node = { readonly system: ActorSystem; readonly data: DistributedDataHandle };

async function startNode(name: string): Promise<Node> {
  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger());
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  const port = nextPort++;
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)));
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return { system, data: system.extension(DistributedDataId).start(cluster) };
}

/** One `subscribe` a sample actor made, and how often it called the function it got back. */
type SubscribeCall = { readonly key: string; readonly subscriber: unknown; unsubscribed: number };

/**
 * Record every `subscribe` made through `data`.  The actors read the handle
 * from the extension, which hands out this same instance, so wrapping it here
 * sees their calls.  Each call goes through; the function it returns is
 * wrapped to count its own calls.
 */
function recordSubscriptions(data: DistributedDataHandle): SubscribeCall[] {
  const calls: SubscribeCall[] = [];
  const subscribe = data.subscribe.bind(data) as unknown as (key: string, subscriber: unknown) => () => void;
  const recording = (key: string, subscriber: unknown): (() => void) => {
    const call: SubscribeCall = { key, subscriber, unsubscribed: 0 };
    calls.push(call);
    const unsubscribe = subscribe(key, subscriber);
    return () => {
      call.unsubscribed++;
      unsubscribe();
    };
  };
  Object.assign(data, { subscribe: recording });
  return calls;
}

/** An ORSet holding `elements`, as another replica wrote them — what a notification would carry. */
const orSetOf = (...elements: string[]): ORSet<string> =>
  elements.reduce((set, element) => set.add('dd-sample-writer', element), ORSet.empty<string>());

/**
 * Wait until everything told so far has run its course: the actor has handled
 * it, and with it told the replicator what it subscribed to; the replicator
 * has handled that, and posted whatever it owed the actor; and the actor has
 * handled those notifications too.  `roundTrip` is a reply-bearing command of
 * the actor's own protocol.
 */
async function settled(data: DistributedDataHandle, roundTrip: () => Promise<void>): Promise<void> {
  await roundTrip();
  await data.getAsync('dd-sample-barrier', { consistency: 'local' });
  await roundTrip();
}

const sorted = (values: Iterable<string>): string[] => [...values].sort();

/* ======================== ChatRoomDirectoryActor ======================== */

describe('ChatRoomDirectoryActor', () => {
  /** The rooms the directory currently answers `GetRooms` with — also its round trip. */
  async function roomsListed(node: Node, directory: ActorRef<ChatRoomDirectoryCommand>): Promise<string[]> {
    const replies = new TestProbe(node.system);
    directory.tell({ kind: 'GetRooms', replyTo: replies });
    const reply = (await replies.receiveOne()) as { readonly rooms: ReadonlyArray<string> };
    return sorted(reply.rooms);
  }

  /** A directory with one subscribed session, settled on the default rooms it seeds itself. */
  async function directoryWithSession(name: string) {
    const node = await startNode(name);
    const subscriptions = recordSubscriptions(node.data);
    const directory = node.system.spawn(ChatRoomDirectoryActor, 'chat-room-directory');
    const session = new TestProbe(node.system);
    directory.tell({ kind: 'Subscribe', ref: session });
    await settled(node.data, async () => { await roomsListed(node, directory); });
    expect(await roomsListed(node, directory)).toEqual(sorted(DEFAULT_ROOMS));
    session.clearInbox();
    return { node, subscriptions, directory, session };
  }

  test('a DistributedDataChanged for the rooms key tells a subscribed session RoomsChanged and RoomAdded', async () => {
    const { node, directory, session } = await directoryWithSession('dd-sample-directory-a');

    directory.tell(new DistributedDataChanged(ROOMS_DD_KEY, orSetOf(...DEFAULT_ROOMS, 'lobby')));

    const rooms = (await session.receiveOne()) as { readonly kind: string; readonly rooms: ReadonlyArray<string> };
    expect(rooms.kind).toBe('RoomsChanged');
    expect(sorted(rooms.rooms)).toEqual(sorted([...DEFAULT_ROOMS, 'lobby']));
    expect(await session.receiveOne()).toEqual({ kind: 'RoomAdded', name: 'lobby' });
    // And it is the set the next change is diffed against.
    expect(await roomsListed(node, directory)).toEqual(sorted([...DEFAULT_ROOMS, 'lobby']));
  });

  test('one notification carrying several changes — a coalesced burst — yields an event per room', async () => {
    const { directory, session } = await directoryWithSession('dd-sample-directory-b');
    const [gone, ...kept] = DEFAULT_ROOMS;

    directory.tell(new DistributedDataChanged(ROOMS_DD_KEY, orSetOf(...kept, 'lobby', 'kitchen')));

    const told = await session.receiveN(4);
    expect(told[0]).toMatchObject({ kind: 'RoomsChanged' });
    expect(told.slice(1)).toEqual([
      { kind: 'RoomAdded', name: 'lobby' },
      { kind: 'RoomAdded', name: 'kitchen' },
      { kind: 'RoomRemoved', name: gone },
    ]);
  });

  test('a notification for any other key is not taken for the rooms', async () => {
    const { node, directory, session } = await directoryWithSession('dd-sample-directory-c');

    directory.tell(new DistributedDataChanged('online-users.general', orSetOf('alice')));

    expect(await roomsListed(node, directory)).toEqual(sorted(DEFAULT_ROOMS));
    expect(session.messageCount).toBe(0);
  });

  test('a session subscribing before the replay is handled is told the rooms the replica already holds', async () => {
    const node = await startNode('dd-sample-directory-d');
    node.data.update<ORSet<string>>(
      ROOMS_DD_KEY,
      () => ORSet.empty<string>(),
      (rooms) => rooms.add(node.data.selfReplicaId(), 'lobby'),
    );
    await node.data.getAsync(ROOMS_DD_KEY, { consistency: 'local' });

    const directory = node.system.spawn(ChatRoomDirectoryActor, 'chat-room-directory');
    const session = new TestProbe(node.system);
    // Told before the replicator can have handled the subscription the
    // actor's preStart makes, so this is handled ahead of that replay.
    directory.tell({ kind: 'Subscribe', ref: session });

    expect(await session.receiveOne()).toEqual({ kind: 'RoomsChanged', rooms: ['lobby'] });
  });

  test('subscribes its own ref to the rooms key, and a room created through it reaches the session', async () => {
    const { subscriptions, directory, session } = await directoryWithSession('dd-sample-directory-e');

    expect(subscriptions.map((call) => call.key)).toEqual([ROOMS_DD_KEY]);
    expect(subscriptions[0]!.subscriber).toBe(directory);

    directory.tell({ kind: 'Create', name: 'lobby' });
    await session.fishForMessage((m) => isDeepStrictEqual(m, { kind: 'RoomAdded', name: 'lobby' }));
  });
});
