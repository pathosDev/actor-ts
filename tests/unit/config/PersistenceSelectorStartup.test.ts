import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { PersistenceExtensionId, type PersistencePlugin } from '../../../src/persistence/PersistenceExtension.js';

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
