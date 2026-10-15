import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { PersistenceExtensionId, registerMongoPlugins } from '../../../src/persistence/index.js';
import { MongoDurableStateStore } from '../../../src/persistence/durable-state-stores/MongoDurableStateStore.js';
import { MongoDurableStateStoreOptionsValidator } from '../../../src/persistence/durable-state-stores/MongoDurableStateStoreOptions.js';
import { MongoJournal } from '../../../src/persistence/journals/MongoJournal.js';
import { assertMongoUrl, MongoJournalOptionsValidator } from '../../../src/persistence/journals/MongoJournalOptions.js';
import {
  readMongoDurableStateStoreOptionsFromConfig,
  readMongoJournalOptionsFromConfig,
  readMongoSnapshotStoreOptionsFromConfig,
} from '../../../src/persistence/journals/MongoPluginOptions.js';
import { MongoSnapshotStore } from '../../../src/persistence/snapshot-stores/MongoSnapshotStore.js';
import { MongoSnapshotStoreOptionsValidator } from '../../../src/persistence/snapshot-stores/MongoSnapshotStoreOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * #1490 — the MongoDB url rule reads a connection string the way the format
 * defines it, so a replica-set seed list reaches the three stores.
 *
 * `assertMongoUrl` used to hand the whole string to `new URL(...)`.  A WHATWG
 * URL has one host, so `mongodb://h1:27017,h2:27017/app?replicaSet=rs` — the
 * only way to name a replica set without SRV — threw, and the journal, the
 * snapshot store and the durable-state store all refused a url the driver
 * accepts.  The ports are what broke it: `h1,h2` alone parses as one opaque
 * host, which is how the defect outlived every seed list written without them.
 *
 * Every verdict below was checked against the driver's own parser —
 * `new MongoClient(url)` in mongodb 6.21 and 7.6, which parses without
 * connecting — when this file was written.  Where the rule departs from it,
 * the row says so.
 */

/** Every url that carries credentials carries this password, so a message can be checked for it. */
const PASSWORD = 's3cret';

const NOT_A_URL = 'must be a valid URL';
const NOT_MONGO = 'must use protocol mongodb, mongodb+srv';
const SRV_ONE_HOST = 'must name exactly one host when the protocol is mongodb+srv';
const SRV_NO_IP_LITERAL = 'must name a DNS name, not an IP literal, when the protocol is mongodb+srv';
const SRV_NO_PORT = 'must not name a port when the protocol is mongodb+srv';

/** The three option families that share the rule, by the validator each store runs at construction. */
const VALIDATORS: ReadonlyArray<readonly [string, (url: string) => void]> = [
  ['MongoJournalOptions', (url) => new MongoJournalOptionsValidator().validate({ url })],
  ['MongoSnapshotStoreOptions', (url) => new MongoSnapshotStoreOptionsValidator().validate({ url })],
  ['MongoDurableStateStoreOptions', (url) => new MongoDurableStateStoreOptionsValidator().validate({ url })],
];

/** Replica-set seed lists without SRV — the shapes #1490 found refused. */
const SEED_LISTS: ReadonlyArray<string> = [
  'mongodb://h1.example.com:27017,h2.example.com:27017/app?replicaSet=rs',
  'mongodb://h1.example.com:27017,h2.example.com:27017,h3.example.com:27017/app?replicaSet=rs',
  `mongodb://app:${PASSWORD}@h1.example.com:27017,h2.example.com:27017/app?replicaSet=rs`,
  `mongodb://app:${PASSWORD}@h1.example.com:27017,h2.example.com:27017,h3.example.com:27017/app?replicaSet=rs&authSource=admin`,
];

/** The other shapes the format admits, each accepted by the driver as well. */
const ACCEPTED: ReadonlyArray<readonly [string, string]> = [
  ['a seed list without ports', 'mongodb://h1.example.com,h2.example.com/app?replicaSet=rs'],
  ['options without the slash before them', 'mongodb://h1.example.com:27017,h2.example.com:27017?replicaSet=rs'],
  ['neither database nor options', 'mongodb://h1.example.com:27017,h2.example.com:27017'],
  ['IPv4, an IP literal and a host name mixed', 'mongodb://127.0.0.1,[::1]:27018,example.com:27019'],
  ['IP literals only', 'mongodb://[::1]:27017,[::1]:27018/app?replicaSet=rs'],
  ['internationalised host names', 'mongodb://bücher.example.com,umläut.example.com/'],
  ['an underscore in a host name', 'mongodb://mongo_1:27017,mongo_2:27017/app'],
  ['a percent-encoded UNIX domain socket beside a host', 'mongodb://%2Ftmp%2Fmongodb-27017.sock,h2.example.com:27017/app'],
  ['percent-encoded delimiters in the userinfo', 'mongodb://%40l%3Ace%2F%3D:secret@h1.example.com,h2.example.com/app'],
  ['a username without a password', 'mongodb://app@h1.example.com,h2.example.com/app'],
  ['an empty password', 'mongodb://app:@h1.example.com,h2.example.com/app'],
  [
    'commas and colons in an option value, which are not hosts',
    `mongodb://user%40EXAMPLE.COM:${PASSWORD}@h1.example.com,h2.example.com/?authMechanism=GSSAPI&authMechanismProperties=SERVICE_NAME:other,CANONICALIZE_HOST_NAME:true`,
  ],
  [
    'an @ in an option value, which is not the userinfo',
    `mongodb://app:${PASSWORD}@h1.example.com:27017,h2.example.com:27017/app?replicaSet=rs&appName=ops@example`,
  ],
  ['the highest port', 'mongodb://h1.example.com:65535'],
  ['an empty port, which the driver reads as its default', 'mongodb://h1.example.com:,h2.example.com/app'],
  ['a trailing newline, which the driver drops before it reads a host', 'mongodb://h1.example.com:27017,h2.example.com:27017\n'],
  ['one SRV name', 'mongodb+srv://cluster.example.net'],
  ['one SRV name with userinfo and options', `mongodb+srv://app:${PASSWORD}@cluster.example.net/app?retryWrites=true`],
];

/** `[what is wrong, url, the reason the refusal gives]` — every one refused by the driver as well, unless the row says otherwise. */
const REFUSED: ReadonlyArray<readonly [string, string, string]> = [
  ['an empty url', '', NOT_A_URL],
  ['no url at all', 'not a url', NOT_A_URL],
  ['a scheme without its //', 'mongodb:h1.example.com/app', NOT_A_URL],
  ['whitespace before the scheme', ' mongodb://h1.example.com/app', NOT_A_URL],
  ['no host', 'mongodb://', NOT_A_URL],
  ['no host before the database', 'mongodb:///app', NOT_A_URL],
  ['a socket path with its slashes unescaped', 'mongodb:///tmp/mongodb-27017.sock/', NOT_A_URL],
  // The driver dials an empty entry as localhost:27017; the format has no
  // empty host, and a stray comma is not a request for the local machine.
  ['an empty entry in the seed list (the driver dials localhost)', 'mongodb://h1.example.com,,h2.example.com/app', NOT_A_URL],
  ['a trailing comma (the driver dials localhost)', 'mongodb://h1.example.com:27017,/app', NOT_A_URL],
  ['a port with no host', 'mongodb://h1.example.com:27017,:27018/app', NOT_A_URL],
  ['port zero', 'mongodb://h1.example.com:27017,h2.example.com:0/app', NOT_A_URL],
  ['port zero on an IP literal', 'mongodb://[::1]:0/', NOT_A_URL],
  ['a port past 65535', 'mongodb://h1.example.com:65536', NOT_A_URL],
  ['a negative port', 'mongodb://h1.example.com:-1', NOT_A_URL],
  ['a port that is not a number', 'mongodb://h1.example.com:foo', NOT_A_URL],
  ['a doubled colon', 'mongodb://localhost::27017', NOT_A_URL],
  ['an unclosed IP literal', 'mongodb://[::1', NOT_A_URL],
  ['text after an IP literal', 'mongodb://[::1]x/app', NOT_A_URL],
  ['an empty IP literal', 'mongodb://[]/app', NOT_A_URL],
  ['an IPv6 zone, which the driver cannot parse', 'mongodb://[fe80::1%25eth0]:27017/app', NOT_A_URL],
  // The driver escapes the space and dials " h2.example.com", which no
  // resolver answers for; a host name cannot contain one.
  ['a space after a comma (the driver dials " h2")', 'mongodb://h1.example.com, h2.example.com/app', NOT_A_URL],
  ['a space after a port', 'mongodb://h1.example.com:27017 ', NOT_A_URL],
  ['a quote in a host (the driver dials it)', 'mongodb://h"1.example.com/app', NOT_A_URL],
  ['a brace in a host (the driver dials it)', 'mongodb://h{1}.example.com/app', NOT_A_URL],
  ['a backslash in a host', 'mongodb://h1\\h2/app', NOT_A_URL],
  ['a malformed escape in a host', 'mongodb://h%zz1/app', NOT_A_URL],
  ['an escape that is not UTF-8', 'mongodb://h%FF/app', NOT_A_URL],
  ['an empty userinfo', 'mongodb://@h1.example.com/app', NOT_A_URL],
  ['an empty username', `mongodb://:${PASSWORD}@h1.example.com/app`, NOT_A_URL],
  ['two @ in a row', 'mongodb://alice@@127.0.0.1', NOT_A_URL],
  // mongodb 6.21 accepts this one and dials "ss"; 7.6 refuses it.
  ['an unescaped @ in the password', 'mongodb://alice:p@ss@h1.example.com/app', NOT_A_URL],
  ['an unescaped colon in the password', 'mongodb://alice:foo:bar@127.0.0.1', NOT_A_URL],
  ['an unescaped bracket in the password', 'mongodb://alice:p[ss@h1.example.com/app', NOT_A_URL],
  ['a malformed escape in the username', 'mongodb://alice%foo:bar@127.0.0.1', NOT_A_URL],
  ['an escape in the password that is not UTF-8', 'mongodb://alice:%FF@h1.example.com/app', NOT_A_URL],
  ['the scheme in capitals', 'MONGODB://h1.example.com/app', NOT_MONGO],
  ['another protocol', 'postgres://host/db', NOT_MONGO],
  ['another protocol with a host list', 'postgres://h1:5432,h2:5432/db', NOT_MONGO],
];

/** `[what is wrong, url, the reason]` — the two constraints the driver puts on `mongodb+srv`, in the order it checks them. */
const SRV_REFUSED: ReadonlyArray<readonly [string, string, string]> = [
  ['two names', 'mongodb+srv://h1.example.com,h2.example.com/app', SRV_ONE_HOST],
  ['two names with ports', 'mongodb+srv://h1.example.com:27017,h2.example.com:27017/app', SRV_ONE_HOST],
  ['a port', 'mongodb+srv://cluster.example.net:27017/app', SRV_NO_PORT],
  ['an empty port', 'mongodb+srv://cluster.example.net:', SRV_NO_PORT],
  ['an IP literal', 'mongodb+srv://[::1]', SRV_NO_IP_LITERAL],
  ['no name at all', 'mongodb+srv://', NOT_A_URL],
];

/** The error `act` throws, or a failure naming that nothing was thrown. */
function thrownBy(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw, and nothing was thrown');
}

/** The `OptionsError` `act` throws — anything else, or nothing, fails the test. */
function refusalOf(act: () => unknown): OptionsError {
  const error = thrownBy(act);
  expect(error).toBeInstanceOf(OptionsError);
  return error as OptionsError;
}

describe('a replica-set seed list reaches all three stores (#1490)', () => {
  for (const [name, validate] of VALIDATORS) {
    test.each([...SEED_LISTS])(`${name} accepts %p`, (url) => {
      expect(() => validate(url)).not.toThrow();
    });
  }
});

describe('the format\'s other shapes are accepted', () => {
  test.each([...ACCEPTED])('%s: %p', (_name, url) => {
    expect(() => assertMongoUrl('MongoJournalOptions', url)).not.toThrow();
  });
});

describe('what the driver refuses is refused at construction, not on the first write', () => {
  test.each([...REFUSED])('%s: %p', (_name, url, reason) => {
    const refusal = refusalOf(() => assertMongoUrl('MongoJournalOptions', url));
    expect(refusal.message).toStartWith(`MongoJournalOptions: url ${reason} (got `);
    expect(refusal.field).toBe('url');
  });
});

describe('mongodb+srv takes exactly one host and no port, as the driver requires', () => {
  for (const [name, validate] of VALIDATORS) {
    test.each([...SRV_REFUSED])(`${name}: %s`, (_why, url, reason) => {
      const refusal = refusalOf(() => validate(url));
      expect(refusal.message).toStartWith(`${name}: url ${reason} (got `);
    });
  }

  test('one name, with or without userinfo, options and a database, is accepted', () => {
    for (const url of ['mongodb+srv://cluster.example.net', `mongodb+srv://app:${PASSWORD}@cluster.example.net/app?retryWrites=true&w=majority`]) {
      for (const [, validate] of VALIDATORS) expect(() => validate(url)).not.toThrow();
    }
  });
});

describe('the messages are the ones they were, and never print the password', () => {
  test.each([
    ['', '', NOT_A_URL],
    ['not a url', 'not a url', NOT_A_URL],
    [`postgres://admin:${PASSWORD}@host/db`, 'postgres://***@host/db', NOT_MONGO],
    [`postgres://admin:${PASSWORD}@h1:5432,h2:5432/db`, 'postgres://***@h1:5432,h2:5432/db', NOT_MONGO],
    [
      `mongodb://app:${PASSWORD}@h1.example.com:27017,h2.example.com:0/app?replicaSet=rs`,
      'mongodb://***@h1.example.com:27017,h2.example.com:0/app?replicaSet=rs',
      NOT_A_URL,
    ],
    [
      `mongodb+srv://app:${PASSWORD}@h1.example.com,h2.example.com/app`,
      'mongodb+srv://***@h1.example.com,h2.example.com/app',
      SRV_ONE_HOST,
    ],
  ])('%p', (url, redacted, reason) => {
    for (const [name, validate] of VALIDATORS) {
      const refusal = refusalOf(() => validate(url));
      expect(refusal.message).toBe(`${name}: url ${reason} (got ${JSON.stringify(redacted)})`);
      expect(refusal.options).toBe(name);
      expect(refusal.field).toBe('url');
      expect(refusal.value).toBe(redacted);
      expect(refusal.message).not.toContain(PASSWORD);
    }
  });
});

describe('the rule is total', () => {
  test('a value that is not a string is refused with an OptionsError, not thrown over', () => {
    // The type says string; a plain object from JavaScript does not have to.
    // An array of urls passed by mistake still carries their credentials.
    for (const value of [42, null, {}, [`mongodb://app:${PASSWORD}@h1.example.com`], 10n, Symbol('url')]) {
      const refusal = refusalOf(() => assertMongoUrl('MongoJournalOptions', value as unknown as string));
      expect(refusal.message).toStartWith(`MongoJournalOptions: url ${NOT_A_URL} (got `);
      expect(refusal.message).not.toContain(PASSWORD);
      expect(String(refusal.value)).not.toContain(PASSWORD);
    }
  });

  test('no string makes it throw anything but an OptionsError', () => {
    // Biased towards the characters the rule turns on, so the generated
    // strings get past the scheme often enough to exercise the host list.
    const urlish = fc.string({
      unit: fc.constantFrom(...'mongodb+srv:/@,[]?#%:0123456789abcdefFZ. \t\n'.split('')),
      maxLength: 60,
    });
    const prefixed = fc.tuple(fc.constantFrom('mongodb://', 'mongodb+srv://', ''), urlish).map(([prefix, rest]) => prefix + rest);
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 60 }), prefixed), (url) => {
        try {
          assertMongoUrl('MongoJournalOptions', url);
        } catch (error) {
          expect(error).toBeInstanceOf(OptionsError);
        }
      }),
    );
  });
});

/** Whether this runtime's own URL parser takes `literal` as a host. */
function runtimeParsesHost(literal: string): boolean {
  try {
    new URL(`http://${literal}/`);
    return true;
  } catch {
    return false;
  }
}

describe('an IP literal is judged the way the driver judges it', () => {
  test('an IPv6 literal with an IPv4 tail gets the verdict of this runtime\'s URL parser (seed 1424, first counterexample)', () => {
    // The property below found it.  Bun 1.4.2's URL refuses this literal and
    // Node 26.10 and Deno 2.6.8 accept it; the driver parses every host with
    // URL, so on Bun it cannot dial it either (mongodb 7.6: "Unable to parse
    // [63::4:3:14:242.210.228.28]:1523 with URL").  Refusing it there is the
    // driver's verdict a write early; accepting it would only defer it.
    const literal = '[63::4:3:14:242.210.228.28]';
    const url = `mongodb://)%3F%22wU%40b%3DMLRV:6%40jIs@0bd0n-1chf.sc:56257,${literal}:1523,bdge.u.hcg:62595,l.w6mdw35yg7.olf,75.161.198.220?replicaSet=rs&w=majority`;
    let accepted = true;
    try {
      assertMongoUrl('MongoJournalOptions', url);
    } catch (error) {
      expect(error).toBeInstanceOf(OptionsError);
      accepted = false;
    }
    expect(accepted).toBe(runtimeParsesHost(literal));
  });

  test('the same address written in hex is accepted on every runtime', () => {
    expect(runtimeParsesHost('[63::4:3:14:f2d2:e41c]')).toBe(true);
    expect(() => assertMongoUrl('MongoJournalOptions', 'mongodb://h1.example.com:27017,[63::4:3:14:f2d2:e41c]:1523/app')).not.toThrow();
  });
});

describe('generated seed lists', () => {
  const port = fc.option(fc.integer({ min: 1, max: 65_535 }).map((value) => `:${value}`), { nil: '' });
  // Hex groups only: an IPv4 tail is judged by the runtime's URL parser, and
  // Bun's refuses some that Node's accepts — see the example tests above.
  const ipV6Literal = fc.ipV6().filter((address) => !address.includes('.')).map((address) => `[${address}]`);
  const host = fc.oneof(fc.domain(), fc.ipV4(), ipV6Literal);
  const entry = fc.tuple(host, port).map(([name, suffix]) => name + suffix);
  const credential = fc.string({ minLength: 1, maxLength: 12 }).map(encodeURIComponent);
  const userinfo = fc.option(fc.tuple(credential, credential).map(([user, password]) => `${user}:${password}@`), { nil: '' });
  const tail = fc.constantFrom('', '/', '/app', '/app?replicaSet=rs', '?replicaSet=rs&w=majority');

  test('any list of well-formed hosts is accepted by all three validators', () => {
    fc.assert(
      fc.property(userinfo, fc.array(entry, { minLength: 1, maxLength: 5 }), tail, (credentials, entries, rest) => {
        const url = `mongodb://${credentials}${entries.join(',')}${rest}`;
        for (const [, validate] of VALIDATORS) validate(url);
      }),
    );
  });

  test('under mongodb+srv, a second name is always refused', () => {
    fc.assert(
      fc.property(fc.array(fc.domain(), { minLength: 2, maxLength: 5 }), (names) => {
        const refusal = refusalOf(() => assertMongoUrl('MongoJournalOptions', `mongodb+srv://${names.join(',')}/app`));
        expect(refusal.message).toStartWith(`MongoJournalOptions: url ${SRV_ONE_HOST} (got `);
      }),
    );
  });
});

/** The three readers, each with the store it feeds. */
type StoreCase = {
  readonly name: string;
  readonly root: string;
  readonly read: (config: Config) => { readonly url?: string };
  readonly construct: (url: string) => unknown;
};

const STORES: ReadonlyArray<StoreCase> = [
  {
    name: 'journal',
    root: ConfigKeys.persistence.journal.mongodb.root,
    read: readMongoJournalOptionsFromConfig,
    construct: (url) => new MongoJournal({ url }),
  },
  {
    name: 'snapshot store',
    root: ConfigKeys.persistence.snapshotStore.mongodb.root,
    read: readMongoSnapshotStoreOptionsFromConfig,
    construct: (url) => new MongoSnapshotStore({ url }),
  },
  {
    name: 'durable-state store',
    root: ConfigKeys.persistence.durableState.mongodb.root,
    read: readMongoDurableStateStoreOptionsFromConfig,
    construct: (url) => new MongoDurableStateStore({ url }),
  },
];

/** A block whose `url` leaf is exactly `url` — JSON's quoting is HOCON's. */
const blockWithUrl = (root: string, url: string): Config => Config.parseString(`${root}.url = ${JSON.stringify(url)}`);

/**
 * A system selecting the MongoDB plug-in on all three axes, each block
 * carrying `url` — registered through the `plugins` slot, so the stores
 * resolve on the line after `create`.
 */
function systemWithUrl(name: string, url: string): ActorSystem {
  const hocon = [
    `${ConfigKeys.persistence.journal.plugin} = "${ConfigKeys.persistence.journal.mongodb.root}"`,
    `${ConfigKeys.persistence.snapshotStore.plugin} = "${ConfigKeys.persistence.snapshotStore.mongodb.root}"`,
    `${ConfigKeys.persistence.durableState.plugin} = "${ConfigKeys.persistence.durableState.mongodb.root}"`,
    ...STORES.map((store) => `${store.root}.url = ${JSON.stringify(url)}`),
  ].join('\n');
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon))
    .withPersistence({ plugins: [(persistence) => registerMongoPlugins(persistence)] });
  return ActorSystem.create(`mongo-url-validation-${name}`, options);
}

describe('the TLS inspection and the url rule compose (#1490)', () => {
  // The HOCON reader inspects the url for a verification-off switch
  // (ConnectionStringInspection); the options validator checks its shape.  A
  // seed list has to clear both — and the switch has to stay refused whatever
  // shape the url has around it.
  const seedList = SEED_LISTS[3]!;
  const insecure = `${seedList}&tlsInsecure=true`;

  for (const store of STORES) {
    test(`${store.name}: a seed list read from HOCON builds the store`, () => {
      const options = store.read(blockWithUrl(store.root, seedList));
      expect(options.url).toBe(seedList);
      expect(() => store.construct(options.url!)).not.toThrow();
    });

    test(`${store.name}: a seed list carrying tlsInsecure=true is refused by the reader`, () => {
      const refusal = thrownBy(() => store.read(blockWithUrl(store.root, insecure)));
      expect(refusal).toBeInstanceOf(ConfigError);
      const message = (refusal as ConfigError).message;
      expect(message).toContain(`Config at "${store.root}.url"`);
      expect(message).toContain('"tlsInsecure=true"');
      expect(message).not.toContain(PASSWORD);
    });

    test(`${store.name}: the same url in code is the code's decision, and its shape passes`, () => {
      expect(() => store.construct(insecure)).not.toThrow();
    });
  }

  test('through the plug-in, a seed list from HOCON builds all three stores', async () => {
    const system = systemWithUrl('seed-list', seedList);
    try {
      const persistence = system.extension(PersistenceExtensionId);
      expect(() => persistence.journal).not.toThrow();
      expect(() => persistence.snapshotStore).not.toThrow();
      expect(() => persistence.durableStateStore).not.toThrow();
    } finally {
      await system.terminate();
    }
  });

  test('through the plug-in, the switch is what refuses the seed list, not its shape', async () => {
    const system = systemWithUrl('seed-list-insecure', insecure);
    try {
      const persistence = system.extension(PersistenceExtensionId);
      for (const build of [() => persistence.journal, () => persistence.snapshotStore, () => persistence.durableStateStore]) {
        const refusal = thrownBy(build);
        expect(refusal).toBeInstanceOf(ConfigError);
        expect((refusal as ConfigError).message).toContain('"tlsInsecure=true"');
      }
    } finally {
      await system.terminate();
    }
  });
});
