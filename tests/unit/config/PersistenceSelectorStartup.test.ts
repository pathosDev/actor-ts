import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions, type ActorSystemOptionsBuilder } from '../../../src/ActorSystemOptions.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { CoordinatedStartupId } from '../../../src/CoordinatedStartup.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { InMemoryDurableStateStore } from '../../../src/persistence/durable-state-stores/InMemoryDurableStateStore.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { PersistenceBehaviorOptions } from '../../../src/persistence/PersistenceBehaviorOptions.js';
import { PersistenceExtensionId, type PersistencePlugin } from '../../../src/persistence/PersistenceExtension.js';
import { InMemorySnapshotStore } from '../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * #1425 — a persistence selection the configuration got wrong, met the way an
 * application meets it: `ActorSystem.create`, then `whenReady()`.
 *
 * A selection read from configuration is resolved inside `create` and its
 * stores opened in the `persistence-start` phase (#1473), so a mistake in the
 * file fails the startup, and takes the system down, rather than the first
 * message a persistent actor handles.  These cases pin which mistakes that
 * covers, and that each failure is the reader's own refusal naming the key to
 * correct: the lookup's `Unknown … plugin` error names the selector too, so a
 * case that asked only for the key would pass for a reader that read garbage
 * as an id.  Since #1729 that includes a key under `actor-ts.persistence`
 * that nothing reads, which until then left the axis in memory without a word.
 */

/** A quiet system over `hocon`, laid over reference.conf as a deployment's own file is. */
function systemOver(name: string, hocon: string): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon));
  return ActorSystem.create(name, systemOptions);
}

/** As {@link systemOver}, with `plugin` wired through `withPersistence`. */
function systemWithPluginOver(name: string, hocon: string, plugin: PersistencePlugin): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon))
    .withPersistence({ plugins: [plugin] });
  return ActorSystem.create(name, systemOptions);
}

/** The error `promise` rejects with; fails the case when it resolves instead. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the promise to reject, and it resolved');
}

/** Stop `system` and wait until it is down — after a failed startup it is already on its way. */
async function stopped(system: ActorSystem): Promise<void> {
  await system.terminate();
  await system.whenTerminated();
}

/** `ActorSystem.create`, which must not throw: a refused key is the startup's to report. */
function createdWithout(name: string, systemOptions: ActorSystemOptionsBuilder): ActorSystem {
  let system: ActorSystem | undefined;
  expect(() => { system = ActorSystem.create(name, systemOptions); }).not.toThrow();
  return system!;
}

/**
 * That `system`'s startup failed on the refusal of `key` and took the system
 * down on its own — the failure path every route shares (#1729).
 */
async function expectStartupRefusing(system: ActorSystem, key: string): Promise<void> {
  const error = await rejectionOf(system.whenReady());
  expect(error.message).toContain('"persistence-warm-up"');
  expect(error.cause).toBeInstanceOf(ConfigError);
  expect((error.cause as Error).message).toStartWith(`Config at "${key}" is not a key `);
  await system.whenTerminated();
  expect(system.isTerminated).toBe(true);
}

/** A journal that counts its opens — what the warm-up calls when it opens the stores. */
class StartCountingJournal extends InMemoryJournal {
  starts = 0;

  async start(): Promise<void> {
    this.starts++;
  }
}

/** A store of each kind, set in code: with all three in place no axis reads the selection. */
function everyStoreInCode(): { journal: InMemoryJournal; snapshotStore: InMemorySnapshotStore; durableStateStore: InMemoryDurableStateStore } {
  return {
    journal: new InMemoryJournal(),
    snapshotStore: new InMemorySnapshotStore(),
    durableStateStore: new InMemoryDurableStateStore(),
  };
}

/** Quiet options over `hocon`, as {@link systemOver} builds them, for a case that adds persistence in code. */
function quietOptionsOver(hocon: string): ActorSystemOptionsBuilder {
  return ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon));
}

type NoIdSelectorCase = {
  readonly name: string;
  readonly hocon: string;
  readonly selector: string;
  readonly got: string;
};

/**
 * The three ways a selector can hold no id, each on a different axis — so the
 * two axes it is not on show the rule that a selector holding no id fails
 * every axis, not only its own: it is a mistake in the file whichever store
 * the application uses.
 */
const NO_ID_SELECTORS: NoIdSelectorCase[] = [
  {
    name: 'a null durable-state selector',
    hocon: 'actor-ts.persistence.durable-state.plugin = null',
    selector: 'actor-ts.persistence.durable-state.plugin',
    got: 'null',
  },
  {
    name: 'a snapshot-store selector holding a block',
    hocon: 'actor-ts.persistence.snapshot-store.plugin = { a = 1 }',
    selector: 'actor-ts.persistence.snapshot-store.plugin',
    got: 'object',
  },
  {
    name: 'a journal selector holding a list',
    hocon: 'actor-ts.persistence.journal.plugin = [a, b]',
    selector: 'actor-ts.persistence.journal.plugin',
    got: 'list',
  },
];

describe('a selector holding no id fails the startup and every axis (#1425)', () => {
  test.each(NO_ID_SELECTORS)('$name fails the startup with the refusal naming it', async ({ hocon, selector, got }) => {
    const system = systemOver('selector-holding-no-id', hocon);
    try {
      const error = await rejectionOf(system.whenReady());

      // The startup error keeps the warm-up's own as its `cause`.
      expect(error.message).toContain('"persistence-warm-up"');
      expect(error.cause).toBeInstanceOf(ConfigError);
      expect((error.cause as Error).message).toBe(`Config at "${selector}" is not a string (got ${got})`);
    } finally {
      await stopped(system);
    }
  });

  test.each(NO_ID_SELECTORS)('$name fails all three axes, its own and the other two', async ({ hocon, selector, got }) => {
    const system = systemOver('selector-holding-no-id-every-axis', hocon);
    const extension = system.extension(PersistenceExtensionId);
    try {
      const refusal = `Config at "${selector}" is not a string (got ${got})`;

      expect(() => extension.journal).toThrow(refusal);
      expect(() => extension.snapshotStore).toThrow(refusal);
      expect(() => extension.durableStateStore).toThrow(refusal);
      await rejectionOf(system.whenReady());
    } finally {
      await stopped(system);
    }
  });
});

type ValueWhereABlockBelongsCase = {
  readonly name: string;
  readonly hocon: string;
  readonly key: string;
  /** What the refusal says `key` must be: an axis block needs its plugin field, a block above it only to be one. */
  readonly mustBe: string;
};

/**
 * Values written where a block belongs.  `Config.load` lays reference.conf
 * underneath, so at runtime a selector is absent only when such a value has
 * replaced its block or a block above it — and absent, it read as "not set",
 * the in-memory store was selected with no error, and the startup reported
 * ready.  A deployment that wrote the plug-in id onto the block lost its
 * journal or its state on the next restart.
 */
const VALUES_WHERE_A_BLOCK_BELONGS: ValueWhereABlockBelongsCase[] = [
  {
    name: 'the durable-state block replaced by its plug-in id',
    hocon: 'actor-ts.persistence.durable-state = "actor-ts.persistence.durable-state.sqlite"',
    key: 'actor-ts.persistence.durable-state',
    mustBe: 'must be a block with a plugin field',
  },
  {
    name: 'the snapshot-store block replaced by its plug-in id',
    hocon: 'actor-ts.persistence.snapshot-store = "actor-ts.persistence.snapshot-store.sqlite"',
    key: 'actor-ts.persistence.snapshot-store',
    mustBe: 'must be a block with a plugin field',
  },
  {
    name: 'the journal block set to null',
    hocon: 'actor-ts.persistence.journal = null',
    key: 'actor-ts.persistence.journal',
    mustBe: 'must be a block with a plugin field',
  },
  {
    name: 'the persistence block replaced by a backend\'s name',
    hocon: 'actor-ts.persistence = "postgres"',
    key: 'actor-ts.persistence',
    mustBe: 'must be a block',
  },
];

describe('a value where a persistence block belongs fails the startup, naming the key (#1425)', () => {
  test.each(VALUES_WHERE_A_BLOCK_BELONGS)('$name fails the startup naming $key', async ({ hocon, key, mustBe }) => {
    const system = systemOver('value-where-a-block-belongs', hocon);
    try {
      const error = await rejectionOf(system.whenReady());

      expect(error.cause).toBeInstanceOf(ConfigError);
      expect((error.cause as Error).message).toStartWith(`Config at "${key}" ${mustBe}, not a value`);
    } finally {
      await stopped(system);
    }
  });

  test.each(VALUES_WHERE_A_BLOCK_BELONGS)('$name fails all three axes', async ({ hocon, key, mustBe }) => {
    const system = systemOver('value-where-a-block-belongs-every-axis', hocon);
    const extension = system.extension(PersistenceExtensionId);
    try {
      const refusal = `Config at "${key}" ${mustBe}, not a value`;

      expect(() => extension.journal).toThrow(refusal);
      expect(() => extension.snapshotStore).toThrow(refusal);
      expect(() => extension.durableStateStore).toThrow(refusal);
      await rejectionOf(system.whenReady());
    } finally {
      await stopped(system);
    }
  });

  test('a file that leaves every axis block at reference.conf\'s default starts on the in-memory stores', async () => {
    // Beside the axis blocks, not in place of one: reference.conf's selectors
    // are still there, so nothing is refused and nothing is selected.
    const system = systemOver('every-axis-at-its-default', 'actor-ts.persistence.snapshot-is-optional = on');
    try {
      await system.whenReady();
      const extension = system.extension(PersistenceExtensionId);

      expect(extension.journal).toBeInstanceOf(InMemoryJournal);
      expect(extension.snapshotStore).toBeInstanceOf(InMemorySnapshotStore);
      expect(extension.durableStateStore).toBeInstanceOf(InMemoryDurableStateStore);
    } finally {
      await stopped(system);
    }
  });
});

describe('a selected id reaches the lookup as written (#1425)', () => {
  const MIXED_CASE_ID = 'Acme.Persistence.Journal';

  /** A plug-in that registers `journal` under `id`. */
  const registeringJournal = (id: string, journal: InMemoryJournal): PersistencePlugin => (persistence) => {
    persistence.registerJournal(id, () => journal);
  };

  test('a mixed-case id selects the plug-in registered under exactly that id', async () => {
    const journal = new InMemoryJournal();
    const system = systemWithPluginOver(
      'selector-mixed-case',
      `actor-ts.persistence.journal.plugin = "${MIXED_CASE_ID}"`,
      registeringJournal(MIXED_CASE_ID, journal),
    );
    try {
      await system.whenReady();

      expect(system.extension(PersistenceExtensionId).journal).toBe(journal);
    } finally {
      await stopped(system);
    }
  });

  test('an id with surrounding whitespace is an unknown id, not a near miss quietly corrected', async () => {
    const padded = `  ${MIXED_CASE_ID}  `;
    const system = systemWithPluginOver(
      'selector-padded',
      `actor-ts.persistence.journal.plugin = "${padded}"`,
      registeringJournal(MIXED_CASE_ID, new InMemoryJournal()),
    );
    try {
      const error = await rejectionOf(system.whenReady());

      expect(error.message).toContain(`Unknown journal plugin '${padded}'`);
    } finally {
      await stopped(system);
    }
  });
});

type UnknownKeyCase = {
  readonly name: string;
  readonly hocon: string;
  /** The full key the refusal names. */
  readonly key: string;
};

/**
 * Keys under `actor-ts.persistence` that no reader takes (#1729), at the two
 * levels the framework reads itself: directly under `actor-ts.persistence`,
 * where the axis blocks and the behaviour keys go, and directly in an axis
 * block, where its `plugin` selector goes beside the blocks of its plug-ins.
 * Read by nothing, each left the axis on the store `reference.conf` selects —
 * a journal kept in memory, with no error and no log line even at debug — and
 * the startup reported ready.
 */
const UNKNOWN_KEYS: UnknownKeyCase[] = [
  {
    name: 'a misspelt journal selector',
    hocon: 'actor-ts.persistence.journal.plugn = "actor-ts.persistence.journal.sqlite"',
    key: 'actor-ts.persistence.journal.plugn',
  },
  {
    name: 'a misspelt journal block',
    hocon: 'actor-ts.persistence.jornal { plugin = "actor-ts.persistence.journal.sqlite" }',
    key: 'actor-ts.persistence.jornal',
  },
  {
    name: 'a misspelt behaviour key',
    hocon: 'actor-ts.persistence.recovery-timout = 5s',
    key: 'actor-ts.persistence.recovery-timout',
  },
  {
    name: 'a plug-in setting written straight into the durable-state block',
    hocon: 'actor-ts.persistence.durable-state.table = "state"',
    key: 'actor-ts.persistence.durable-state.table',
  },
  {
    name: 'a plug-in\'s id written as a value where its block belongs',
    hocon: 'actor-ts.persistence.snapshot-store.sqlite = "/var/lib/app/snapshots.db"',
    key: 'actor-ts.persistence.snapshot-store.sqlite',
  },
  {
    name: 'a plug-in block written beside the axes rather than inside one',
    hocon: 'actor-ts.persistence.my-plugin { table = "events" }',
    key: 'actor-ts.persistence.my-plugin',
  },
];

describe('a key under actor-ts.persistence that no reader takes fails the startup, naming it (#1729)', () => {
  test.each(UNKNOWN_KEYS)('$name fails the startup naming $key', async ({ hocon, key }) => {
    const system = systemOver('unknown-persistence-key', hocon);
    try {
      const error = await rejectionOf(system.whenReady());

      expect(error.message).toContain('"persistence-warm-up"');
      expect(error.cause).toBeInstanceOf(ConfigError);
      const refusal = (error.cause as Error).message;
      expect(refusal).toStartWith(`Config at "${key}" is not a key `);
      // Says what to do, not only what is wrong.
      expect(refusal).toContain('correct the spelling, or move a plug-in\'s settings into its block');
    } finally {
      await stopped(system);
    }
  });

  test.each(UNKNOWN_KEYS)('$name fails all three axes', async ({ hocon, key }) => {
    const system = systemOver('unknown-persistence-key-every-axis', hocon);
    const extension = system.extension(PersistenceExtensionId);
    try {
      const refusal = `Config at "${key}" is not a key `;

      expect(() => extension.journal).toThrow(refusal);
      expect(() => extension.snapshotStore).toThrow(refusal);
      expect(() => extension.durableStateStore).toThrow(refusal);
      await rejectionOf(system.whenReady());
    } finally {
      await stopped(system);
    }
  });

  test('a system that sets every store in code still has the key refused at startup', async () => {
    // No axis reads the selection then, but the behaviour keys beside it are
    // in force for every persistent actor, so a misspelt one is still a key
    // read by nothing.
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig(Config.parseString('actor-ts.persistence.recovery-timout = 5s'))
      .withPersistence({
        journal: new InMemoryJournal(),
        snapshotStore: new InMemorySnapshotStore(),
        durableStateStore: new InMemoryDurableStateStore(),
      });
    const system = ActorSystem.create('unknown-persistence-key-every-store-in-code', systemOptions);
    try {
      const error = await rejectionOf(system.whenReady());

      expect(error.message).toContain('"persistence-warm-up"');
      expect(error.cause).toBeInstanceOf(ConfigError);
      expect((error.cause as Error).message).toStartWith('Config at "actor-ts.persistence.recovery-timout" is not a key ');
    } finally {
      await stopped(system);
    }
  });

  test('a file with the boot-time open off still fails the startup on the key', async () => {
    // The switch decides when the stores open, and refusing the key opens
    // none, so off is no reason to start on a file with a key nothing reads.
    const systemOptions = quietOptionsOver(
      'actor-ts.persistence { auto-start = off, journal.plugn = "actor-ts.persistence.journal.sqlite" }',
    );
    const system = createdWithout('unknown-persistence-key-auto-start-off', systemOptions);
    try {
      await expectStartupRefusing(system, 'actor-ts.persistence.journal.plugn');
    } finally {
      await stopped(system);
    }
  });

  test('every store set in code with the boot-time open off in the file still fails the startup on the key', async () => {
    const systemOptions = quietOptionsOver('actor-ts.persistence { auto-start = off, recovery-timout = 5s }')
      .withPersistence(everyStoreInCode());
    const system = createdWithout('unknown-persistence-key-every-store-auto-start-off', systemOptions);
    try {
      await expectStartupRefusing(system, 'actor-ts.persistence.recovery-timout');
    } finally {
      await stopped(system);
    }
  });

  test('every store set in code with autoStart false set in code still fails the startup on the key', async () => {
    const behavior = PersistenceBehaviorOptions.create().withAutoStart(false);
    const systemOptions = quietOptionsOver('actor-ts.persistence.recovery-timout = 5s')
      .withPersistence({ ...everyStoreInCode(), behavior });
    const system = createdWithout('unknown-persistence-key-every-store-auto-start-false', systemOptions);
    try {
      await expectStartupRefusing(system, 'actor-ts.persistence.recovery-timout');
    } finally {
      await stopped(system);
    }
  });

  test('plug-ins passed with autoStart false set in code still fail the startup on the key', async () => {
    const behavior = PersistenceBehaviorOptions.create().withAutoStart(false);
    const plugin: PersistencePlugin = (persistence) => {
      persistence.registerJournal('acme.persistence.journal', () => new InMemoryJournal());
    };
    const systemOptions = quietOptionsOver('actor-ts.persistence.jornal { plugin = "acme.persistence.journal" }')
      .withPersistence({ plugins: [plugin], behavior });
    const system = createdWithout('unknown-persistence-key-plugins-auto-start-false', systemOptions);
    try {
      await expectStartupRefusing(system, 'actor-ts.persistence.jornal');
    } finally {
      await stopped(system);
    }
  });

  test('autoStart false set in code and nothing else, a WorkerMesh worker\'s whole withPersistence, still fails the startup on the key', async () => {
    // The one shape that builds no persistence inside `create` on a valid
    // file.  On a file holding a key nothing reads it builds the extension
    // after all, so the refusal is the startup's failure like everywhere else.
    const behavior = PersistenceBehaviorOptions.create().withAutoStart(false);
    const systemOptions = quietOptionsOver('actor-ts.persistence.jornal { plugin = "actor-ts.persistence.journal.sqlite" }')
      .withPersistence({ behavior });
    const system = createdWithout('unknown-persistence-key-auto-start-false-in-code', systemOptions);
    try {
      await expectStartupRefusing(system, 'actor-ts.persistence.jornal');
    } finally {
      await stopped(system);
    }
  });
});

describe('what the refusal leaves alone (#1729)', () => {
  test('a configuration with nothing under actor-ts.persistence starts, and builds no persistence inside create', async () => {
    // Only reference.conf under it, as an application without a file has:
    // nothing is refused, so nothing is selected and the extension stays lazy.
    const system = systemOver('nothing-under-persistence', '');
    try {
      await system.whenReady();

      expect(system.extensions.has(PersistenceExtensionId)).toBe(false);
      expect(system.extension(PersistenceExtensionId).journal).toBeInstanceOf(InMemoryJournal);
    } finally {
      await stopped(system);
    }
  });

  test('a configuration that only selects a registered plug-in starts on it', async () => {
    const journal = new InMemoryJournal();
    const pluginId = 'acme.persistence.journal';
    const system = systemWithPluginOver(
      'selects-a-registered-plugin',
      `actor-ts.persistence.journal.plugin = "${pluginId}"`,
      (persistence) => { persistence.registerJournal(pluginId, () => journal); },
    );
    try {
      await system.whenReady();

      expect(system.extension(PersistenceExtensionId).journal).toBe(journal);
    } finally {
      await stopped(system);
    }
  });

  test('a third-party plug-in\'s block inside an axis is its own: selected, the plug-in reads it', async () => {
    const pluginId = 'actor-ts.persistence.journal.my-plugin';
    const journal = new InMemoryJournal();
    let tableRead: string | undefined;
    const plugin: PersistencePlugin = (persistence) => {
      persistence.registerJournal(pluginId, (system) => {
        tableRead = system.config.getString(`${pluginId}.table`);
        return journal;
      });
    };
    const system = systemWithPluginOver(
      'third-party-plugin-block',
      `actor-ts.persistence.journal { plugin = "${pluginId}", my-plugin { table = "events" } }`,
      plugin,
    );
    try {
      await system.whenReady();

      expect(system.extension(PersistenceExtensionId).journal).toBe(journal);
      expect(tableRead).toBe('events');
    } finally {
      await stopped(system);
    }
  });

  test.each([
    { name: 'autoStart false set in code', hocon: '', autoStartInCode: false as boolean | undefined },
    { name: 'the boot-time open off in the file', hocon: 'actor-ts.persistence.auto-start = off', autoStartInCode: undefined },
  ])('every store set in code with $name, over a file with no such key, adds no startup task', async ({ hocon, autoStartInCode }) => {
    const behavior = autoStartInCode === undefined
      ? undefined
      : PersistenceBehaviorOptions.create().withAutoStart(autoStartInCode);
    // A journal that can be opened, so a warm-up that opened the stores under
    // the switch would show as a task and a start.
    const journal = new StartCountingJournal();
    const systemOptions = quietOptionsOver(hocon).withPersistence({ ...everyStoreInCode(), journal, behavior });
    const system = createdWithout('every-store-in-code-auto-start-off-no-such-key', systemOptions);
    try {
      expect(system.extension(CoordinatedStartupId).hasTasks).toBe(false);
      await system.whenReady();
      expect(journal.starts).toBe(0);
    } finally {
      await stopped(system);
    }
  });

  test.each([
    { name: 'a plug-in selected', hocon: 'actor-ts.persistence.journal.plugin = "actor-ts.persistence.journal.sqlite"' },
    { name: 'an invalid behaviour value', hocon: 'actor-ts.persistence.max-concurrent-recoveries = -1' },
    { name: 'nothing at all', hocon: '' },
  ])('autoStart false set in code and nothing else, over a valid file with $name, builds no persistence inside create', async ({ hocon }) => {
    // The deferral a WorkerMesh worker relies on: its main thread wires the
    // plug-ins its file selects, the worker inherits the file without them.
    // Only a key nothing reads builds the extension here (#1729).
    const behavior = PersistenceBehaviorOptions.create().withAutoStart(false);
    const systemOptions = quietOptionsOver(hocon).withPersistence({ behavior });
    const system = createdWithout('auto-start-false-alone-valid-file', systemOptions);
    try {
      await system.whenReady();

      expect(system.extensions.has(PersistenceExtensionId)).toBe(false);
      expect(system.extension(CoordinatedStartupId).hasTasks).toBe(false);
    } finally {
      await stopped(system);
    }
  });

  test('autoStart false set in code still asks nothing of the behaviour block inside create', async () => {
    // The refusal reads the names under actor-ts.persistence, not the values:
    // an invalid value is still refused on first use, as before (#1473).
    const behavior = PersistenceBehaviorOptions.create().withAutoStart(false);
    const systemOptions = quietOptionsOver('actor-ts.persistence.max-concurrent-recoveries = -1')
      .withPersistence({ ...everyStoreInCode(), behavior });
    const system = createdWithout('auto-start-false-invalid-behaviour-value', systemOptions);
    try {
      await system.whenReady();

      expect(system.extension(CoordinatedStartupId).hasTasks).toBe(false);
      expect(() => system.extension(PersistenceExtensionId).behavior).toThrow(OptionsError);
    } finally {
      await stopped(system);
    }
  });

  test('a misspelt leaf inside a plug-in\'s block is the plug-in\'s to refuse, not the framework\'s', async () => {
    // Nothing selects the plug-in, so nothing reads its block: the framework
    // checks the keys it reads itself and leaves a plug-in's block to it.
    const system = systemOver(
      'misspelt-leaf-in-a-plugin-block',
      'actor-ts.persistence.journal.my-plugin { tabel = "events" }',
    );
    try {
      await system.whenReady();

      expect(system.extension(PersistenceExtensionId).journal).toBeInstanceOf(InMemoryJournal);
    } finally {
      await stopped(system);
    }
  });
});
