import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
} from '../../../../src/persistence/index.js';

function systemWith(config?: Record<string, unknown>): ActorSystem {
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
