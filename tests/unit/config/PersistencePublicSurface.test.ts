import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import * as persistence from '../../../src/persistence/index.js';
import * as storeConfig from '../../../src/persistence/StoreConfig.js';
import { readStoreBytes } from '../../../src/persistence/StoreConfig.js';

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
      'readStoreStringList',
      'readStoreString',
      'storeLeaf',
    ]));
  });

  test.each(seamExports)('%s is re-exported by src/persistence/index.ts', (name, value) => {
    expect((persistence as Record<string, unknown>)[name]).toBe(value);
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
