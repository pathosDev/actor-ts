import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { InMemoryDurableStateStore } from '../../../src/persistence/durable-state-stores/InMemoryDurableStateStore.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { PersistenceExtensionId, type PersistencePlugin } from '../../../src/persistence/PersistenceExtension.js';
import { InMemorySnapshotStore } from '../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';

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
 * as an id.
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
