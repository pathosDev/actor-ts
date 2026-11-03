/**
 * #856 — why `actor-ts.distributed-data.quorum-timeout` refuses `0`, as the
 * reference publishes it, held to what the replicator actually does.
 *
 * The refusal shipped with a reason that was false: "0 would arm no timer,
 * so a request waiting on a silent replica would never settle".  The
 * replicator arms a quorum deadline with `scheduleOnceFunction`, which hands
 * a `0` to `setTimeout` like any other value, so a `0` deadline expires on the
 * next timer tick — the opposite of never: a write fails there, and a read,
 * which resolves best-effort on its deadline rather than rejecting, settles
 * for what the local replica alone holds.  The refusal stands on the true
 * reason: `0` cannot mean "off", because it is a deadline that expires nearly
 * every request.  "Nearly" is measured, not modesty: against a replica in the
 * same process, whose acknowledgment can beat the timer, a `0` write was seen
 * to succeed in 1.5 ms, so no sentence here may say it can never be met.
 *
 * The harness is the two-node shape `DistributedDataQuorumCaps` uses: the
 * second node joins but never starts the extension, so it never answers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { DistributedDataId, GCounter } from '../../../src/crdt/index.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const DOCS_ROOT = join(REPOSITORY_ROOT, 'docs', 'src', 'content', 'docs');

/** Text with HOCON and JSDoc comment markers and line breaks folded away. */
function prose(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/^[ \t]*(?:#|\/\/|\*)[ \t]?/gm, '').replace(/\s+/g, ' ');
}

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

async function join2(name: string, port: number, seeds: string[]): Promise<Cluster> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(80)
    .withSeeds(seeds);
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return cluster;
}

/** A two-node cluster whose second node never runs DistributedData, so never acknowledges. */
async function withSilentReplica(prefix: string, port: number): Promise<Cluster> {
  const a = await join2(`${prefix}-a`, port, []);
  await join2(`${prefix}-b`, port + 1, [`${prefix}-a@h:${port}`]);
  await awaitCondition(() => a.upMembers().length >= 2, {
    timeoutMs: 4_000,
    intervalMs: 25,
    label: 'the two-node cluster converged',
  });
  return a;
}

/** How a promise settled, and how long it took. */
async function settlementOf(promise: Promise<unknown>): Promise<{ readonly rejection: unknown; readonly elapsedMs: number }> {
  const started = performance.now();
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }
  return { rejection, elapsedMs: performance.now() - started };
}

describe('a quorum deadline of 0 is armed like any other (#856)', () => {
  test('a write under it rejects at once against a silent replica, rather than never settling', async () => {
    const a = await withSilentReplica('quorum-zero-doc-write', 47_861);
    const handle = a.system.extension(DistributedDataId).start(a);

    const { rejection, elapsedMs } = await settlementOf(handle.updateAsync(
      'k', GCounter.empty, (counter) => counter.increment('a', 1), { consistency: 'all', timeoutMs: 0 },
    ));

    expect((rejection as Error | undefined)?.message).toContain('timed out after 0ms');
    // Far below the 5 s default it would wait out were the 0 read as unset.
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test('a read under it settles at once for what this replica alone holds', async () => {
    // A quorum read that times out resolves best-effort with what it has
    // merged rather than rejecting, so under a 0 deadline it is a local read
    // that no peer contributed to.
    const a = await withSilentReplica('quorum-zero-doc-read', 47_871);
    const handle = a.system.extension(DistributedDataId).start(a);
    await handle.updateAsync('k', GCounter.empty, (counter) => counter.increment('a', 2), { consistency: 'local' });

    const started = performance.now();
    const read = await handle.getAsync<GCounter>('k', { consistency: 'all', timeoutMs: 0 });

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(read?.value()).toBe(2);
  });
});

describe('the published reason for refusing quorum-timeout = 0 (#856)', () => {
  // The false mechanism, in each spelling it was published in.
  const RETIRED = ['would arm no timer', 'would arm no deadline', 'arms no timer', 'never settle', 'keinen Timer stellen', 'gar keine Frist stellen', 'nie zum Abschluss'];
  const page = (relative: string): string => readFileSync(join(DOCS_ROOT, relative), 'utf8');
  const source = (relative: string): string => readFileSync(join(REPOSITORY_ROOT, relative), 'utf8');

  // [where, its text, a phrase that opens the quorum-deadline passage, the reason it has to give]
  test.each([
    ['reference.conf', REFERENCE_CONF, 'Deadline for an updateAsync / getAsync whose call names no timeoutMs', 'so it expires at the next timer tick -- a write fails there and a read settles for what this replica alone holds -- unless every replica it waits on has already answered'],
    ['reference/configuration.mdx', page('reference/configuration.mdx'), '`quorum-timeout` is the deadline a quorum call gets', 'so it expires at the next timer tick — a write fails there and a read settles for what this replica alone holds — unless every replica it waits on has already answered'],
    ['de/reference/configuration.mdx', page('de/reference/configuration.mdx'), '`quorum-timeout` ist die Deadline, die ein Quorum-Aufruf bekommt', 'sie läuft also beim nächsten Timer-Tick ab — ein Write scheitert dort, und ein Read begnügt sich mit dem, was diese Replika allein hält —, sofern nicht jede Replika, auf die der Request wartet, schon geantwortet hat'],
    ['distributed-data/quorum-reads-writes.mdx', page('distributed-data/quorum-reads-writes.mdx'), 'It is independent of the gossip interval', '`0` is armed like any other deadline, so it would expire at the next timer tick: a write would fail there and a read settle for what this replica alone holds, unless every replica had already answered'],
    ['de/distributed-data/quorum-reads-writes.mdx', page('de/distributed-data/quorum-reads-writes.mdx'), 'Die Frist ist unabhängig vom Gossip-Intervall', 'sie liefe also beim nächsten Timer-Tick ab: Ein Write scheiterte dort, und ein Read begnügte sich mit dem, was diese Replika allein hält, sofern nicht jede Replika schon geantwortet hätte'],
    ['the quorumTimeout JSDoc', source('src/crdt/DistributedDataOptions.ts'), 'Deadline in ms for an `updateAsync` / `getAsync` whose call names no `timeoutMs`', 'it expires at the next timer tick — a write fails there and a read settles for what this replica alone holds — unless every replica it waits on has already answered'],
    ['the validator\'s comment', source('src/crdt/DistributedDataOptions.ts'), 'Positive, where the ceiling below is non-negative', 'it would expire nearly every quorum request at the next timer tick'],
  ])('%s gives the reason the replicator bears out', (_where, text, opening, reason) => {
    const passage = passageOf(prose(text), opening);
    expect(passage).toContain(reason);
    for (const retired of RETIRED) expect(passage).not.toContain(retired);
  });
});

/**
 * The passage that opens with `opening`, up to a fixed span past it.  The
 * retired phrases are looked for there only: `ask-timeout`'s own passage says
 * an ask that arms no deadline "can never settle", which is true of an ask —
 * its reply ref arms its timer under `timeoutMs > 0` — and about another key.
 */
function passageOf(text: string, opening: string): string {
  const start = text.indexOf(opening);
  expect(start, `the passage opening "${opening}"`).not.toBe(-1);
  return text.slice(start, start + 1_400);
}
