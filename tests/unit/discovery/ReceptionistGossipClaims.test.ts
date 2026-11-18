/**
 * #1073 — receptionist gossip allocated a key entry per name a peer sent.
 *
 * `handleGossip` created an entry for every service key in a frame and stored
 * the peer's path list whole, with no bound on either: one frame naming 50 000
 * keys left 50 000 entries, renewed for as long as the peer kept naming them.
 * #139 closed the same axis on the pub-sub mediator; the receptionist was left.
 *
 * Bounded now by a quota per sender — `maxRegistrationsClaimedPerSender`, the
 * same `SenderClaimQuota` the mediator uses (#1074) — rather than by one
 * shared total, which the first peer to fill it would deny to every other.  A
 * claim is charged by the actor paths it names, at least one per key, so the
 * quota bounds keys and path lists together.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Receptionist, ReceptionistOptions, ReceptionistOptionsValidator } from '../../../src/discovery/index.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
};

interface ReceptionistInternals {
  readonly keys: Map<string, { remote: Map<string, string[]> }>;
  handleGossip(
    message: { kind: 'receptionist-gossip'; from: unknown; entries: Record<string, unknown>; version: number },
    from: NodeAddress,
  ): void;
}

let nodes: Node[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

async function startReceptionist(
  systemName: string,
  port: number,
  quota?: number,
): Promise<ReceptionistInternals> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(60_000);
  const cluster = await Cluster.join(system, clusterOptions);
  nodes.push({ system, cluster });

  const receptionistOptions = ReceptionistOptions.create()
    .withCluster(cluster)
    .withGossipIntervalMs(60_000);
  if (quota !== undefined) receptionistOptions.withMaxRegistrationsClaimedPerSender(quota);
  let captured: Receptionist | null = null;
  const ref: ActorRef<unknown> = system.spawn(() => {
    captured = new Receptionist(receptionistOptions);
    return captured;
  }, 'receptionist-under-test') as ActorRef<unknown>;
  expect(ref).toBeDefined();
  await awaitCondition(() => captured !== null, { timeoutMs: 4_000, label: 'the receptionist was captured' });
  return captured! as unknown as ReceptionistInternals;
}

function gossip(
  receptionist: ReceptionistInternals,
  sender: NodeAddress,
  entries: Record<string, unknown>,
): void {
  receptionist.handleGossip({ kind: 'receptionist-gossip', from: sender.toJSON(), entries, version: 1 }, sender);
}

function claimsOf(receptionist: ReceptionistInternals, sender: NodeAddress): string[] {
  return Array.from(receptionist.keys.entries())
    .filter(([, entry]) => entry.remote.has(sender.toString()))
    .map(([id]) => id)
    .sort();
}

const path = (index: number): string => `akka-like://peer@h:1/user/service-${index}`;

describe('#1073 — receptionist gossip is held to a quota per sender', () => {
  test('a frame naming 50 000 keys leaves the quota\'s worth, not 50 000', async () => {
    const receptionist = await startReceptionist('recp-claims-flood', 52_101, 100);
    const sender = new NodeAddress('recp-claims-flood', 'h', 52_199);
    const entries: Record<string, string[]> = {};
    for (let index = 0; index < 50_000; index += 1) entries[`key-${index}`] = [path(index)];
    gossip(receptionist, sender, entries);
    expect(receptionist.keys.size).toBe(100);
  });

  test('a claim is charged by the paths it names, at least one per key', async () => {
    const receptionist = await startReceptionist('recp-claims-weight', 52_102, 10);
    const sender = new NodeAddress('recp-claims-weight', 'h', 52_199);
    gossip(receptionist, sender, {
      eight: Array.from({ length: 8 }, (_, index) => path(index)),
      // Does not fit after `eight`, and is refused whole rather than cut.
      five: Array.from({ length: 5 }, (_, index) => path(index)),
      // An empty list still opens a key, so it still costs one.
      empty: [],
      one: [path(0)],
      // Over: 8 + 1 + 1 = 10 is the quota.
      late: [path(1)],
    });
    expect(claimsOf(receptionist, sender)).toEqual(['eight', 'empty', 'one']);
    expect(receptionist.keys.get('eight')?.remote.get(sender.toString())).toHaveLength(8);
  });

  test('a claim whose paths are not a list is refused, not stored', async () => {
    const receptionist = await startReceptionist('recp-claims-shape', 52_103, 10);
    const sender = new NodeAddress('recp-claims-shape', 'h', 52_199);
    gossip(receptionist, sender, { broken: { length: 0 }, fine: [path(0)] });
    expect(claimsOf(receptionist, sender)).toEqual(['fine']);
  });

  test('senders do not share the quota', async () => {
    const receptionist = await startReceptionist('recp-claims-senders', 52_104, 3);
    const loud = new NodeAddress('recp-claims-senders', 'h', 52_198);
    const quiet = new NodeAddress('recp-claims-senders', 'h', 52_199);
    const loudEntries: Record<string, string[]> = {};
    for (let index = 0; index < 20; index += 1) loudEntries[`loud-${index}`] = [path(index)];
    gossip(receptionist, loud, loudEntries);
    gossip(receptionist, quiet, { 'quiet-a': [path(0)], 'quiet-b': [path(1)] });
    expect(claimsOf(receptionist, loud)).toHaveLength(3);
    expect(claimsOf(receptionist, quiet)).toEqual(['quiet-a', 'quiet-b']);
  });

  test('the quota must be an integer of at least one', () => {
    const validate = (quota: number): void =>
      new ReceptionistOptionsValidator().validate({ maxRegistrationsClaimedPerSender: quota });
    expect(() => validate(1)).not.toThrow();
    expect(() => validate(0)).toThrow(/maxRegistrationsClaimedPerSender/);
    expect(() => validate(2.5)).toThrow(/maxRegistrationsClaimedPerSender/);
  });
});
