import { describe, expect, spyOn, test, type Mock } from 'bun:test';
import * as ActorOptionsModule from '../../../src/ActorOptions.js';
import * as ActorSystemModule from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import * as CoordinatedShutdownModule from '../../../src/CoordinatedShutdown.js';
import * as LoggerFromConfigModule from '../../../src/logging/LoggerFromConfig.js';
import * as PersistenceExtensionModule from '../../../src/persistence/PersistenceExtension.js';

/**
 * The half of the dead-key guarantee the perturbation gate cannot see (#1425).
 *
 * `NoDeadConfigKeys` runs every registered reader against every leaf, so it
 * proves a reader reads each one — not that the runtime asks that reader.
 * Put back to a direct `config.getString(...)` of the same key, the journal
 * selector left every suite green, the gate included; so did an `ActorSystem`
 * constructor reading `actor.throughput` inline instead of through its reader.
 * These cases pin the consumers that have been seen doing exactly that to the
 * readers the gate observes: each must call its reader, with the system's own
 * config, while it resolves.
 *
 * Pass-through spies on the module namespace, restored after every case: the
 * reader still runs and answers, so nothing the consumer builds changes.
 *
 * What this does not see: a consumer that calls its reader and *also* reads a
 * key inline beside it (the reader is called, its answer for that field
 * ignored), and wiring that drops a reader's answer.  Both stay with the
 * subsystem's own binding tests.
 */

let systemCounter = 0;

/** A silent system: no sinks, so the level is still read from config but nothing prints. */
function silentSystem(): ActorSystemModule.ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogSinks([])
    .withConfig(Config.parseString(`actor-ts.system.name = consumers-read-through-readers-${systemCounter++}`));
  return ActorSystemModule.ActorSystem.create(undefined, options);
}

/** Spy on `names` of `namespace` for the length of `body`, and hand the spies to it. */
async function withSpies<Namespace extends object, Name extends keyof Namespace & string>(
  namespace: Namespace,
  names: readonly Name[],
  body: (spies: Readonly<Record<Name, Mock<(...parameters: unknown[]) => unknown>>>) => Promise<void> | void,
): Promise<void> {
  const spies = {} as Record<Name, Mock<(...parameters: unknown[]) => unknown>>;
  for (const name of names) {
    spies[name] = spyOn(namespace, name as never) as unknown as Mock<(...parameters: unknown[]) => unknown>;
  }
  try {
    await body(spies);
  } finally {
    for (const name of names) spies[name].mockRestore();
  }
}

function calledWith(spy: Mock<(...parameters: unknown[]) => unknown>, config: Config): boolean {
  return spy.mock.calls.some(([argument]) => argument === config);
}

describe('the ActorSystem constructor', () => {
  test('reads its own leaves through the core readers, from the system\'s config', async () => {
    const coreReaders = [
      'readSystemNameFromConfig',
      'readDispatcherOptionsFromConfig',
      'readLoggerCloseTimeoutFromConfig',
      'readShutdownDrainTimeoutFromConfig',
      'readActorThroughputFromConfig',
      'readAskTimeoutFromConfig',
    ] as const;
    await withSpies(ActorSystemModule, coreReaders, async (core) => {
      await withSpies(ActorOptionsModule, ['readDefaultMailboxFromConfig'] as const, async (mailbox) => {
        await withSpies(LoggerFromConfigModule, ['readLoggerLevelFromConfig'] as const, async (logger) => {
          const system = silentSystem();
          try {
            for (const name of coreReaders) {
              expect(calledWith(core[name], system.config), `the constructor did not ask ${name}`).toBe(true);
            }
            expect(calledWith(mailbox.readDefaultMailboxFromConfig, system.config)).toBe(true);
            expect(calledWith(logger.readLoggerLevelFromConfig, system.config)).toBe(true);
          } finally {
            await system.terminate();
          }
        });
      });
    });
  });
});

describe('CoordinatedShutdown', () => {
  test('reads its block through readCoordinatedShutdownOptionsFromConfig', async () => {
    const system = silentSystem();
    try {
      await withSpies(CoordinatedShutdownModule, ['readCoordinatedShutdownOptionsFromConfig'] as const, (spies) => {
        system.extension(CoordinatedShutdownModule.CoordinatedShutdownId);
        expect(calledWith(spies.readCoordinatedShutdownOptionsFromConfig, system.config)).toBe(true);
      });
    } finally {
      await system.terminate();
    }
  });
});

describe('PersistenceExtension', () => {
  test.each(['journal', 'snapshotStore', 'durableStateStore'] as const)(
    'resolves its %s through readPersistencePluginIdsFromConfig',
    async (store) => {
      const system = silentSystem();
      try {
        const persistence = system.extension(PersistenceExtensionModule.PersistenceExtensionId);
        await withSpies(PersistenceExtensionModule, ['readPersistencePluginIdsFromConfig'] as const, (spies) => {
          void persistence[store];
          expect(
            calledWith(spies.readPersistencePluginIdsFromConfig, system.config),
            `resolving the ${store} did not ask readPersistencePluginIdsFromConfig which plug-in the config selects`,
          ).toBe(true);
        });
      } finally {
        await system.terminate();
      }
    },
  );
});
