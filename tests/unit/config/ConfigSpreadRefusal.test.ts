import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../src/config/Config.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';

/**
 * A spread of a `Config` is refused wherever a `Config` is built from an
 * object — `Config.fromObject`, `Config.load({ overrides })` and, through
 * them, `ActorSystemOptions.withConfig` (#1473, the #1425 defect by another
 * route).
 *
 * The brand that tells a `Config` from a tree sits on the prototype, and a
 * spread copies own keys only — so `{ ...config }` is a plain object holding
 * the instance's private fields.  Read as a tree, every key the configuration
 * set landed under `tree.*`, where nothing reads it, and a system built on it
 * started as `default` on the reference defaults without a word.  The
 * #1425 migration note advised exactly that spread.
 */

/** A second module record of `Config.ts` — see `ForeignConfigInstance.test.ts`. */
const SECOND_COPY_SPECIFIER = '../../../src/config/Config.js?a-second-copy-for-the-spread-refusal';
const secondCopy = (await import(SECOND_COPY_SPECIFIER)) as typeof import('../../../src/config/Config.js');

const NAMED = 'actor-ts.system.name = "named-by-the-config"';

/** What building from `build` did: the system name the result carries, or the error it threw. */
function outcomeOf(build: () => Config): string {
  let config: Config;
  try {
    config = build();
  } catch (error) {
    return `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
  return config.hasPath('actor-ts.system.name') ? `read ${config.getString('actor-ts.system.name')}` : 'read no name';
}

describe('Config.fromObject and Config.load refuse a spread of a Config', () => {
  test('Config.fromObject refuses a spread of this copy\'s Config, naming the spread', () => {
    const outcome = outcomeOf(() => Config.fromObject({ ...Config.parseString(NAMED) }));
    expect(outcome).toStartWith('ConfigError: ');
    expect(outcome).toContain('spread of a Config');
  });

  test('Config.fromObject refuses a spread of another copy\'s Config the same way', () => {
    expect(secondCopy.Config).not.toBe(Config);
    const outcome = outcomeOf(() => Config.fromObject({ ...secondCopy.Config.parseString(NAMED) }));
    expect(outcome).toStartWith('ConfigError: ');
    expect(outcome).toContain('spread of a Config');
  });

  test('a spread with keys added beside it is refused too, as a spread', () => {
    const spread = { ...Config.parseString(NAMED), 'actor-ts': { system: { 'log-level': 'info' } } };
    const outcome = outcomeOf(() => Config.fromObject(spread));
    expect(outcome).toStartWith('ConfigError: ');
    // Named as the spread it is, not only caught one level down by the
    // instance among its fields.
    expect(outcome).toContain('spread of a Config');
  });

  test('Config.load refuses a spread as its overrides', () => {
    const spread = { ...Config.parseString(NAMED) } as ConfigObject;
    const outcome = outcomeOf(() => Config.load({ overrides: spread }));
    expect(outcome).toStartWith('ConfigError: ');
    expect(outcome).toContain('spread of a Config');
  });

  test('the Config itself is still taken whole, by both', () => {
    expect(outcomeOf(() => Config.fromObject(Config.parseString(NAMED)))).toBe('read named-by-the-config');
    expect(outcomeOf(() => Config.load({ overrides: Config.parseString(NAMED) }))).toBe('read named-by-the-config');
  });

  // The refusal keys on the whole set of a Config's own fields, so a tree that
  // happens to use one of their names is still a tree.
  test('a plain object that only shares a field name with a Config is still read as a tree', () => {
    const overrides: ConfigObject = { tree: { planted: true }, 'actor-ts': { system: { name: 'named-by-a-plain-object' } } };
    expect(outcomeOf(() => Config.fromObject(overrides))).toBe('read named-by-a-plain-object');
  });

  test('a foreign Config instance keeps its own message rather than the spread one', () => {
    const outcome = outcomeOf(() => Config.fromObject(secondCopy.Config.parseString(NAMED)));
    expect(outcome).toContain('another copy of actor-ts');
    expect(outcome).not.toContain('spread of a Config');
  });
});

/**
 * A class instance below the top level is refused as the top level is: its
 * own fields are not a configuration tree.  `{ 'actor-ts': config }` read the
 * instance's fields as `actor-ts.tree.…`, a `Map` was an empty block, and a
 * `Date` became a leaf no reader can use — each accepted without a word.
 */
describe('Config.fromObject refuses a class instance below the top level', () => {
  test('a Config nested under a key is refused, naming the key', () => {
    const outcome = outcomeOf(() => Config.fromObject({ 'actor-ts': Config.parseString('system.name = "nested"') }));
    expect(outcome).toStartWith('ConfigError: ');
    expect(outcome).toContain('actor-ts');
  });

  test('a Config of another copy nested under a key is refused', () => {
    const outcome = outcomeOf(() => Config.fromObject({ 'actor-ts': secondCopy.Config.parseString('system.name = "x"') }));
    expect(outcome).toStartWith('ConfigError: ');
  });

  test('a Map, a Date and a class instance nested in a block are refused, naming the path', () => {
    class Settings { readonly port = 2552; }
    for (const [label, value] of [['Map', new Map([['port', 2552]])], ['Date', new Date(0)], ['Settings', new Settings()]] as const) {
      const outcome = outcomeOf(() => Config.fromObject({ 'actor-ts': { remote: { settings: value } } } as unknown as ConfigObject));
      expect(outcome, label).toStartWith('ConfigError: ');
      expect(outcome, label).toContain('actor-ts.remote.settings');
      expect(outcome, label).toContain(label);
    }
  });

  test('an instance inside a list is refused too', () => {
    const outcome = outcomeOf(() => Config.fromObject({ seeds: [new Map()] } as unknown as ConfigObject));
    expect(outcome).toStartWith('ConfigError: ');
    expect(outcome).toContain('seeds');
  });

  test('plain blocks, null-prototype blocks, lists of plain values and null leaves are still read', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { port: 2552 });
    const tree = {
      a: { b: { c: 1 } },
      bare,
      list: [1, 'two', { three: 3 }],
      nothing: null,
    } as unknown as ConfigObject;
    const config = Config.fromObject(tree);
    expect(config.getInt('a.b.c')).toBe(1);
    expect(config.getInt('bare.port')).toBe(2552);
    expect(config.getList('list')).toHaveLength(3);
  });
});
