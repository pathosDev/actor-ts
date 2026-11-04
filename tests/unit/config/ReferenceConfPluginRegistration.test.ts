import { describe, expect, test } from 'bun:test';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';

/**
 * **reference.conf registers a persistence backend through the plugins
 * slot** (#1473).
 *
 * Since #1473 a backend is registered where the system is created, through
 * `ActorSystemOptions.withPersistence({ plugins: [...] })`, and the pages say
 * so.  The comments in reference.conf kept the call #1473 removed —
 * "registerSqlitePlugins(ext) makes this id real", the same for Postgres,
 * Mongo and Cassandra, and "the same registerObjectStoragePlugins() call
 * returns" — and nothing read them: `ReferenceConfDocs` holds the
 * reference-conf pages to `REFERENCE_CONF` byte for byte, so it republishes
 * whatever the comments say, and the docs wiring guard leaves that page to it.
 *
 * So the old wording is refused over `REFERENCE_CONF`, and every
 * `register…Plugins` helper the file names has to be shown passed through the
 * plugins slot.  The pages need no check of their own: they are
 * `REFERENCE_CONF`, byte for byte.
 */

/** The wording reference.conf used for a registration after `create`. */
const RETIRED_REGISTRATIONS: readonly RegExp[] = [
  /\bregister\w+Plugins\(ext\)/,
  /\bregisterObjectStoragePlugins\(\) call returns\b/,
];

/** One line per wording of {@link RETIRED_REGISTRATIONS}, as reference.conf had it before #1473, in that order. */
const RETIRED_LINES: readonly string[] = [
  '      # Local SQLite journal.  registerSqlitePlugins(ext) makes this id real;',
  '      # registerObjectStoragePlugins() call returns: the two share ONE',
];

describe('reference.conf registers a persistence backend through the plugins slot (#1473)', () => {
  test('no comment uses the wording of a registration after create', () => {
    const found = RETIRED_REGISTRATIONS.flatMap((wording) =>
      [...REFERENCE_CONF.matchAll(new RegExp(wording.source, 'g'))].map((match) => match[0]));
    expect(found, 'reference.conf still invites a register…Plugins call after create').toEqual([]);
  });

  test('every register…Plugins helper it names is shown passed through the plugins slot', () => {
    const named = [...new Set([...REFERENCE_CONF.matchAll(/\bregister\w+Plugins\b/g)].map((match) => match[0]))].sort();
    // Guards the guard: the SQLite, PostgreSQL, MongoDB, Cassandra and
    // object-storage blocks each name their helper.
    expect(named.length).toBeGreaterThanOrEqual(5);
    const shown = named.filter((helper) => REFERENCE_CONF.includes(`(persistence) => ${helper}(persistence)`));
    expect(shown, 'helpers reference.conf names but never shows in the plugins slot').toEqual(named);
  });

  test('each retired wording refuses the line it was written in, and no other wording does', () => {
    RETIRED_LINES.forEach((line, index) => {
      expect(RETIRED_REGISTRATIONS.filter((wording) => wording.test(line)).map(String), line)
        .toEqual([String(RETIRED_REGISTRATIONS[index])]);
    });
  });
});
