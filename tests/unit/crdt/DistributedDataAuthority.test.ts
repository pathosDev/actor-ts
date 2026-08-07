/**
 * DistributedData credits the connection, not the payload (#719, #723, #768).
 *
 * `Cluster._onWire` has always handed its handlers the peer the connection
 * belongs to — the one field a sender cannot choose.  DistributedData
 * registered a one-parameter arrow and dropped it, then read `message.from`
 * out of the payload instead.  Three consequences, one per test below.
 *
 * The forging is done with a plain `InMemoryTransport` under an attacker
 * address: `send` stamps `from` with the *sending transport's* own address,
 * so a frame whose payload names someone else is exactly the shape a hostile
 * (or merely buggy) peer produces.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DistributedDataId, GCounter } from '../../../src/crdt/index.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];
const transports: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.shutdown().catch(() => {})));
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

async function startNode(name: string, port: number, seeds?: string[]): Promise<Cluster> {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(80);
  if (seeds !== undefined) clusterOptions.withSeeds(seeds);
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return cluster;
}

/** A bare transport that speaks the wire under its own identity. */
async function attacker(name: string, port: number): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport(new NodeAddress(name, 'h', port));
  transport.setHandler(() => {});
  await transport.start();
  transports.push(transport);
  return transport;
}

describe('DistributedData wire authority', () => {
  test('a write-request is answered down the connection it arrived on (#723)', async () => {
    // Keyed on the payload's `from`, this node could be made to dial an
    // address the attacker names and queue a full CRDT snapshot there — in a
    // `Connection.pending` buffer that is never drained and never reclaimed.
    const victim = await startNode('victim', 47_101);
    victim.system.extension(DistributedDataId).start(victim);
    await sleep(80);

    const evil = await attacker('evil', 47_102);
    const innocent = await attacker('innocent', 47_103);
    const receivedByInnocent: string[] = [];
    innocent.setHandler((_from, message) => { receivedByInnocent.push(message.kind); });
    const receivedByEvil: string[] = [];
    evil.setHandler((_from, message) => { receivedByEvil.push(message.kind); });

    evil.send(victim.selfAddress, {
      kind: 'ddata-write-request',
      // The lie: the payload names the innocent third party.
      from: new NodeAddress('innocent', 'h', 47_103).toJSON(),
      pendingId: 'p1',
      key: 'k',
      value: GCounter.empty().increment('a', 1).toJSON(),
    } as unknown as WireMessage);
    // The reply going to the sender is the positive half; the settle covers
    // the negative one, that it did not also go to the impersonated node.
    await awaitCondition(() => receivedByEvil.includes('ddata-write-ack'), {
      timeoutMs: 4_000,
      label: 'the write-ack came back to the sender',
    });
    await sleep(40);

    expect(receivedByEvil).toContain('ddata-write-ack');
    expect(receivedByInnocent).toEqual([]);
  });

  test('a read-request is answered down the connection it arrived on (#723)', async () => {
    const victim = await startNode('victim2', 47_111);
    victim.system.extension(DistributedDataId).start(victim);
    await sleep(80);

    const evil = await attacker('evil2', 47_112);
    const innocent = await attacker('innocent2', 47_113);
    const receivedByInnocent: string[] = [];
    innocent.setHandler((_from, message) => { receivedByInnocent.push(message.kind); });
    const receivedByEvil: string[] = [];
    evil.setHandler((_from, message) => { receivedByEvil.push(message.kind); });

    evil.send(victim.selfAddress, {
      kind: 'ddata-read-request',
      from: new NodeAddress('innocent2', 'h', 47_113).toJSON(),
      pendingId: 'p1',
      key: 'k',
    } as unknown as WireMessage);
    await awaitCondition(() => receivedByEvil.includes('ddata-read-response'), {
      timeoutMs: 4_000,
      label: 'the read-response came back to the sender',
    });
    await sleep(40);

    expect(receivedByEvil).toContain('ddata-read-response');
    expect(receivedByInnocent).toEqual([]);
  });

  test('a legitimate quorum still completes with the new checks in place', async () => {
    // Scope note, so this test is not read as more than it is: it does NOT
    // demonstrate the forged-quorum attack.  Doing that at unit level would
    // need the originator's `pendingId`, and since #896 that is drawn from
    // crypto randomness — unguessable, and the first of the three gates a
    // forged ack now has to pass (id, then key, then "were you asked?").
    //
    // What it does check is the half that a security fix most easily breaks:
    // that requiring the ack to come from an authenticated target does not
    // reject the real one.  The stray frames below are noise the node must
    // ignore without disturbing the genuine quorum.
    const a = await startNode('qa', 47_121);
    const b = await startNode('qb', 47_122, ['qa@h:47121']);
    await awaitCondition(() => a.upMembers().length >= 2, {
      timeoutMs: 4_000,
      intervalMs: 25,
      label: 'the two-node cluster converged',
    });
    expect(a.upMembers().length).toBeGreaterThanOrEqual(2);

    const handle = a.system.extension(DistributedDataId).start(a);
    b.system.extension(DistributedDataId).start(b);
    await sleep(120);

    const evil = await attacker('qevil', 47_123);
    evil.setHandler(() => {});

    // Start a quorum write that needs b's ack, then have the attacker try to
    // satisfy it — under b's name, and under its own.
    const pending = handle.updateAsync('k', GCounter.empty, (c) => c.increment('a', 1), {
      consistency: 'all',
      timeoutMs: 900,
    });

    await sleep(60);
    for (const claimed of ['qb@h:47122', 'qevil@h:47123']) {
      evil.send(a.selfAddress, {
        kind: 'ddata-write-ack',
        from: NodeAddress.parse(claimed).toJSON(),
        // Every pendingId the originator could plausibly have minted is
        // unguessable since #896, so the attacker cannot even correlate —
        // but the check must hold regardless of how the id was obtained.
        pendingId: 'guessed',
        key: 'k',
      } as unknown as WireMessage);
    }

    // The real quorum still completes on b's genuine ack; what must not
    // happen is the attacker's frames standing in for it.
    await expect(pending).resolves.toBeUndefined();
  });
});
