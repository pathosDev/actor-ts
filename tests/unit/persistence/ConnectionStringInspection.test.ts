import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  PersistenceExtensionId,
  registerMongoPlugins,
  registerMsSqlPlugins,
  registerPostgresPlugins,
  type PersistenceExtension,
} from '../../../src/persistence/index.js';
import {
  adoNetPairs,
  findVerificationOffSwitches,
  refuseVerificationOffUrl,
  urlQueryPairs,
  type InspectedDriver,
  type VerificationLoss,
} from '../../../src/persistence/journals/ConnectionStringInspection.js';
import {
  readMariaDbDurableStateStoreOptionsFromConfig,
  readMariaDbJournalOptionsFromConfig,
  readMariaDbSnapshotStoreOptionsFromConfig,
} from '../../../src/persistence/journals/MariaDbPluginOptions.js';
import { MongoJournal } from '../../../src/persistence/journals/MongoJournal.js';
import { MongoJournalOptions } from '../../../src/persistence/journals/MongoJournalOptions.js';
import {
  readMongoDurableStateStoreOptionsFromConfig,
  readMongoJournalOptionsFromConfig,
  readMongoSnapshotStoreOptionsFromConfig,
} from '../../../src/persistence/journals/MongoPluginOptions.js';
import { MsSqlJournal } from '../../../src/persistence/journals/MsSqlJournal.js';
import { MsSqlJournalOptions } from '../../../src/persistence/journals/MsSqlJournalOptions.js';
import {
  readMsSqlDurableStateStoreOptionsFromConfig,
  readMsSqlJournalOptionsFromConfig,
  readMsSqlSnapshotStoreOptionsFromConfig,
} from '../../../src/persistence/journals/MsSqlPluginOptions.js';
import { PostgresJournal } from '../../../src/persistence/journals/PostgresJournal.js';
import { PostgresJournalOptions } from '../../../src/persistence/journals/PostgresJournalOptions.js';
import {
  readPostgresDurableStateStoreOptionsFromConfig,
  readPostgresJournalOptionsFromConfig,
  readPostgresSnapshotStoreOptionsFromConfig,
} from '../../../src/persistence/journals/PostgresPluginOptions.js';
import { MongoSnapshotStore } from '../../../src/persistence/snapshot-stores/MongoSnapshotStore.js';
import { MongoSnapshotStoreOptions } from '../../../src/persistence/snapshot-stores/MongoSnapshotStoreOptions.js';
import { MsSqlSnapshotStore } from '../../../src/persistence/snapshot-stores/MsSqlSnapshotStore.js';
import { MsSqlSnapshotStoreOptions } from '../../../src/persistence/snapshot-stores/MsSqlSnapshotStoreOptions.js';
import { PostgresSnapshotStore } from '../../../src/persistence/snapshot-stores/PostgresSnapshotStore.js';
import { PostgresSnapshotStoreOptions } from '../../../src/persistence/snapshot-stores/PostgresSnapshotStoreOptions.js';
import { MongoDurableStateStore } from '../../../src/persistence/durable-state-stores/MongoDurableStateStore.js';
import { MongoDurableStateStoreOptions } from '../../../src/persistence/durable-state-stores/MongoDurableStateStoreOptions.js';
import { MsSqlDurableStateStore } from '../../../src/persistence/durable-state-stores/MsSqlDurableStateStore.js';
import { MsSqlDurableStateStoreOptions } from '../../../src/persistence/durable-state-stores/MsSqlDurableStateStoreOptions.js';
import { PostgresDurableStateStore } from '../../../src/persistence/durable-state-stores/PostgresDurableStateStore.js';
import { PostgresDurableStateStoreOptions } from '../../../src/persistence/durable-state-stores/PostgresDurableStateStoreOptions.js';

/**
 * #1490 — a connection string read from HOCON may not switch TLS verification
 * off, while the same string written in code is the code's own decision.
 *
 * Every url below carries a password, `s3cret`, so that the refusal can be
 * checked for the property its message promises and a careless rewrite would
 * break first: it names the leaf and the switch, never the url.
 *
 * The spellings in {@link REFUSED} are not the issue's guesses.  Those marked
 * as the driver's own were run through the real parser when the module was
 * written — pg 8.23 over pg-connection-string 2.14, @tediousjs/connection-string
 * 1.1 as node-mssql 12.7 reads it, mongodb 6.21 and 7.6 — and every one of them
 * came back with verification off.  The rest are variants the pinned driver
 * ignores and the module refuses all the same.  The drivers are not installed
 * at the root, so this file pins the vocabulary rather than the drivers.
 */

const PASSWORD = 's3cret';
const TLS_PAGE = 'https://actor-ts.dev/operations/security/tls-everywhere/';

const POSTGRES = `postgres://app:${PASSWORD}@db.example.com:5432/app`;
const MSSQL = `Server=db.example.com;Database=app;User Id=app;Password=${PASSWORD}`;
const MONGO = `mongodb://app:${PASSWORD}@db.example.com:27017/app`;

/** `[url, the switch's spelling in the refusal, what it costs]`. */
type RefusedCase = readonly [string, string, VerificationLoss];

/** Every spelling each driver turns into "verification off", and the variants refused on top. */
const REFUSED: Readonly<Record<InspectedDriver, ReadonlyArray<RefusedCase>>> = {
  postgres: [
    // The driver's own.
    [`${POSTGRES}?sslmode=no-verify`, 'sslmode=no-verify', 'certificate'],
    [`${POSTGRES}?ssl=no-verify`, 'ssl=no-verify', 'certificate'],
    [`${POSTGRES}?uselibpqcompat=true&sslmode=prefer`, 'uselibpqcompat=true&sslmode=prefer', 'certificate'],
    [`${POSTGRES}?uselibpqcompat=true&sslmode=require`, 'uselibpqcompat=true&sslmode=require', 'certificate'],
    [
      `${POSTGRES}?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=/etc/ssl/rds-ca.pem`,
      'uselibpqcompat=true&sslmode=verify-ca',
      'hostname',
    ],
    // libpq's `require` with a root certificate is its `verify-ca`: the chain
    // is checked, the hostname is not (pg-connection-string index.js:115-121).
    [
      `${POSTGRES}?uselibpqcompat=true&sslmode=require&sslrootcert=/etc/ssl/rds-ca.pem`,
      'uselibpqcompat=true&sslmode=require',
      'hostname',
    ],
    [`${POSTGRES}?sslmode=prefer&uselibpqcompat=true`, 'uselibpqcompat=true&sslmode=prefer', 'certificate'],
    [`${POSTGRES}?sslmode=no%2Dverify`, 'sslmode=no-verify', 'certificate'],
    [`${POSTGRES}?ssl%6Dode=no-verify`, 'sslmode=no-verify', 'certificate'],
    // The URL parser removes tabs and newlines and strips a trailing control
    // character, and HOCON's `\t`, `\n` and `\u0001` escapes can put them there.
    [`${POSTGRES}?sslmode=no-\tverify`, 'sslmode=no-verify', 'certificate'],
    [`${POSTGRES}?sslmode=no-\nverify`, 'sslmode=no-verify', 'certificate'],
    [`${POSTGRES}?sslmode=no-verify\u0001`, 'sslmode=no-verify', 'certificate'],
    // The driver takes the last occurrence.
    [`${POSTGRES}?sslmode=verify-full&sslmode=no-verify`, 'sslmode=no-verify', 'certificate'],
    // Refused on top: case, surrounding whitespace, a repeat the driver overrides.
    [`${POSTGRES}?sslmode=NO-VERIFY`, 'sslmode=no-verify', 'certificate'],
    [`${POSTGRES}?SSLMODE=no-verify`, 'SSLMODE=no-verify', 'certificate'],
    [`${POSTGRES}?sslmode=%20no-verify%20`, 'sslmode=no-verify', 'certificate'],
    [`${POSTGRES}?sslmode=no-verify+`, 'sslmode=no-verify', 'certificate'],
    [`${POSTGRES}?sslmode=no-verify&sslmode=verify-full`, 'sslmode=no-verify', 'certificate'],
    [`${POSTGRES}?uselibpqcompat=TRUE&sslmode=Require`, 'uselibpqcompat=true&sslmode=require', 'certificate'],
  ],
  mssql: [
    // The driver's own: every value but false / no / 0 / empty reads as true.
    [`${MSSQL};TrustServerCertificate=true`, 'TrustServerCertificate=true', 'certificate'],
    [`${MSSQL};TrustServerCertificate=yes`, 'TrustServerCertificate=true', 'certificate'],
    [`${MSSQL};trustservercertificate=TRUE`, 'trustservercertificate=true', 'certificate'],
    [`${MSSQL};TRUSTSERVERCERTIFICATE=Yes`, 'TRUSTSERVERCERTIFICATE=true', 'certificate'],
    [`${MSSQL};TrustServerCertificate=1`, 'TrustServerCertificate=true', 'certificate'],
    [`${MSSQL};TrustServerCertificate=on`, 'TrustServerCertificate=true', 'certificate'],
    [`${MSSQL}; TrustServerCertificate = true ;`, 'TrustServerCertificate=true', 'certificate'],
    [`${MSSQL};TrustServerCertificate={true}`, 'TrustServerCertificate=true', 'certificate'],
    [`${MSSQL};TrustServerCertificate='true'`, 'TrustServerCertificate=true', 'certificate'],
    // Quoted, so not trimmed: the driver reads " false" as true.
    [`${MSSQL};TrustServerCertificate=" false"`, 'TrustServerCertificate=true', 'certificate'],
    [`${MSSQL};TrustServerCertificate=false;TrustServerCertificate=true`, 'TrustServerCertificate=true', 'certificate'],
    // Refused on top: a repeat the driver overrides, and .NET's spelling of the key.
    [`${MSSQL};TrustServerCertificate=true;TrustServerCertificate=false`, 'TrustServerCertificate=true', 'certificate'],
    [`${MSSQL};Trust Server Certificate=true`, 'Trust Server Certificate=true', 'certificate'],
    // The mssql:// form the docs name for this leaf: node-mssql 8+ parses no
    // URL at all, so this reaches no server — and is refused all the same.
    [`mssql://app:${PASSWORD}@db.example.com:1433/app?trustServerCertificate=true`, 'trustServerCertificate=true', 'certificate'],
  ],
  mongodb: [
    // The driver's own: option names match case-insensitively.
    [`${MONGO}?tlsInsecure=true`, 'tlsInsecure=true', 'certificate'],
    [`${MONGO}?TLSINSECURE=true`, 'TLSINSECURE=true', 'certificate'],
    [`${MONGO}?tlsAllowInvalidCertificates=true`, 'tlsAllowInvalidCertificates=true', 'certificate'],
    [`${MONGO}?tlsallowinvalidcertificates=true`, 'tlsallowinvalidcertificates=true', 'certificate'],
    [`${MONGO}?tlsAllowInvalidHostnames=true`, 'tlsAllowInvalidHostnames=true', 'hostname'],
    [`${MONGO}?TLSALLOWINVALIDHOSTNAMES=true`, 'TLSALLOWINVALIDHOSTNAMES=true', 'hostname'],
    [`${MONGO}?tlsInsecure=%74rue`, 'tlsInsecure=true', 'certificate'],
    [`${MONGO}?tls%49nsecure=true`, 'tlsInsecure=true', 'certificate'],
    [`${MONGO}?tls=true&tlsInsecure=true`, 'tlsInsecure=true', 'certificate'],
    [`mongodb+srv://app:${PASSWORD}@cluster.example.com/app?tlsInsecure=true`, 'tlsInsecure=true', 'certificate'],
    [
      `mongodb://app:${PASSWORD}@h1.example.com:27017,h2.example.com:27017/app?replicaSet=rs&tlsInsecure=true`,
      'tlsInsecure=true',
      'certificate',
    ],
    // Refused on top: the driver throws on a value that is not exactly `true` or `false`.
    [`${MONGO}?tlsInsecure=TRUE`, 'tlsInsecure=true', 'certificate'],
  ],
};

/**
 * What stays allowed: the verifying shapes, and plaintext — no TLS is a
 * different decision from TLS that authenticates nobody, and it reads as what
 * it is.
 */
const ACCEPTED: Readonly<Record<InspectedDriver, ReadonlyArray<string>>> = {
  postgres: [
    POSTGRES,
    `${POSTGRES}?sslmode=verify-full`,
    `${POSTGRES}?sslmode=verify-full&sslrootcert=/etc/ssl/rds-ca.pem`,
    `${POSTGRES}?sslmode=disable`,
    `${POSTGRES}?ssl=false`,
    `${POSTGRES}?ssl=true`,
    // Without uselibpqcompat, pg 8 reads these as verify-full.
    `${POSTGRES}?sslmode=require`,
    `${POSTGRES}?sslmode=verify-ca`,
    `${POSTGRES}?uselibpqcompat=true&sslmode=verify-full`,
    `${POSTGRES}?uselibpqcompat=true&sslmode=disable`,
    `${POSTGRES}?application_name=no-verify`,
  ],
  mssql: [
    MSSQL,
    `${MSSQL};Encrypt=true`,
    `${MSSQL};Encrypt=false`,
    `${MSSQL};Encrypt=true;TrustServerCertificate=false`,
    `${MSSQL};TrustServerCertificate=False`,
    `${MSSQL};TrustServerCertificate=no`,
    `${MSSQL};TrustServerCertificate=0`,
    `${MSSQL};TrustServerCertificate=`,
    // A switch inside a quoted password is part of the password.
    `Server=db.example.com;Password="x;TrustServerCertificate=true"`,
    `Server=db.example.com;Password={x;TrustServerCertificate=true}`,
    // And a `?` in an ADO.NET password does not start a URL query.
    `Server=db.example.com;Password=a?TrustServerCertificate=true`,
    `mssql://app:${PASSWORD}@db.example.com:1433/app?encrypt=true`,
  ],
  mongodb: [
    MONGO,
    `${MONGO}?tls=true&tlsCAFile=/etc/ssl/ca.pem`,
    `${MONGO}?tls=false`,
    `${MONGO}?ssl=false`,
    `${MONGO}?tlsInsecure=false`,
    `${MONGO}?tlsAllowInvalidCertificates=false`,
    `${MONGO}?tlsAllowInvalidHostnames=FALSE`,
  ],
};

const DRIVERS: ReadonlyArray<InspectedDriver> = ['postgres', 'mssql', 'mongodb'];

describe('the switches that turn verification off, per driver (#1490)', () => {
  for (const driver of DRIVERS) {
    test.each([...REFUSED[driver]])(`${driver}: %p is a switch`, (url, spelling, loses) => {
      expect(findVerificationOffSwitches(driver, url)).toContainEqual({ spelling, loses });
    });

    test.each([...ACCEPTED[driver]])(`${driver}: %p carries none`, (url) => {
      expect(findVerificationOffSwitches(driver, url)).toEqual([]);
    });
  }

  test('a string carrying two switches reports both, in order', () => {
    expect(findVerificationOffSwitches('mongodb', `${MONGO}?tlsAllowInvalidHostnames=true&tlsAllowInvalidCertificates=true`))
      .toEqual([
        { spelling: 'tlsAllowInvalidHostnames=true', loses: 'hostname' },
        { spelling: 'tlsAllowInvalidCertificates=true', loses: 'certificate' },
      ]);
  });

  test('a prototype key is not a switch', () => {
    expect(findVerificationOffSwitches('mongodb', `${MONGO}?constructor=true&__proto__=true`)).toEqual([]);
  });

  test('the drivers do not share a vocabulary', () => {
    // A rule applied to the wrong driver would refuse these: each string is
    // another driver's switch, and means nothing to the one it is given to.
    expect(findVerificationOffSwitches('postgres', `${POSTGRES}?tlsInsecure=true&TrustServerCertificate=true`)).toEqual([]);
    expect(findVerificationOffSwitches('mssql', `${MSSQL};sslmode=no-verify;tlsInsecure=true`)).toEqual([]);
    expect(findVerificationOffSwitches('mongodb', `${MONGO}?sslmode=no-verify&TrustServerCertificate=true`)).toEqual([]);
  });
});

describe('the strings are read the way their drivers read them', () => {
  test.each([
    ['a value opened by a terminator runs on to the next one', 'a=;b=c', [['a', ';b=c']]],
    ['a doubled terminator is a literal', 'a=x;;y;b=c', [['a', 'x;y'], ['b', 'c']]],
    ['a doubled = is a literal in a key', 'a==b=c', [['a=b', 'c']]],
    ['a quoted value keeps its terminator and its spaces', 'a=" x;y ";b=c', [['a', ' x;y '], ['b', 'c']]],
    ['a brace-quoted value escapes its closing brace by doubling it', 'a={x}}y};b=c', [['a', 'x}y'], ['b', 'c']]],
    ['an unquoted value is trimmed', 'a =  x  ;', [['a', 'x']]],
    ['repeats are all kept, in order', 'a=1;a=2', [['a', '1'], ['a', '2']]],
    ['text after a closing quote stops the parse, as the driver throws there', 'a="x"y;b=c', []],
    ['an unterminated quote stops the parse too', 'a=1;b="x', [['a', '1']]],
  ])('ADO.NET: %s', (_name, connectionString, expected) => {
    expect(adoNetPairs(connectionString).map(({ key, value }) => [key, value])).toEqual(expected);
  });

  test.each([
    ['the query only, never the fragment', 'postgres://h/db?a=1&b=2#c=3', [['a', '1'], ['b', '2']]],
    ['no query, no pairs', 'postgres://h/db', []],
    ['percent-encoding and + are decoded', 'postgres://h/db?a%62=x+y%21', [['ab', 'x y!']]],
    ['tabs and newlines are removed, as the URL parser removes them', 'postgres://h/db?a=x\ty\nz', [['a', 'xyz']]],
    ['a multi-host seed list does not stop the read', 'mongodb://h1:1,h2:2/db?a=1', [['a', '1']]],
  ])('URL: %s', (_name, url, expected) => {
    expect(urlQueryPairs(url).map(({ key, value }) => [key, value])).toEqual(expected);
  });

  test('no input makes the inspection throw', () => {
    fc.assert(
      fc.property(fc.constantFrom(...DRIVERS), fc.string({ maxLength: 80 }), (driver, url) => {
        findVerificationOffSwitches(driver, url);
      }),
    );
  });

  test('a refused switch stays refused in any letter case', () => {
    const cases = DRIVERS.flatMap((driver) => REFUSED[driver].map(([url]) => [driver, url] as const));
    fc.assert(
      fc.property(
        fc.constantFrom(...cases),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 200 }),
        ([driver, url], flips) => {
          // Only the query, or the pairs, are recased: a scheme in capitals is
          // a different url, and the password is not part of any switch.
          const split = driver === 'mssql' ? 0 : url.indexOf('?') + 1;
          const recased = url.slice(0, split) + [...url.slice(split)]
            .map((character, index) => (flips[index % flips.length] ? character.toUpperCase() : character.toLowerCase()))
            .join('');
          expect(findVerificationOffSwitches(driver, recased).length).toBeGreaterThan(0);
        },
      ),
    );
  });
});

describe('the refusal names the leaf and the switch, never the url', () => {
  const keyPath = 'actor-ts.persistence.journal.postgres.url';

  test.each(DRIVERS.map((driver) => [driver, REFUSED[driver][0]!] as const))(
    '%s',
    (driver, [url, spelling]) => {
      let refusal: unknown;
      try {
        refuseVerificationOffUrl(driver, url, keyPath);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(ConfigError);
      const message = (refusal as ConfigError).message;
      expect(message).toContain(`Config at "${keyPath}"`);
      expect(message).toContain(`"${spelling}"`);
      expect(message).toContain('withUrl(');
      expect(message).toContain(TLS_PAGE);
      expect(message).not.toContain(PASSWORD);
    },
  );

  test('a verifying url passes', () => {
    for (const driver of DRIVERS) {
      for (const url of ACCEPTED[driver]) expect(() => refuseVerificationOffUrl(driver, url, keyPath)).not.toThrow();
    }
  });

  test('a run-on SQL Server value is not echoed', () => {
    // A missing `;` lets the next pair run into the switch's value; the
    // refusal quotes the driver's reading, `true`, never what was written.
    let message = '';
    try {
      refuseVerificationOffUrl('mssql', `Server=h;TrustServerCertificate=yes Password=${PASSWORD}`, keyPath);
    } catch (error) {
      message = (error as ConfigError).message;
    }
    expect(message).toContain('"TrustServerCertificate=true"');
    expect(message).not.toContain(PASSWORD);
  });
});

type ReaderCase = {
  readonly name: string;
  readonly driver: InspectedDriver;
  readonly root: string;
  readonly read: (config: Config, blockRoot?: string) => { readonly url?: string };
};

/** The nine HOCON readers whose driver reads a verification switch out of the url. */
const READERS: ReadonlyArray<ReaderCase> = [
  { name: 'postgres journal', driver: 'postgres', root: ConfigKeys.persistence.journal.postgres.root, read: readPostgresJournalOptionsFromConfig },
  { name: 'postgres snapshot store', driver: 'postgres', root: ConfigKeys.persistence.snapshotStore.postgres.root, read: readPostgresSnapshotStoreOptionsFromConfig },
  { name: 'postgres durable state', driver: 'postgres', root: ConfigKeys.persistence.durableState.postgres.root, read: readPostgresDurableStateStoreOptionsFromConfig },
  { name: 'mssql journal', driver: 'mssql', root: ConfigKeys.persistence.journal.mssql.root, read: readMsSqlJournalOptionsFromConfig },
  { name: 'mssql snapshot store', driver: 'mssql', root: ConfigKeys.persistence.snapshotStore.mssql.root, read: readMsSqlSnapshotStoreOptionsFromConfig },
  { name: 'mssql durable state', driver: 'mssql', root: ConfigKeys.persistence.durableState.mssql.root, read: readMsSqlDurableStateStoreOptionsFromConfig },
  { name: 'mongodb journal', driver: 'mongodb', root: ConfigKeys.persistence.journal.mongodb.root, read: readMongoJournalOptionsFromConfig },
  { name: 'mongodb snapshot store', driver: 'mongodb', root: ConfigKeys.persistence.snapshotStore.mongodb.root, read: readMongoSnapshotStoreOptionsFromConfig },
  { name: 'mongodb durable state', driver: 'mongodb', root: ConfigKeys.persistence.durableState.mongodb.root, read: readMongoDurableStateStoreOptionsFromConfig },
];

/** A block whose `url` leaf is exactly `url` — JSON's quoting is HOCON's. */
const blockWithUrl = (root: string, url: string): Config => Config.parseString(`${root}.url = ${JSON.stringify(url)}`);

/** The `ConfigError` `read` throws, or a failure naming that nothing was thrown. */
function refusalOf(read: () => unknown): ConfigError {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected the reader to refuse the url with a ConfigError, and it returned');
}

describe('the nine HOCON readers refuse a url that switches verification off (#1490)', () => {
  for (const reader of READERS) {
    test.each([...REFUSED[reader.driver]])(`${reader.name}: %p`, (url, spelling) => {
      const refusal = refusalOf(() => reader.read(blockWithUrl(reader.root, url)));

      expect(refusal.message).toContain(`Config at "${reader.root}.url"`);
      expect(refusal.message).toContain(`"${spelling}"`);
      expect(refusal.message).toContain('withUrl(');
      expect(refusal.message).toContain(TLS_PAGE);
      // The url carries credentials; the refusal names the leaf instead.
      expect(refusal.message).not.toContain(PASSWORD);
    });

    test(`${reader.name}: a verifying url is read as before`, () => {
      for (const url of ACCEPTED[reader.driver]) {
        expect(reader.read(blockWithUrl(reader.root, url)).url).toBe(url);
      }
    });

    test(`${reader.name}: a block under a custom plug-in id is refused at its own path`, () => {
      const customRoot = reader.root.replace(/\.[a-z]+$/, '.tenant-a');
      const [url] = REFUSED[reader.driver][0]!;
      const refusal = refusalOf(() => reader.read(blockWithUrl(customRoot, url), customRoot));
      expect(refusal.message).toContain(`Config at "${customRoot}.url"`);
    });
  }

  test('a substituted url is inspected like a written one', () => {
    const variable = 'ACTOR_TS_I1490_DATABASE_URL';
    const previous = process.env[variable];
    process.env[variable] = `${POSTGRES}?sslmode=no-verify`;
    try {
      const config = Config.parseString(`${ConfigKeys.persistence.journal.postgres.root}.url = \${?${variable}}`);
      const refusal = refusalOf(() => readPostgresJournalOptionsFromConfig(config));
      expect(refusal.message).toContain('"sslmode=no-verify"');
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });

  test('an empty url is still unset rather than inspected', () => {
    for (const reader of READERS) {
      expect(reader.read(blockWithUrl(reader.root, '')).url).toBeUndefined();
    }
  });
});

describe('a MariaDB url is never inspected', () => {
  // Its url's `ssl` is a boolean to the connector, so there is no switch to
  // refuse; this string carries every other driver's, and must pass verbatim.
  const url = `mariadb://app:${PASSWORD}@db.example.com:3306/app?ssl=true&sslmode=no-verify&tlsInsecure=true&TrustServerCertificate=true`;
  test.each([
    ['journal', ConfigKeys.persistence.journal.mariadb.root, readMariaDbJournalOptionsFromConfig],
    ['snapshot store', ConfigKeys.persistence.snapshotStore.mariadb.root, readMariaDbSnapshotStoreOptionsFromConfig],
    ['durable state', ConfigKeys.persistence.durableState.mariadb.root, readMariaDbDurableStateStoreOptionsFromConfig],
  ])('%s', (_name, root, read) => {
    expect(read(blockWithUrl(root, url)).url).toBe(url);
  });
});

describe('the same url set in code is the code\'s decision (#878)', () => {
  const postgresUrl = `${POSTGRES}?sslmode=no-verify`;
  const msSqlUrl = `${MSSQL};TrustServerCertificate=true`;
  const mongoUrl = `${MONGO}?tlsInsecure=true`;

  test.each([
    ['PostgresJournal', () => new PostgresJournal(PostgresJournalOptions.create().withUrl(postgresUrl))],
    ['PostgresSnapshotStore', () => new PostgresSnapshotStore(PostgresSnapshotStoreOptions.create().withUrl(postgresUrl))],
    ['PostgresDurableStateStore', () => new PostgresDurableStateStore(PostgresDurableStateStoreOptions.create().withUrl(postgresUrl))],
    ['MsSqlJournal', () => new MsSqlJournal(MsSqlJournalOptions.create().withUrl(msSqlUrl))],
    ['MsSqlSnapshotStore', () => new MsSqlSnapshotStore(MsSqlSnapshotStoreOptions.create().withUrl(msSqlUrl))],
    ['MsSqlDurableStateStore', () => new MsSqlDurableStateStore(MsSqlDurableStateStoreOptions.create().withUrl(msSqlUrl))],
    ['MongoJournal', () => new MongoJournal(MongoJournalOptions.create().withUrl(mongoUrl))],
    ['MongoSnapshotStore', () => new MongoSnapshotStore(MongoSnapshotStoreOptions.create().withUrl(mongoUrl))],
    ['MongoDurableStateStore', () => new MongoDurableStateStore(MongoDurableStateStoreOptions.create().withUrl(mongoUrl))],
  ])('%s constructs from withUrl', (_name, construct) => {
    expect(construct).not.toThrow();
  });
});

/** The three backends this refusal covers, as their plug-ins see them. */
type PluginCase = {
  readonly name: string;
  readonly pluginId: string;
  readonly refusedUrl: string;
  readonly verifyingUrl: string;
  readonly register: (persistence: PersistenceExtension, journalUrl: string) => void;
};

const PLUGINS: ReadonlyArray<PluginCase> = [
  {
    name: 'postgres',
    pluginId: ConfigKeys.persistence.journal.postgres.root,
    refusedUrl: `${POSTGRES}?sslmode=no-verify`,
    verifyingUrl: `${POSTGRES}?sslmode=verify-full`,
    register: (persistence, url) => registerPostgresPlugins(persistence, { journal: { url } }),
  },
  {
    name: 'mssql',
    pluginId: ConfigKeys.persistence.journal.mssql.root,
    refusedUrl: `${MSSQL};TrustServerCertificate=true`,
    verifyingUrl: `${MSSQL};Encrypt=true`,
    register: (persistence, url) => registerMsSqlPlugins(persistence, { journal: { url } }),
  },
  {
    name: 'mongodb',
    pluginId: ConfigKeys.persistence.journal.mongodb.root,
    refusedUrl: `${MONGO}?tlsInsecure=true`,
    verifyingUrl: `${MONGO}?tls=true`,
    register: (persistence, url) => registerMongoPlugins(persistence, { journal: { url } }),
  },
];

/** A system whose journal axis selects `pluginId`, with `block` as that plug-in's own block. */
function systemSelecting(name: string, pluginId: string, block: string): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(`actor-ts.persistence.journal.plugin = "${pluginId}"\n${pluginId} {\n${block}\n}`));
  return ActorSystem.create(`connection-string-inspection-${name}`, options);
}

describe('through the plug-in: strict for the file, silent for code', () => {
  for (const plugin of PLUGINS) {
    test(`${plugin.name}: a url in code does not excuse the block's`, async () => {
      const system = systemSelecting(plugin.name, plugin.pluginId, `url = ${JSON.stringify(plugin.refusedUrl)}`);
      try {
        const persistence = system.extension(PersistenceExtensionId);
        plugin.register(persistence, plugin.verifyingUrl);
        expect(() => persistence.journal).toThrow(ConfigError);
      } finally {
        await system.terminate();
      }
    });

    test(`${plugin.name}: the url in code alone builds the journal`, async () => {
      const system = systemSelecting(plugin.name, plugin.pluginId, '');
      try {
        const persistence = system.extension(PersistenceExtensionId);
        plugin.register(persistence, plugin.refusedUrl);
        expect(() => persistence.journal).not.toThrow();
      } finally {
        await system.terminate();
      }
    });
  }
});
