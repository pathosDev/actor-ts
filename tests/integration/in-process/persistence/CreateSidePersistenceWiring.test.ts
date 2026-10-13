import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions, ActorSystemOptionsBuilder } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  InMemoryDurableStateStore,
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
} from '../../../../src/persistence/index.js';

/**
 * Persistence wired where the system is created (#1473): what
 * `ActorSystemOptions.withPersistence` takes, and what the extension answers
 * with on the line after `create`.
 */

function quietOptions(): ActorSystemOptionsBuilder {
  return ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
}

describe('the instance slots of withPersistence', () => {
  test('a durable-state store passed in is the one the extension answers with', async () => {
    const durableStateStore = new InMemoryDurableStateStore();
    const systemOptions = quietOptions().withPersistence({ durableStateStore });
    const system = ActorSystem.create('create-side-durable-state', systemOptions);
    try {
      expect(system.extension(PersistenceExtensionId).durableStateStore).toBe(durableStateStore);
    } finally {
      await system.terminate();
    }
  });

  test('the three slots are independent: one set leaves the other two at the in-memory default', async () => {
    const durableStateStore = new InMemoryDurableStateStore();
    const systemOptions = quietOptions().withPersistence({ durableStateStore });
    const system = ActorSystem.create('create-side-independent-slots', systemOptions);
    try {
      const persistence = system.extension(PersistenceExtensionId);
      expect(persistence.durableStateStore).toBe(durableStateStore);
      expect(persistence.journal).toBeInstanceOf(InMemoryJournal);
      expect(persistence.snapshotStore).toBeInstanceOf(InMemorySnapshotStore);
    } finally {
      await system.terminate();
    }
  });

  test('all three set at once each land on their own axis', async () => {
    const journal = new InMemoryJournal();
    const snapshotStore = new InMemorySnapshotStore();
    const durableStateStore = new InMemoryDurableStateStore();
    const systemOptions = quietOptions().withPersistence({ journal, snapshotStore, durableStateStore });
    const system = ActorSystem.create('create-side-all-slots', systemOptions);
    try {
      const persistence = system.extension(PersistenceExtensionId);
      expect(persistence.journal).toBe(journal);
      expect(persistence.snapshotStore).toBe(snapshotStore);
      expect(persistence.durableStateStore).toBe(durableStateStore);
    } finally {
      await system.terminate();
    }
  });
});
