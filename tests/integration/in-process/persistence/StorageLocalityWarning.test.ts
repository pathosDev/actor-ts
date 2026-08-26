import { describe, expect, test } from 'bun:test';

import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions, type ClusterOptionsBuilder } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import {
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
} from '../../../../src/persistence/index.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';
import { RecordingLogger, type RecordedLog } from '../../../util/RecordingLogger.js';

/**
 * End-to-end half of the #1356 guard: a real `ActorSystem`, a real
 * `Cluster.join`, a real `PersistentActor` recovery — and the advisory
 * observed the way an operator would, through the log.
 *
 * The unit suite pins the advisory's timing contract against fakes; what
 * this file pins is that the seams are actually wired: `PersistentActor`
 * notes its stores, the default in-memory stores really declare
 * `'node-local'`, `expectsRemotePeers()` really reads seeds and members,
 * and the whole chain fires on the membership event when the second node
 * arrives late.
 */

type PingCommand = { readonly kind: 'ping' };
type Command = PingCommand;
type PingedEvent = { readonly kind: 'pinged' };
type State = { readonly pings: number };

/** Replies to every command, so a reply is proof `preStart` (and recovery) ran. */
class ProbePersistentActor extends PersistentActor<Command, PingedEvent, State> {
  constructor(readonly persistenceId: string, private readonly replyTo: () => void) {
    super();
  }

  initialState(): State { return { pings: 0 }; }
  onEvent(state: State, _event: PingedEvent): State { return { pings: state.pings + 1 }; }
  async onCommand(_state: State, _command: Command): Promise<void> { this.replyTo(); }
}

function loggingSystem(name: string): { system: ActorSystem; log: RecordingLogger } {
  const log = new RecordingLogger();
  const system = ActorSystem.create(name, ActorSystemOptions.create().withLogger(log));
  return { system, log };
}

function clusterOptions(systemName: string, port: number): ClusterOptionsBuilder {
  return ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
}

function nodeLocalWarnings(log: RecordingLogger): RecordedLog[] {
  return log.records.filter((record) => record.message.includes('node-local storage'));
}

function identityMismatchWarnings(log: RecordingLogger): RecordedLog[] {
  return log.records.filter((record) => record.message.includes('storage identity differs'));
}

/** Spawn a probe and wait for its first reply, so recovery demonstrably ran. */
async function runProbe(system: ActorSystem, persistenceId: string, actorName: string): Promise<void> {
  const replies: number[] = [];
  const probe = system.spawn(() => new ProbePersistentActor(persistenceId, () => replies.push(1)), actorName);
  probe.tell({ kind: 'ping' });
  await awaitCondition(() => replies.length >= 1, {
    timeoutMs: 4_000,
    label: `${actorName} recovered and replied`,
  });
}

describe('node-local stores meeting a cluster with remote peers', () => {
  test('a cluster with seeds warns once per store kind when a persistent actor recovers', async () => {
    const { system, log } = loggingSystem('sl-warn-seeded');
    // The seed is never brought up — configured remote-ness alone makes
    // per-node storage a hazard, exactly like the WeaklyUp bootstrap tests.
    const seededOptions = clusterOptions('sl-warn-seeded', 56_201)
      .withSeeds(['sl-warn-seeded@h:56202'])
      .withSeedRetryIntervalMs(100);
    const cluster = await Cluster.join(system, seededOptions);
    try {
      await runProbe(system, 'probe-1', 'probe1');
      await runProbe(system, 'probe-2', 'probe2');

      const warnings = nodeLocalWarnings(log);
      // Once per system per store kind — the second probe adds nothing.
      expect(warnings).toHaveLength(2);
      expect(warnings.map((record) => record.level)).toEqual(['warn', 'warn']);
      expect(warnings[0]!.message).toContain("journal 'InMemoryJournal'");
      expect(warnings[0]!.message).toContain('#1356');
      expect(warnings[1]!.message).toContain("snapshot-store 'InMemorySnapshotStore'");
    } finally {
      await cluster.leave();
      await system.terminate();
    }
  });

  test('a standalone single node stays silent — per-node storage is its documented default', async () => {
    const { system, log } = loggingSystem('sl-warn-solo');
    const cluster = await Cluster.join(system, clusterOptions('sl-warn-solo', 56_211));
    try {
      await runProbe(system, 'probe-solo', 'probeSolo');

      expect(nodeLocalWarnings(log)).toEqual([]);
    } finally {
      await cluster.leave();
      await system.terminate();
    }
  });

  test('an instance re-declared shared is trusted — the fixture escape hatch', async () => {
    const { system, log } = loggingSystem('sl-warn-shared');
    const journal = new InMemoryJournal();
    journal.storageLocality = 'shared';
    const snapshotStore = new InMemorySnapshotStore();
    snapshotStore.storageLocality = 'shared';
    const extension = system.extension(PersistenceExtensionId);
    extension.setJournal(journal);
    extension.setSnapshotStore(snapshotStore);
    const sharedOptions = clusterOptions('sl-warn-shared', 56_221)
      .withSeeds(['sl-warn-shared@h:56222'])
      .withSeedRetryIntervalMs(100);
    const cluster = await Cluster.join(system, sharedOptions);
    try {
      await runProbe(system, 'probe-shared', 'probeShared');

      expect(nodeLocalWarnings(log)).toEqual([]);
    } finally {
      await cluster.leave();
      await system.terminate();
    }
  });

  test('a peer arriving after recovery still triggers the warning', async () => {
    // The ordering the advisory exists for: the persistent actor recovers on
    // a standalone node (silent, correctly), and only later does a second
    // node join — the membership event has to resurface the parked note.
    const { system: systemA, log: logA } = loggingSystem('sl-warn-late');
    const nodeA = await Cluster.join(systemA, clusterOptions('sl-warn-late', 56_231));
    const { system: systemB } = loggingSystem('sl-warn-late');
    let nodeB: Cluster | null = null;
    try {
      await runProbe(systemA, 'probe-late', 'probeLate');
      expect(nodeLocalWarnings(logA)).toEqual([]);

      nodeB = await Cluster.join(
        systemB,
        clusterOptions('sl-warn-late', 56_232).withSeeds(['sl-warn-late@h:56231']),
      );

      await awaitCondition(() => nodeLocalWarnings(logA).length === 2, {
        timeoutMs: 4_000,
        label: 'node A warned about journal + snapshot store once the peer joined',
      });
      expect(nodeLocalWarnings(logA).map((record) => record.level)).toEqual(['warn', 'warn']);
    } finally {
      if (nodeB !== null) await nodeB.leave();
      await nodeA.leave();
      await systemB.terminate();
      await systemA.terminate();
    }
  });
});

describe('two databases behind shared-capable stores', () => {
  test('the identity mismatch is said out loud where the locality guard is rightly silent', async () => {
    // The scenario #1358 was opened for: both journals declare 'shared' —
    // truthfully, the backend COULD be shared — but each node holds its own
    // instance.  No locality warning may fire; the gossiped identity is the
    // only signal left.  The snapshot store is ONE instance across both
    // systems so the single expected mismatch is the journal's,
    // deterministically.
    const sharedSnapshotStore = new InMemorySnapshotStore();
    sharedSnapshotStore.storageLocality = 'shared';

    const { system: systemA, log: logA } = loggingSystem('sl-ident-two');
    const journalA = new InMemoryJournal();
    journalA.storageLocality = 'shared';
    systemA.extension(PersistenceExtensionId).setJournal(journalA);
    systemA.extension(PersistenceExtensionId).setSnapshotStore(sharedSnapshotStore);
    const nodeA = await Cluster.join(systemA, clusterOptions('sl-ident-two', 56_251));

    const { system: systemB, log: logB } = loggingSystem('sl-ident-two');
    const journalB = new InMemoryJournal();
    journalB.storageLocality = 'shared';
    systemB.extension(PersistenceExtensionId).setJournal(journalB);
    systemB.extension(PersistenceExtensionId).setSnapshotStore(sharedSnapshotStore);
    let nodeB: Cluster | null = null;
    try {
      await runProbe(systemA, 'ident-probe-a', 'identProbeA');
      nodeB = await Cluster.join(
        systemB,
        clusterOptions('sl-ident-two', 56_252).withSeeds(['sl-ident-two@h:56251']),
      );
      await runProbe(systemB, 'ident-probe-b', 'identProbeB');

      await awaitCondition(
        () => identityMismatchWarnings(logA).length + identityMismatchWarnings(logB).length >= 1,
        { timeoutMs: 4_000, label: 'one side reported the journal identity mismatch' },
      );
      const warnings = [...identityMismatchWarnings(logA), ...identityMismatchWarnings(logB)];
      for (const warning of warnings) {
        expect(warning.level).toBe('warn');
        expect(warning.message).toContain('journal storage identity differs');
        expect(warning.message).toContain('#1358');
      }
      // The locality half stayed silent — 'shared' was a true statement
      // about the backend, just not about the instance.
      expect(nodeLocalWarnings(logA)).toEqual([]);
      expect(nodeLocalWarnings(logB)).toEqual([]);
    } finally {
      if (nodeB !== null) await nodeB.leave();
      await nodeA.leave();
      await systemB.terminate();
      await systemA.terminate();
    }
  });

  test('one shared instance is one identity — no mismatch', async () => {
    const sharedJournal = new InMemoryJournal();
    sharedJournal.storageLocality = 'shared';
    const sharedSnapshotStore = new InMemorySnapshotStore();
    sharedSnapshotStore.storageLocality = 'shared';

    const { system: systemA, log: logA } = loggingSystem('sl-ident-one');
    systemA.extension(PersistenceExtensionId).setJournal(sharedJournal);
    systemA.extension(PersistenceExtensionId).setSnapshotStore(sharedSnapshotStore);
    const nodeA = await Cluster.join(systemA, clusterOptions('sl-ident-one', 56_261));

    const { system: systemB, log: logB } = loggingSystem('sl-ident-one');
    systemB.extension(PersistenceExtensionId).setJournal(sharedJournal);
    systemB.extension(PersistenceExtensionId).setSnapshotStore(sharedSnapshotStore);
    let nodeB: Cluster | null = null;
    try {
      await runProbe(systemA, 'same-probe-a', 'sameProbeA');
      nodeB = await Cluster.join(
        systemB,
        clusterOptions('sl-ident-one', 56_262).withSeeds(['sl-ident-one@h:56261']),
      );
      await runProbe(systemB, 'same-probe-b', 'sameProbeB');

      await awaitCondition(
        () => nodeA.upMembers().length === 2 && nodeB!.upMembers().length === 2,
        { timeoutMs: 4_000, label: 'both nodes see a 2-member cluster' },
      );
      // A couple of gossip rounds with identities on both member records.
      await sleep(200);

      expect(identityMismatchWarnings(logA)).toEqual([]);
      expect(identityMismatchWarnings(logB)).toEqual([]);
    } finally {
      if (nodeB !== null) await nodeB.leave();
      await nodeA.leave();
      await systemB.terminate();
      await systemA.terminate();
    }
  });
});
