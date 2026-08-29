/**
 * A peer cannot void a victim replica's future adds (#722).
 *
 * `ORSet` tags used to be `${replica}#${seq}` off a per-replica counter that
 * travelled in the payload — so anyone who could read a gossip frame knew both
 * halves and could compute tags the victim had not issued yet.  Tombstones veto
 * by tag on merge, are unioned unconditionally, and are never pruned, so one
 * frame of forged tombstones made the victim's next N adds disappear on the
 * very next merge: `has()` said true right after the write and false a
 * heartbeat later, with no error and no API to undo a tombstone.
 *
 * Tags are minted from crypto-grade entropy now, which is the one part of the
 * reported fix that works — the verifier established that filtering tombstones
 * by sending peer breaks remove propagation, and that dropping tombstones for
 * unobserved tags breaks the anti-resurrection property the class relies on.
 *
 * Same forging harness as `DistributedDataAuthority.test.ts`: a plain
 * `InMemoryTransport` under its own address, speaking the wire directly.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DistributedDataId, ORSet } from '../../../src/crdt/index.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

/**
 * Thin wrapper over the shared helper (#418) — this file predates it and had
 * its own deadline loop, which named neither the condition nor how long it
 * really waited.  The budget bounds only the broken case.
 */
const waitFor = (predicate: () => boolean, label: string): Promise<void> =>
  awaitCondition(predicate, { timeoutMs: 4_000, intervalMs: 20, label });

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];
const transports: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.shutdown().catch(() => {})));
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

async function startNode(name: string, port: number): Promise<Cluster> {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(60);
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return cluster;
}

async function attacker(name: string, port: number): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport(new NodeAddress(name, 'h', port));
  transport.setHandler(() => {});
  await transport.start();
  transports.push(transport);
  return transport;
}

/** Every tag the old scheme would have minted for `replica`'s first `count` adds. */
function guessedTags(replica: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${replica}#${index + 1}`);
}

const TAG_SUFFIX = /^[0-9a-f]{16,}$/;

describe('ORSet tag minting (#722)', () => {
  test('a tag is not derivable from the ones already issued', () => {
    const replica = 'sys@10.0.0.5:2552';
    const tags: string[] = [];
    let set = ORSet.empty<string>();
    for (let round = 0; round < 200; round++) {
      set = set.add(replica, `item-${round}`);
    }
    for (const [, tagList] of Object.entries(set.toJSON().elements)) {
      tags.push(...tagList);
    }

    expect(tags).toHaveLength(200);
    expect(new Set(tags).size).toBe(200);
    // The old shape, and the thing an attacker enumerated.
    expect(tags).not.toContain(`${replica}#1`);
    for (const tag of tags) {
      expect(tag.startsWith(`${replica}#`)).toBe(true);
      expect(tag.slice(replica.length + 1)).toMatch(TAG_SUFFIX);
    }
  });

  test('a pre-tombstoned guessable tag does not veto a later add', () => {
    const replica = 'sys@10.0.0.5:2552';
    // Exactly the hostile payload from the report: no elements, no counters,
    // just tombstones for tags the victim has not issued yet.
    const hostile = ORSet.fromJSON<string>({
      kind: 'ORSet',
      elements: {},
      elementValues: {},
      tombstones: { '"apple"': guessedTags(replica, 200) },
    });

    const victim = ORSet.empty<string>().merge(hostile).add(replica, 'apple');
    expect(victim.has('apple')).toBe(true);
    // The wipe used to happen here — the victim's own gossip round-trip, a
    // quorum read, or any peer push re-applying the same tombstones.
    expect(victim.merge(hostile).has('apple')).toBe(true);
    expect(victim.merge(ORSet.empty<string>()).has('apple')).toBe(true);
  });

  test('a tag survives serialization and merging byte-identical', () => {
    // Unguessable is only half the requirement: every comparison a tag takes
    // part in is string equality, so a tag that changed across a round trip
    // would break tombstone veto, tag-set union and `equals` at once.
    const set = ORSet.empty<string>().add('replica-a', 'apple').add('replica-b', 'apple');
    const tags = set.toJSON().elements['"apple"'];

    const roundTripped = ORSet.fromJSON<string>(JSON.parse(JSON.stringify(set.toJSON())));
    expect(roundTripped.toJSON().elements['"apple"']).toEqual(tags);
    expect(roundTripped.equals(set)).toBe(true);
    expect(set.merge(roundTripped).toJSON().elements['"apple"']).toEqual(tags);
    // Add-wins is unchanged: a remove only takes the tags it has observed.
    const reAdded = set.remove('apple').merge(set.add('replica-c', 'apple'));
    expect(reAdded.has('apple')).toBe(true);
  });
});

describe('DistributedData ORSet over the wire (#722)', () => {
  test("forged tombstones do not erase the victim's write", async () => {
    const victim = await startNode('orset-victim', 47_401);
    const data = victim.system.extension(DistributedDataId).start(victim);
    // A startup settle with no state to poll: `start()` registers the wire
    // handlers synchronously and buffers frames in the actor's mailbox until
    // `preStart` has run, so there is nothing observable to wait on.  The 4 s
    // `waitFor` below is what actually bounds the merge.
    await sleep(80);

    const evil = await attacker('orset-evil', 47_402);
    const replica = data.selfReplicaId();
    const hostileFrame = {
      kind: 'ddata-gossip',
      from: new NodeAddress('orset-evil', 'h', 47_402).toJSON(),
      entries: {
        'cart-42': {
          kind: 'ORSet',
          elements: {},
          elementValues: {},
          tombstones: { '"apple"': guessedTags(replica, 200) },
        },
      },
    } as unknown as WireMessage;

    evil.send(victim.selfAddress, hostileFrame);
    await waitFor(() => data.keys().includes('cart-42'), 'the hostile frame installed the key');

    // An honest local write, which used to report success and then vanish.
    data.update('cart-42', () => ORSet.empty<string>(), (set) => set.add(replica, 'apple'));
    await waitFor(
      () => data.get<ORSet<string>>('cart-42')?.has('apple') === true,
      'the honest write is visible in the victim\'s own view',
    );

    // The same tombstones again — one more merge is all it took.
    evil.send(victim.selfAddress, hostileFrame);
    // Nothing must change, so there is no state to poll for; the wait only has
    // to outlive the merge the frame would have triggered.
    await sleep(120);
    expect(data.get<ORSet<string>>('cart-42')?.value()).toEqual(['apple']);
  });
});
