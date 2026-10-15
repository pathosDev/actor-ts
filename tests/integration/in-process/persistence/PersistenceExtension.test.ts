import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceBehaviorOptions,
  PersistenceExtensionId,
} from '../../../../src/persistence/index.js';
import type { ConfigObject } from '../../../../src/index.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';

function systemWith(config?: ConfigObject): ActorSystem {
  let options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (config) options = options.withConfig(config);
  return ActorSystem.create('persistence-ext', options);
}

describe('PersistenceExtension — plugin resolution', () => {
  test('defaults to the in-memory reference plug-ins when no plugin is configured', () => {
    const system = systemWith();
    const ext = system.extension(PersistenceExtensionId);
    expect(ext.journal).toBeInstanceOf(InMemoryJournal);
    expect(ext.snapshotStore).toBeInstanceOf(InMemorySnapshotStore);
  });

  test('throws (does not silently fall back to in-memory) when the configured journal plugin is not registered', () => {
    const system = systemWith({
      'actor-ts': {
        persistence: { journal: { plugin: 'actor-ts.persistence.journal.postgres' } },
      },
    });
    const ext = system.extension(PersistenceExtensionId);
    expect(() => ext.journal).toThrow(/Unknown journal plugin.*postgres/s);
  });

  test('throws when the configured snapshot-store plugin is not registered', () => {
    const system = systemWith({
      'actor-ts': {
        persistence: { 'snapshot-store': { plugin: 'actor-ts.persistence.snapshot-store.mariadb' } },
      },
    });
    const ext = system.extension(PersistenceExtensionId);
    expect(() => ext.snapshotStore).toThrow(/Unknown snapshot-store plugin.*mariadb/s);
  });

  test('configure() sets the active journal and snapshot store in one call', () => {
    const system = systemWith();
    const ext = system.extension(PersistenceExtensionId);
    const journal = new InMemoryJournal();
    const snapshotStore = new InMemorySnapshotStore();
    ext.configure({ journal, snapshotStore });
    expect(ext.journal).toBe(journal);
    expect(ext.snapshotStore).toBe(snapshotStore);
  });

  test('configure() leaves an omitted store untouched', () => {
    const system = systemWith();
    const ext = system.extension(PersistenceExtensionId);
    const journal = new InMemoryJournal();
    ext.configure({ journal });
    expect(ext.journal).toBe(journal);
    // snapshotStore was not passed — still the in-memory default.
    expect(ext.snapshotStore).toBeInstanceOf(InMemorySnapshotStore);
  });

  test('a registered factory resolves normally after a hardened lookup', () => {
    const system = systemWith({
      'actor-ts': {
        persistence: { journal: { plugin: 'test.journal.custom' } },
      },
    });
    const ext = system.extension(PersistenceExtensionId);
    const custom = new InMemoryJournal();
    ext.registerJournal('test.journal.custom', () => custom);
    expect(ext.journal).toBe(custom);
  });
});

describe('PersistenceExtension — behaviour set in code', () => {
  /** A system whose persistence behaviour comes from `withPersistence({ behavior })` over `config`. */
  function systemWithBehavior(behavior: PersistenceBehaviorOptions, config: ConfigObject = {}): ActorSystem {
    const options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig(config)
      .withPersistence({ behavior });
    return ActorSystem.create('persistence-behaviour', options);
  }

  test('withPersistence({ behavior }) is the explicit layer over HOCON, field by field', async () => {
    const behavior = PersistenceBehaviorOptions.create().withRecoveryTimeoutMs(1_234);
    const system = systemWithBehavior(behavior, {
      'actor-ts': { persistence: { 'recovery-timeout': '2s', 'max-concurrent-recoveries': 7 } },
    });
    try {
      const settings = system.extension(PersistenceExtensionId).behavior;
      // Set in code: wins over the file.
      expect(settings.recoveryTimeoutMs).toBe(1_234);
      // Left unset in code: the file still decides.
      expect(settings.maxConcurrentRecoveries).toBe(7);
    } finally {
      await system.terminate();
    }
  });

  test('an explicit value is validated like a configured one', async () => {
    const system = systemWithBehavior({ maxConcurrentRecoveries: -1 });
    try {
      expect(() => system.extension(PersistenceExtensionId).behavior).toThrow(OptionsError);
    } finally {
      await system.terminate();
    }
  });
});
