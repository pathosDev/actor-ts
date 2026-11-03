import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { Config, ConfigError } from '../../src/config/Config.js';
import type { ConfigObject } from '../../src/config/HoconParser.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';

/**
 * A spread of a `Config` handed to `ActorSystemOptions.withConfig` is refused,
 * never read as a configuration tree (#1473, the #1425 defect by another
 * route).
 *
 * The brand that tells a `Config` from a tree sits on the prototype, and a
 * spread copies own keys only — so `{ ...config }` is a plain object holding
 * the instance's private fields.  `withConfig` read those as the tree: every
 * key the configuration set landed under `tree.*`, where nothing reads it, and
 * the system started named `default` on the reference defaults without a
 * word.  That held for this copy's `Config` and for another copy's alike.
 */

/** A second module record of `Config.ts` — see `ForeignConfigInstance.test.ts`. */
const SECOND_COPY_SPECIFIER = '../../src/config/Config.js?a-second-copy-for-the-spread-route';
const secondCopy = (await import(SECOND_COPY_SPECIFIER)) as typeof import('../../src/config/Config.js');

const NAMED = 'actor-ts.system.name = "named-by-the-config"';

function quietOptionsWith(config: Config | ConfigObject) {
  return ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(config);
}

/** What `create` did with `config`: the name the system came up under, or the error it threw. */
async function outcomeOfCreating(config: Config | ConfigObject): Promise<string> {
  let system: ActorSystem;
  try {
    system = ActorSystem.create(undefined, quietOptionsWith(config));
  } catch (error) {
    return `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
  const name = system.name;
  await system.terminate();
  return `started as ${name}`;
}

describe('ActorSystemOptions.withConfig and a spread of a Config', () => {
  test('a spread of this copy\'s Config is refused, naming the spread', async () => {
    const config = Config.parseString(NAMED);
    const outcome = await outcomeOfCreating({ ...config } as ConfigObject);
    expect(outcome).toStartWith('ConfigError: ');
    expect(outcome).toContain('spread of a Config');
  });

  test('a spread of another copy\'s Config is refused the same way', async () => {
    expect(secondCopy.Config).not.toBe(Config);
    const config = secondCopy.Config.parseString(NAMED);
    const outcome = await outcomeOfCreating({ ...config } as ConfigObject);
    expect(outcome).toStartWith('ConfigError: ');
    expect(outcome).toContain('spread of a Config');
  });

  test('a spread with keys added beside it is refused too: the spread part is still no configuration', async () => {
    const config = Config.parseString(NAMED);
    const outcome = await outcomeOfCreating({ ...config, 'actor-ts': { 'system': { 'log-level': 'info' } } } as ConfigObject);
    expect(outcome).toStartWith('ConfigError: ');
    expect(outcome).toContain('spread of a Config');
  });

  test('the refusal is a ConfigError thrown by create', () => {
    const config = Config.parseString(NAMED);
    expect(() => ActorSystem.create(undefined, quietOptionsWith({ ...config } as ConfigObject))).toThrow(ConfigError);
  });

  test('the Config itself is still taken whole', async () => {
    expect(await outcomeOfCreating(Config.parseString(NAMED))).toBe('started as named-by-the-config');
  });

  // The refusal keys on the whole set of a Config's own fields, so a tree that
  // happens to use one of their names is still a tree.
  test('a plain object that only shares a field name with a Config is still read as a tree', async () => {
    const overrides: ConfigObject = {
      tree: { planted: true },
      'actor-ts': { system: { name: 'named-by-a-plain-object' } },
    };
    expect(await outcomeOfCreating(overrides)).toBe('started as named-by-a-plain-object');
  });
});
