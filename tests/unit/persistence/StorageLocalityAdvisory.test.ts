import { describe, expect, test } from 'bun:test';

import {
  StorageLocalityAdvisory,
  type ClusterStorageSource,
  type ClusterStorageView,
} from '../../../src/persistence/StorageLocalityAdvisory.js';
import { RecordingLogger, type RecordedLog } from '../../util/RecordingLogger.js';

/**
 * Unit half of the #1356 guard, against a structural cluster fake.  What is
 * pinned here is the *timing* contract more than the message: `Cluster.join`
 * registers the instance BEFORE `_start` populates the seed list, and a
 * `PersistentActor` may recover before any join at all — so the advisory must
 * evaluate `expectsRemotePeers()` lazily per event, never snapshot it at
 * registration, and must stay correct when peers arrive minutes after the
 * store was first used.
 */

/**
 * Mirrors the two behaviours of the real `Cluster.subscribe` the advisory
 * leans on: an immediate replay at subscribe time, and ordinary events after.
 */
class FakeClusterView implements ClusterStorageView {
  peers = false;
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  private listeners: Array<(event: unknown) => void> = [];

  expectsRemotePeers(): boolean { return this.peers; }

  subscribe(listener: (event: unknown) => void): () => void {
    this.subscribeCalls += 1;
    this.listeners.push(listener);
    listener({ kind: 'replay' });
    return () => {
      this.unsubscribeCalls += 1;
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  emitMembershipEvent(): void {
    for (const listener of [...this.listeners]) listener({ kind: 'member-event' });
  }
}

class FakeClusterSource implements ClusterStorageSource {
  cluster: FakeClusterView | null = null;
  private readonly listeners: Array<(cluster: ClusterStorageView) => void> = [];

  current(): ClusterStorageView | null { return this.cluster; }

  onRegister(listener: (cluster: ClusterStorageView) => void): void {
    this.listeners.push(listener);
  }

  register(cluster: FakeClusterView): void {
    this.cluster = cluster;
    for (const listener of [...this.listeners]) listener(cluster);
  }
}

class NodeLocalJournal { readonly storageLocality = 'node-local' as const; }
class NodeLocalSnapshotStore { readonly storageLocality = 'node-local' as const; }
class SharedJournal { readonly storageLocality = 'shared' as const; }
class UndeclaredJournal {}

function harness(): { source: FakeClusterSource; log: RecordingLogger; advisory: StorageLocalityAdvisory } {
  const source = new FakeClusterSource();
  const log = new RecordingLogger();
  return { source, log, advisory: new StorageLocalityAdvisory(source, log) };
}

function nodeLocalWarnings(log: RecordingLogger): RecordedLog[] {
  return log.records.filter((record) => record.message.includes('node-local storage'));
}

describe('a node-local store meeting a cluster with remote peers', () => {
  test('warns once per store kind, naming the store and the issue', () => {
    const { source, log, advisory } = harness();
    const cluster = new FakeClusterView();
    cluster.peers = true;
    source.register(cluster);

    advisory.noteStoreUse('journal', new NodeLocalJournal());
    advisory.noteStoreUse('journal', new NodeLocalJournal());
    advisory.noteStoreUse('snapshot-store', new NodeLocalSnapshotStore());

    const warnings = nodeLocalWarnings(log);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]!.level).toBe('warn');
    expect(warnings[0]!.message).toContain("journal 'NodeLocalJournal'");
    expect(warnings[0]!.message).toContain('#1356');
    expect(warnings[1]!.message).toContain("snapshot-store 'NodeLocalSnapshotStore'");
  });

  test('the error level is for the kinds whose breakage is proven, not suspected', () => {
    const { source, log, advisory } = harness();
    const cluster = new FakeClusterView();
    cluster.peers = true;
    source.register(cluster);

    advisory.noteStoreUse('remember-entities', new NodeLocalJournal(), 'error');

    const warnings = nodeLocalWarnings(log);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.level).toBe('error');
    expect(warnings[0]!.message).toContain('forgets every remembered entity');
  });
});

describe('the quiet cases stay quiet', () => {
  test('a shared store and an undeclared store never warn', () => {
    const { source, log, advisory } = harness();
    const cluster = new FakeClusterView();
    cluster.peers = true;
    source.register(cluster);

    advisory.noteStoreUse('journal', new SharedJournal());
    advisory.noteStoreUse('snapshot-store', new UndeclaredJournal());

    expect(nodeLocalWarnings(log)).toEqual([]);
  });

  test('a system that never joins a cluster never warns', () => {
    const { log, advisory } = harness();

    advisory.noteStoreUse('journal', new NodeLocalJournal());

    expect(nodeLocalWarnings(log)).toEqual([]);
  });

  test('a standalone single node never warns, and never re-checks after release', () => {
    const { source, log, advisory } = harness();
    const cluster = new FakeClusterView();
    source.register(cluster);

    advisory.noteStoreUse('journal', new NodeLocalJournal());
    cluster.emitMembershipEvent();

    expect(nodeLocalWarnings(log)).toEqual([]);
  });
});

describe('peers arriving late', () => {
  test('a note parked before any peers reports on the membership event that brings them', () => {
    const { source, log, advisory } = harness();
    const cluster = new FakeClusterView();
    source.register(cluster);

    advisory.noteStoreUse('journal', new NodeLocalJournal());
    expect(nodeLocalWarnings(log)).toEqual([]);

    cluster.peers = true;
    cluster.emitMembershipEvent();

    expect(nodeLocalWarnings(log)).toHaveLength(1);
    // The subscription exists to catch this one transition; holding it longer
    // would re-evaluate forever for nothing.
    expect(cluster.unsubscribeCalls).toBe(1);
    cluster.emitMembershipEvent();
    expect(nodeLocalWarnings(log)).toHaveLength(1);
  });

  test('registration must not snapshot: seeds read after _register still warn', () => {
    // The real ordering — `_register` runs before `_start` fills the seed
    // list, so at registration `expectsRemotePeers()` is still false.  The
    // immediate subscribe replay evaluates once (false), and the first
    // genuine membership event re-evaluates against the by-then-true answer.
    const { source, log, advisory } = harness();
    advisory.noteStoreUse('journal', new NodeLocalJournal());

    const cluster = new FakeClusterView();
    source.register(cluster);
    expect(nodeLocalWarnings(log)).toEqual([]);

    cluster.peers = true;
    cluster.emitMembershipEvent();
    expect(nodeLocalWarnings(log)).toHaveLength(1);
  });

  test('leave and rejoin re-arms on the new cluster instance', () => {
    const { source, log, advisory } = harness();
    const first = new FakeClusterView();
    source.register(first);
    advisory.noteStoreUse('journal', new NodeLocalJournal());

    const second = new FakeClusterView();
    source.register(second);
    second.peers = true;
    second.emitMembershipEvent();

    expect(nodeLocalWarnings(log)).toHaveLength(1);
    // The first instance may be dead; events from it must not double-report.
    first.peers = true;
    first.emitMembershipEvent();
    expect(nodeLocalWarnings(log)).toHaveLength(1);
  });

  test('a store noted after the release is judged against the current membership', () => {
    const { source, log, advisory } = harness();
    const cluster = new FakeClusterView();
    source.register(cluster);
    advisory.noteStoreUse('journal', new NodeLocalJournal());
    cluster.peers = true;
    cluster.emitMembershipEvent();
    expect(nodeLocalWarnings(log)).toHaveLength(1);

    advisory.noteStoreUse('durable-state-store', new NodeLocalSnapshotStore());

    expect(nodeLocalWarnings(log)).toHaveLength(2);
  });
});
