import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions, ActorSystemOptionsBuilder } from '../../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../../src/config/HoconParser.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  InMemoryDurableStateStore,
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
} from '../../../../src/persistence/index.js';

/**
 * A store set in code is the explicit layer over whatever plug-in the config
 * selects, so registering that plug-in afterwards must not replace it (#1473).
 *
 * Registering a factory under the selected id used to drop whatever store the
 * axis held — one an earlier factory built and one set in code alike — so the
 * next read built the plug-in's store instead.  A journal passed to
 * `withPersistence({ journal })` was thrown away by the `register*Plugins` call
 * that followed `create` whenever the same backend was selected for that axis,
 * without a word; and a registration that arrives late — after an `await` —
 * would swap the journal under actors already writing to the old one.
 *
 * The re-lookup itself stays, for what it is for: a store the replaced factory
 * built is rebuilt from the new one.  The last two cases pin that half, so the
 * cheap fix — never drop anything on registration — goes red here too.
 */

const JOURNAL_ID = 'test.journal.selected';
const SNAPSHOT_STORE_ID = 'test.snapshot-store.selected';
const DURABLE_STATE_ID = 'test.durable-state.selected';

function selectingAllThree(): ActorSystemOptionsBuilder {
  const config: ConfigObject = {
    'actor-ts': {
      persistence: {
        journal: { plugin: JOURNAL_ID },
        'snapshot-store': { plugin: SNAPSHOT_STORE_ID },
        'durable-state': { plugin: DURABLE_STATE_ID },
      },
    },
  };
  return ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(config);
}

describe('a store set in code survives a later registration of the selected plug-in', () => {
  test('setJournal, setSnapshotStore and setDurableStateStore each keep their store', async () => {
    const system = ActorSystem.create('explicit-store-setters', selectingAllThree());
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const journal = new InMemoryJournal();
      const snapshotStore = new InMemorySnapshotStore();
      const durableStateStore = new InMemoryDurableStateStore();
      persistence.setJournal(journal);
      persistence.setSnapshotStore(snapshotStore);
      persistence.setDurableStateStore(durableStateStore);

      persistence.registerJournal(JOURNAL_ID, () => new InMemoryJournal());
      persistence.registerSnapshotStore(SNAPSHOT_STORE_ID, () => new InMemorySnapshotStore());
      persistence.registerDurableStateStore(DURABLE_STATE_ID, () => new InMemoryDurableStateStore());

      expect(persistence.journal).toBe(journal);
      expect(persistence.snapshotStore).toBe(snapshotStore);
      expect(persistence.durableStateStore).toBe(durableStateStore);
    } finally {
      await system.terminate();
    }
  });

  test('configure() keeps its stores the same way', async () => {
    const system = ActorSystem.create('explicit-store-configure', selectingAllThree());
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const journal = new InMemoryJournal();
      const snapshotStore = new InMemorySnapshotStore();
      const durableStateStore = new InMemoryDurableStateStore();
      persistence.configure({ journal, snapshotStore, durableStateStore });

      persistence.registerJournal(JOURNAL_ID, () => new InMemoryJournal());
      persistence.registerSnapshotStore(SNAPSHOT_STORE_ID, () => new InMemorySnapshotStore());
      persistence.registerDurableStateStore(DURABLE_STATE_ID, () => new InMemoryDurableStateStore());

      expect(persistence.journal).toBe(journal);
      expect(persistence.snapshotStore).toBe(snapshotStore);
      expect(persistence.durableStateStore).toBe(durableStateStore);
    } finally {
      await system.terminate();
    }
  });

  test('a store passed to withPersistence survives a registration after create', async () => {
    // The shape the defect had in an application: the instance in the options,
    // the backend registered on the line after `create`, selected for both axes.
    const journal = new InMemoryJournal();
    const snapshotStore = new InMemorySnapshotStore();
    const systemOptions = selectingAllThree().withPersistence({ journal, snapshotStore });
    const system = ActorSystem.create('explicit-store-options', systemOptions);
    try {
      const persistence = system.extension(PersistenceExtensionId);
      persistence.registerJournal(JOURNAL_ID, () => new InMemoryJournal());
      persistence.registerSnapshotStore(SNAPSHOT_STORE_ID, () => new InMemorySnapshotStore());

      expect(persistence.journal).toBe(journal);
      expect(persistence.snapshotStore).toBe(snapshotStore);
    } finally {
      await system.terminate();
    }
  });
});

describe('a store a factory built is still rebuilt from the factory that replaces it', () => {
  test('on every axis', async () => {
    const system = ActorSystem.create('factory-store-relookup', selectingAllThree());
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const firstJournal = new InMemoryJournal();
      const firstSnapshotStore = new InMemorySnapshotStore();
      const firstDurableStateStore = new InMemoryDurableStateStore();
      persistence.registerJournal(JOURNAL_ID, () => firstJournal);
      persistence.registerSnapshotStore(SNAPSHOT_STORE_ID, () => firstSnapshotStore);
      persistence.registerDurableStateStore(DURABLE_STATE_ID, () => firstDurableStateStore);
      expect(persistence.journal).toBe(firstJournal);
      expect(persistence.snapshotStore).toBe(firstSnapshotStore);
      expect(persistence.durableStateStore).toBe(firstDurableStateStore);

      const secondJournal = new InMemoryJournal();
      const secondSnapshotStore = new InMemorySnapshotStore();
      const secondDurableStateStore = new InMemoryDurableStateStore();
      persistence.registerJournal(JOURNAL_ID, () => secondJournal);
      persistence.registerSnapshotStore(SNAPSHOT_STORE_ID, () => secondSnapshotStore);
      persistence.registerDurableStateStore(DURABLE_STATE_ID, () => secondDurableStateStore);

      expect(persistence.journal).toBe(secondJournal);
      expect(persistence.snapshotStore).toBe(secondSnapshotStore);
      expect(persistence.durableStateStore).toBe(secondDurableStateStore);
    } finally {
      await system.terminate();
    }
  });

  test('a registration under an id the store did not come from leaves it alone', async () => {
    const system = ActorSystem.create('factory-store-other-id', selectingAllThree());
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const journal = new InMemoryJournal();
      persistence.registerJournal(JOURNAL_ID, () => journal);
      expect(persistence.journal).toBe(journal);

      persistence.registerJournal('test.journal.unselected', () => new InMemoryJournal());

      expect(persistence.journal).toBe(journal);
    } finally {
      await system.terminate();
    }
  });
});
