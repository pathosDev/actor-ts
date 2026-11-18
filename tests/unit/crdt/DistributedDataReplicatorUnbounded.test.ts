/**
 * The replicator's mailbox cannot be bounded, so it cannot strand a promise
 * (#1078).
 *
 * #1078's remaining proposal was to reject the promise a dropped
 * `ddata-update` or `ddata-get` envelope carries, for an operator who bounds
 * the replicator's mailbox.  No operator can: since #868 a framework actor
 * under `/system` takes neither the global `mailbox.default` bound nor a
 * `deployment` entry — only an actor the application wrote does — and the
 * extension spawns its replicator with no mailbox options.  So the envelope
 * that would carry a stranded `resolve`/`reject` is never dropped.
 *
 * This pins that, from both config layers at once, with a user actor beside
 * it as the control that proves the configuration was in force.  If the
 * replicator ever becomes boundable, this fails, and the rejection of
 * dropped envelopes has to be built in the same change.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { parsePathSegments } from '../../../src/ActorPath.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { DistributedDataId, GCounter } from '../../../src/crdt/index.js';
import { LocalActorRef } from '../../../src/internal/LocalActorRef.js';
import { reportsDrops } from '../../../src/internal/Mailbox.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

class IdleActor extends Actor<string> {
  override onReceive(): void {}
}

/** Both bounding layers, each tight enough that a burst would overflow it. */
const BOUNDING_CONFIG = `
  actor-ts.mailbox.default { capacity = 10, overflow = "drop-head" }
  actor-ts.deployment {
    "/system/**" { mailbox-capacity = 10, mailbox-overflow = "drop-head" }
  }
`;

function mailboxReportsDrops(system: ActorSystem, path: string): boolean {
  const ref = system._resolvePath(parsePathSegments(`actor-ts://${system.name}${path}`)).toNullable();
  if (!(ref instanceof LocalActorRef)) throw new Error(`no local actor at ${path}`);
  return reportsDrops(ref.getCell()._mailboxForTest());
}

describe('DistributedData replicator mailbox (#1078)', () => {
  test('neither the global bound nor a deployment entry bounds it', async () => {
    const name = 'ddata-unbounded';
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig(Config.parseString(BOUNDING_CONFIG));
    const system = ActorSystem.create(name, systemOptions);
    systems.push(system);
    const cluster = await Cluster.join(system, ClusterOptions.create()
      .withHost('h')
      .withPort(47_901)
      .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', 47_901))));
    clusters.push(cluster);
    const handle = system.extension(DistributedDataId).start(cluster);
    system.spawn(IdleActor, 'control');

    // The control: the same configuration does bound an application actor.
    expect(mailboxReportsDrops(system, '/user/control')).toBe(true);
    expect(mailboxReportsDrops(system, '/system/cluster/crdt/data')).toBe(false);

    // And behaviourally: a burst far past either bound leaves nothing unsettled.
    let settled = 0;
    const burst = 2_000;
    for (let i = 0; i < burst; i++) {
      void handle.updateAsync(`k-${i}`, GCounter.empty, (counter) => counter.increment('a', 1))
        .finally(() => { settled++; });
    }
    await awaitCondition(() => settled === burst, {
      timeoutMs: 10_000,
      label: `every update in the burst settled (${settled} of ${burst})`,
    });
  }, 20_000);
});
