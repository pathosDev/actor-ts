/**
 * The snapshot an actor subscriber keeps of what it was told, as the chat and
 * voice samples keep it (#1468).
 *
 * `OnlineUsersActor`, `ReadReceiptsActor` and `VoicePresenceActor` subscribe
 * their own ref with `subscribe(key, ref)` and fan every
 * `DistributedDataChanged` out to their sessions — the pattern the subscriber
 * contract invites for anything that touches actor state.  Each also writes
 * the value down, on its own turn, as the snapshot a session joining later is
 * told first.  That write is the one step nothing else covers:
 *
 *  - the first session to watch a key is told a value read afresh with
 *    `get(key)`, because the replay of the key's value arrives later, as a
 *    message — so that path passes without the write;
 *  - a session already watching is told every change from the notification
 *    itself — so that path passes without it too.
 *
 * Only a session that joins after a change reads the snapshot, and without
 * the write it is told the value from before the change — for these samples,
 * nobody online and no receipts.
 *
 * Single node on `InMemoryTransport`, as the other suites in this directory
 * run it.  Nothing waits on a clock: a `TestProbe` is told synchronously, and
 * the first session is told the change from the same turn that writes the
 * snapshot, so by the time it has received it the snapshot is written.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { NoopLogger } from '../../../src/Logger.js';
import { TestProbe } from '../../../src/testkit/TestProbe.js';
import { DistributedDataId } from '../../../src/crdt/index.js';
import { OnlineUsersActor } from '../../../examples/chat/backend/actors/OnlineUsersActor.js';
import { ReadReceiptsActor } from '../../../examples/chat/backend/actors/ReadReceiptsActor.js';
import { VoicePresenceActor, roomUsersKey } from '../../../examples/voice/backend/actors/VoicePresenceActor.js';

/* ============================== fixtures ================================ */

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

/** A node with DistributedData started, as the samples' `main.ts` does before spawning them. */
async function startNode(name: string, port: number): Promise<ActorSystem> {
  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger());
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)));
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  system.extension(DistributedDataId).start(cluster);
  return system;
}

/* ================================ cases ================================= */

describe('a session that joins after a change is told the change, not the value before it', () => {
  test('OnlineUsersActor', async () => {
    const system = await startNode('dd-snapshot-online', 49_141);
    const onlineUsers = system.spawn(OnlineUsersActor, 'online-users');
    const first = new TestProbe(system);
    onlineUsers.tell({ kind: 'Subscribe', room: 'general', ref: first });
    expect(await first.receiveOne()).toEqual({ kind: 'UsersChanged', room: 'general', users: [] });

    onlineUsers.tell({ kind: 'AddToRoom', room: 'general', username: 'alice' });
    expect(await first.receiveOne()).toEqual({ kind: 'UsersChanged', room: 'general', users: ['alice'] });

    const second = new TestProbe(system);
    onlineUsers.tell({ kind: 'Subscribe', room: 'general', ref: second });
    expect(await second.receiveOne()).toEqual({ kind: 'UsersChanged', room: 'general', users: ['alice'] });
  });

  test('ReadReceiptsActor', async () => {
    const system = await startNode('dd-snapshot-receipts', 49_151);
    const readReceipts = system.spawn(ReadReceiptsActor, 'read-receipts');
    const first = new TestProbe(system);
    readReceipts.tell({ kind: 'Subscribe', room: 'general', ref: first });
    expect(await first.receiveOne()).toEqual({ kind: 'ReceiptsChanged', room: 'general', receipts: {} });

    readReceipts.tell({ kind: 'Update', room: 'general', username: 'alice', ts: 42 });
    expect(await first.receiveOne()).toEqual({ kind: 'ReceiptsChanged', room: 'general', receipts: { alice: 42 } });

    const second = new TestProbe(system);
    readReceipts.tell({ kind: 'Subscribe', room: 'general', ref: second });
    expect(await second.receiveOne()).toEqual({ kind: 'ReceiptsChanged', room: 'general', receipts: { alice: 42 } });
  });

  test('VoicePresenceActor', async () => {
    const system = await startNode('dd-snapshot-presence', 49_161);
    const voicePresence = system.spawn(VoicePresenceActor, 'voice-presence');
    const key = roomUsersKey('lobby');
    const first = new TestProbe(system);
    voicePresence.tell({ kind: 'Subscribe', key, ref: first });
    expect(await first.receiveOne()).toEqual({ kind: 'PresenceChanged', key, users: [] });

    voicePresence.tell({ kind: 'Add', key, username: 'alice' });
    expect(await first.receiveOne()).toEqual({ kind: 'PresenceChanged', key, users: ['alice'] });

    const second = new TestProbe(system);
    voicePresence.tell({ kind: 'Subscribe', key, ref: second });
    expect(await second.receiveOne()).toEqual({ kind: 'PresenceChanged', key, users: ['alice'] });
  });
});
