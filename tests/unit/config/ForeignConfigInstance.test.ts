import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

/**
 * A `Config` built by another copy of actor-ts is refused, never read as a
 * configuration tree (found while #1425).
 *
 * Two copies of the package in one dependency tree — or one file reached
 * through two spellings of its path — give each copy its own `Config` class,
 * so `instanceof Config` fails for the other copy's instances.  The value then
 * went through `Config.fromObject`, whose plain-object test accepts any
 * non-array object, and the instance's *own fields* became the tree: every key
 * the application set landed under `tree.*`, where nothing reads it.  The
 * system came up named `default`, with the reference defaults, and said
 * nothing — the one outcome a configuration layer must never have.
 *
 * Refused rather than honoured: a loaded `Config` carries its layers and the
 * secret paths the boot dump withholds, and those are private to the copy that
 * built it.  Reading only its tree would print a secrets-file value in clear
 * text, which is worse than the startup failure.
 */

/**
 * A second module record of `Config.ts`.  The query string makes this a
 * different specifier, and a specifier is what a module record is keyed on —
 * the same thing a second copy of the package produces.  Held in a variable so
 * the compiler does not try to resolve a path with a query in it.
 */
const SECOND_COPY_SPECIFIER = '../../../src/config/Config.js?a-second-copy-of-actor-ts';
const secondCopy = (await import(SECOND_COPY_SPECIFIER)) as typeof import('../../../src/config/Config.js');

const quietSystemOptions = () =>
  ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);

describe('a Config built by another copy of actor-ts (found while #1425)', () => {
  test('the second copy really is a second module record', () => {
    // Without this, every refusal below could pass against the copy's own
    // class, and none of them would be about a foreign instance at all.
    expect(secondCopy.Config).not.toBe(Config);
    expect(secondCopy.Config.parseString('a = 1')).not.toBeInstanceOf(Config);
  });

  test('ActorSystemOptions.withConfig refuses it rather than starting on the reference defaults', () => {
    const foreign = secondCopy.Config.parseString('actor-ts.system.name = "named-by-the-other-copy"');
    const systemOptions = quietSystemOptions().withConfig(foreign);
    expect(() => ActorSystem.create(undefined, systemOptions)).toThrow(ConfigError);
    expect(() => ActorSystem.create(undefined, systemOptions)).toThrow(/another copy of actor-ts/);
  });

  test('Config.load refuses it as its overrides', () => {
    const foreign = secondCopy.Config.parseString('actor-ts.system.name = "named-by-the-other-copy"');
    expect(() => Config.load({ overrides: foreign })).toThrow(/another copy of actor-ts/);
  });

  test('Config.fromObject refuses it', () => {
    const foreign = secondCopy.Config.parseString('a.b = 1');
    expect(() => Config.fromObject(foreign)).toThrow(ConfigError);
    expect(() => Config.fromObject(foreign)).toThrow(/another copy of actor-ts/);
  });
});

describe('what Config.fromObject still takes, and what else it refuses', () => {
  test('this copy\'s own Config is taken whole, not cloned field by field', () => {
    const own = Config.parseString('a.b = 1');
    expect(Config.fromObject(own).getInt('a.b')).toBe(1);
    expect(Config.fromObject(own).hasPath('tree')).toBe(false);
  });

  test('withConfig still honours this copy\'s Config and a nested plain object', async () => {
    const fromConfig = ActorSystem.create(
      undefined,
      quietSystemOptions().withConfig(Config.parseString('actor-ts.system.name = "named-by-a-config"')),
    );
    const fromObject = ActorSystem.create(
      undefined,
      quietSystemOptions().withConfig({ 'actor-ts': { system: { name: 'named-by-an-object' } } }),
    );
    expect(fromConfig.name).toBe('named-by-a-config');
    expect(fromObject.name).toBe('named-by-an-object');
    await fromConfig.terminate();
    await fromObject.terminate();
  });

  test('a plain object and a null-prototype object are read as trees', () => {
    expect(Config.fromObject({ a: { b: 1 } }).getInt('a.b')).toBe(1);
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { a: { b: 2 } });
    expect(Config.fromObject(bare).getInt('a.b')).toBe(2);
  });

  // The plain-object rule asks whether the prototype ends the chain, not
  // whether it *is* this realm's `Object.prototype`: an object literal built
  // in another realm has that realm's, and is every bit as plain.
  test('a plain object from another realm is read as a tree too', () => {
    const otherRealm = runInNewContext('({ a: { b: 3 } })') as Record<string, unknown>;
    expect(Object.getPrototypeOf(otherRealm)).not.toBe(Object.prototype);
    expect(Config.fromObject(otherRealm).getInt('a.b')).toBe(3);
  });

  // The same silent outcome by another route: an instance with no own fields
  // used to come back as an empty tree, so whatever it was meant to say was
  // dropped without a word.
  test('an instance of any other class is refused rather than read as an empty tree', () => {
    expect(() => Config.fromObject(new Map([['a', 1]]))).toThrow(ConfigError);
    expect(() => Config.fromObject(new Map([['a', 1]]))).toThrow(/instance of Map/);
  });

  // What a copy that predates the brand looks like from here: a class named
  // `Config` whose own fields are its internals.  The brand cannot recognise
  // it, so the plain-object rule is what has to.
  test('a Config of an older copy, which carries no brand, is refused by the plain-object rule', () => {
    class LegacyConfig {
      readonly tree = { actor: { system: { name: 'x' } } };
      readonly layers = null;
    }
    expect(() => Config.fromObject(new LegacyConfig())).toThrow(ConfigError);
    expect(() => Config.fromObject(new LegacyConfig())).toThrow(/instance of LegacyConfig/);
  });
});
