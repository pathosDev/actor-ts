import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../src/config/Config.js';
import * as persistence from '../../../src/persistence/index.js';
import * as persistenceConstants from '../../../src/persistence/Constants.js';
import * as storeConfig from '../../../src/persistence/StoreConfig.js';
import { readStoreBytes, readStoreEnum } from '../../../src/persistence/StoreConfig.js';

/**
 * What `actor-ts/persistence` publishes for configuring a store (#1490).
 *
 * `StoreConfig.ts` is the seam a third-party backend plug-in reads its own
 * HOCON block through, and the barrel presents it as exactly that — so a
 * reader the module grows and the barrel never re-exports is a reader only
 * the framework's own backends can use.  `readStoreStringList` was that for a
 * whole release: Cassandra read its seed list through it while nothing outside
 * `src/` could.  Asked of the module's whole export set rather than of a list,
 * so the next reader cannot repeat it.
 */

/** Every export of `StoreConfig.ts`, as the barrel would have to carry it. */
const seamExports = Object.entries(storeConfig);

describe('the StoreConfig seam is on the public barrel', () => {
  test('the module exports the readers this file is asking about', () => {
    // Guards the guard: a namespace that came back empty would make the
    // per-name case below vacuously green.
    expect(seamExports.map(([name]) => name)).toEqual(expect.arrayContaining([
      'readStoreBytes',
      'readStoreEnum',
      'readStoreStringList',
      'readStoreString',
      'storeLeaf',
    ]));
  });

  test.each(seamExports)('%s is re-exported by src/persistence/index.ts', (name, value) => {
    expect((persistence as Record<string, unknown>)[name]).toBe(value);
  });
});

/**
 * The defaults behind the backend leaves `reference.conf` documents, named in
 * `src/persistence/Constants.ts` — the published values, and the capacity
 * fallback a DynamoDB block's comment names.  The barrel exports them for the
 * reason it gives the shared table names: an application asserting against
 * the shipped default should not have to restate the literal (#1490).
 */
const PUBLISHED_BACKEND_DEFAULTS = [
  'DEFAULT_D1_TIMEOUT_MS',
  'DEFAULT_D1_MAX_RESPONSE_BYTES',
  'DEFAULT_DYNAMODB_BILLING_MODE',
  'DEFAULT_DYNAMODB_TABLE_READY_TIMEOUT_MS',
  'DEFAULT_DYNAMODB_PROVISIONED_CAPACITY_UNITS',
] as const;

describe('the backend defaults reference.conf publishes are public names', () => {
  test.each([...PUBLISHED_BACKEND_DEFAULTS])('%s is re-exported by src/persistence/index.ts', (name) => {
    expect(persistenceConstants[name]).toBeDefined();
    expect((persistence as Record<string, unknown>)[name]).toBe(persistenceConstants[name]);
  });
});

/** Every `.ts` file under `directory`, recursively. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Every options validator class `src/persistence/` exports — the concrete
 * ones and the per-backend bases they extend — found in the source rather
 * than listed, so a backend added later is asked the same question.
 */
const VALIDATOR_DECLARATION = /export (?:abstract )?class ([A-Za-z0-9]+OptionsValidator(?:Base)?)\b/g;
const exportedValidators = sourceFiles(join(import.meta.dir, '..', '..', '..', 'src', 'persistence'))
  .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(VALIDATOR_DECLARATION)].map((match) => match[1]!))
  .sort();

describe('every persistence options validator is on the public barrel', () => {
  test('the scan finds the validators of every backend family', () => {
    // Not vacuous: one of each shape the scan has to see — a store validator,
    // a per-backend base, a name with a digit in it.
    expect(exportedValidators).toEqual(expect.arrayContaining([
      'PostgresJournalOptionsValidator',
      'MariaDbOptionsValidatorBase',
      'MsSqlSnapshotStoreOptionsValidator',
      'D1DurableStateStoreOptionsValidator',
    ]));
    expect(exportedValidators.length).toBeGreaterThan(30);
  });

  test.each(exportedValidators)('%s is re-exported by src/persistence/index.ts', (name) => {
    // A validator is how an application checks options before it builds the
    // store, and the subclassing point for a backend of its own: SQL Server
    // had its three on the barrel while the Postgres and MariaDB ones, and
    // all three SQL bases, had none.
    expect(typeof (persistence as Record<string, unknown>)[name]).toBe('function');
  });
});

describe('readStoreBytes', () => {
  const config = Config.parseString(`
    a {
      cap   = 64M
      small = 512KiB
      count = 1024
      wait  = 30s
    }
  `);

  test('reads a size as the byte count its unit names', () => {
    // `64M` is the literal `readStoreInt` refuses outright — "is not a
    // number" — which is why a published size needs a reader of its own.
    expect(readStoreBytes(config, 'a.cap')).toBe(64 * 1024 * 1024);
    expect(readStoreBytes(config, 'a.small')).toBe(512 * 1024);
    expect(readStoreBytes(config, 'a.count')).toBe(1024);
  });

  test('an absent leaf is undefined, so the caller can omit it', () => {
    expect(readStoreBytes(config, 'a.missing')).toBeUndefined();
  });

  test('a duration is refused as the wrong kind rather than read as a count', () => {
    // A reader built on getDuration would take `30s` as 30 000 and `64M` as
    // sixty-four minutes; this is the case that tells the two accessors apart.
    expect(() => readStoreBytes(config, 'a.wait')).toThrow('Unknown size unit');
  });
});

describe('readStoreEnum', () => {
  const SPEEDS = { 'very-fast': 'VERY_FAST', slow: 'SLOW' } as const;

  test('maps a kebab-case value to the spelling its table gives', () => {
    expect(readStoreEnum(Config.parseString('a.speed = very-fast'), 'a.speed', SPEEDS)).toBe('VERY_FAST');
    expect(readStoreEnum(Config.parseString('a.speed = "slow"'), 'a.speed', SPEEDS)).toBe('SLOW');
  });

  test('an absent leaf is undefined, so the caller can omit it', () => {
    expect(readStoreEnum(Config.parseString('a.other = 1'), 'a.speed', SPEEDS)).toBeUndefined();
  });

  test('the spelling code uses is refused, and the message says which value to write instead', () => {
    const config = Config.parseString('a.speed = VERY_FAST');

    expect(() => readStoreEnum(config, 'a.speed', SPEEDS)).toThrow(ConfigError);
    expect(() => readStoreEnum(config, 'a.speed', SPEEDS))
      .toThrow('a.speed must be one of very-fast | slow (got "VERY_FAST")');
    expect(() => readStoreEnum(config, 'a.speed', SPEEDS)).toThrow('write very-fast');
  });

  test('a value outside the table is refused, an inherited name and the empty string included', () => {
    for (const value of ['fast', 'toString', 'constructor', '']) {
      expect(() => readStoreEnum(Config.parseString(`a.speed = "${value}"`), 'a.speed', SPEEDS), value)
        .toThrow('a.speed must be one of very-fast | slow');
    }
  });
});
