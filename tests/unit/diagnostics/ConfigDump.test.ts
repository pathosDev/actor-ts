/**
 * The boot config dump — `actor-ts.diagnostics.log-config-on-start` (#867).
 *
 * Two halves.  The renderer is asserted directly, because the properties that
 * matter are properties of the *text*: what it withholds, what it admits it
 * does not withhold, and that a value cannot write a line of its own.  Then
 * the switch is asserted through a real `ActorSystem`, because "once, at
 * startup, only when asked" is a fact about the constructor and nothing
 * smaller can state it.
 *
 * **What still prints is pinned deliberately.**  Withholding is by key name,
 * because a `${?DATABASE_PASSWORD}` has resolved to a plain string long
 * before the merged tree exists and nothing is left to say it was a secret —
 * unless it came out of the secrets file, whose every value is withheld
 * whatever its key is called (#1546).
 * One kind of secret says so in the value itself: the userinfo of a URL,
 * which `scheme://user:password@host` marks by syntax, so that is masked
 * under any key name (#1458).  Everything neither rule can see — a bare
 * password in a `dsn`, a query-string token, SQL Server's `Password=` form,
 * memjs's scheme-less `user:password@host` — is printed in full, one case
 * asserts exactly that, and the documentation lists the same four in both
 * languages.  A test that only showed the redaction working would let that
 * list rot into a promise the code does not keep.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import type { ConfigObject, ConfigValue } from '../../../src/config/HoconParser.js';
import { configDumpLines } from '../../../src/diagnostics/ConfigDump.js';
import { DiagnosticsOptions } from '../../../src/diagnostics/DiagnosticsOptions.js';
import { CONFIG_REDACTED } from '../../../src/util/Constants.js';
import { RecordingLogger, type RecordedLog } from '../../util/RecordingLogger.js';

/**
 * A layered config with no `application.conf` in the middle.
 *
 * The path is named and does not exist, so the middle layer is empty whatever
 * the working directory holds — a real `application.conf` beside the test
 * runner would otherwise change what the header prints.
 */
const layered = (overrides: Record<string, unknown>): Config =>
  Config.load({ appConfPath: 'no-such-application.conf', overrides });

const dumpOf = (log: RecordingLogger): RecordedLog[] =>
  log.records.filter((record) => record.message.startsWith('configuration in effect'));

/** One body line of a dump, split back into the two columns that matter. */
type DumpLine = {
  readonly path: string;
  readonly value: string;
};

/**
 * The body of a dump, parsed.
 *
 * The header is dropped and the `  [layer]` suffix stripped, so a case can ask
 * what a key printed without restating the whole line format.  A path never
 * contains a space, so the first ` = ` is the column separator even when the
 * value holds one.
 */
const bodyOf = (text: string): DumpLine[] =>
  text.split('\n').slice(1).map((line) => {
    const at = line.indexOf(' = ');
    return { path: line.slice(2, at), value: line.slice(at + 3).replace(/ {2}\[[^\]]*\]$/, '') };
  });

/**
 * What one key printed, or a throw naming the key that has gone.
 *
 * The throw is the point: a case naming a key `reference.conf` no longer ships
 * would otherwise pass by asserting nothing.
 */
const printed = (text: string, path: string): string => {
  const line = bodyOf(text).find((one) => one.path === path);
  if (line === undefined) throw new Error(`the dump has no line for ${path}`);
  return line.value;
};

/** Every path the dump withheld, sorted as the dump sorts. */
const withheld = (text: string): string[] =>
  bodyOf(text).filter((line) => line.value === CONFIG_REDACTED).map((line) => line.path);

/**
 * The value the merged tree itself holds at a dotted path, read around the
 * renderer rather than through it — which is what lets a case compare what
 * was printed against what was there.
 */
const valueAt = (tree: ConfigObject, path: string): ConfigValue =>
  path.split('.').reduce<ConfigValue>((node, segment) => (node as ConfigObject)[segment]!, tree);

describe('configDumpLines — the text the dump writes', () => {
  test('a value whose KEY says it is a secret is withheld', () => {
    const text = configDumpLines(layered({
      'actor-ts': { cache: { redis: { password: 'hunter2' } } },
    }));

    expect(text).toContain('actor-ts.cache.redis.password = <redacted>');
    expect(text).not.toContain('hunter2');
  });

  test('a password inside a URL is masked whatever the key is called (#1458)', () => {
    // `dsn` matches none of the credential words, so no key-name rule
    // withholds it — but the userinfo of a URL says it is a credential by
    // syntax alone, and that is what goes.
    const text = configDumpLines(layered({
      'my-app': { database: { dsn: 'postgres://user:hunter2@db/app' } },
    }));

    expect(text).toContain('my-app.database.dsn = "postgres://***@db/app"');
    expect(text).not.toContain('hunter2');
  });

  test('what neither rule can see is printed in full — the stated remainder', () => {
    // Four credentials an operator can hold under a key that does not name
    // one, none of them a `scheme://user:password@host` URL.  Both docs pages
    // list exactly these; this is the assertion that keeps the list true, in
    // both directions — a mask widened to cover one of them turns this red
    // until the pages say so too.
    const text = configDumpLines(layered({
      'my-app': {
        // A `${?DATABASE_PASSWORD}` that resolved into a key called `dsn`.
        database: { dsn: 'hunter2' },
        ingest: {
          endpoint: 'https://logs.example/ingest?authToken=hunter3',
          'push-url': 'https://metrics.example/push?password=hunter4',
        },
        mssql: { 'connection-string': 'Server=db,1433;Database=app;User Id=sa;Password=hunter5' },
        memcached: { servers: 'memuser:hunter6@cache:11211,cache-2:11211' },
      },
    }));

    expect(printed(text, 'my-app.database.dsn')).toBe('"hunter2"');
    expect(printed(text, 'my-app.ingest.endpoint'))
      .toBe('"https://logs.example/ingest?authToken=hunter3"');
    expect(printed(text, 'my-app.ingest.push-url'))
      .toBe('"https://metrics.example/push?password=hunter4"');
    expect(printed(text, 'my-app.mssql.connection-string'))
      .toBe('"Server=db,1433;Database=app;User Id=sa;Password=hunter5"');
    expect(printed(text, 'my-app.memcached.servers')).toBe('"memuser:hunter6@cache:11211,cache-2:11211"');
  });

  test('only the userinfo goes: scheme, host, port, path and query print as written', () => {
    // Which Redis is configured is what the dump is read for, so the mask must
    // not normalise the rest of the string: no lower-cased host, no dropped
    // query, no added slash — the three things a `URL` round-trip does to it.
    const text = configDumpLines(layered({
      'my-app': {
        cache: { endpoint: 'rediss://default:hunter2@Redis.Example:6380/0?ssl_cert_reqs=required' },
      },
    }));

    expect(printed(text, 'my-app.cache.endpoint'))
      .toBe('"rediss://***@Redis.Example:6380/0?ssl_cert_reqs=required"');
  });

  test('every URL in a list is masked, and the list stays a list', () => {
    // A server list is the one shape that carries several credentials at once,
    // and a list is a single leaf — so the mask has to reach inside it.
    const text = configDumpLines(layered({
      'my-app': {
        nats: { servers: ['nats://a:hunter2@h1:4222', 'nats://h2:4222', 'nats://c:hunter3@h3:4222'] },
      },
    }));

    expect(printed(text, 'my-app.nats.servers'))
      .toBe('["nats://***@h1:4222","nats://h2:4222","nats://***@h3:4222"]');
    expect(text).not.toContain('hunter');
  });

  test('a URL in an object inside a list is masked as well', () => {
    // A list of endpoints written as objects is still one leaf, and the
    // object's own key (`url`) names no secret either.
    const text = configDumpLines(layered({
      'my-app': {
        replicas: [
          { name: 'primary', url: 'redis://:hunter2@r1:6379' },
          { name: 'replica', url: 'redis://r2:6379' },
        ],
      },
    }));

    expect(printed(text, 'my-app.replicas'))
      .toBe('[{"name":"primary","url":"redis://***@r1:6379"},{"name":"replica","url":"redis://r2:6379"}]');
  });

  test('a credential-named field of an object inside a list is withheld (found while #1458)', () => {
    // A list is one leaf, so the key rule read the path down to it and
    // stopped: `upstreams` names no secret, and the password printed in full.
    // The field's own name is read the way a path segment is.
    const text = configDumpLines(Config.load({
      appConfPath: 'no-such-application.conf',
      overrides: Config.parseString('my-app.upstreams = [ { host = "db-1", password = "hunter2" } ]'),
    }));

    expect(printed(text, 'my-app.upstreams')).toBe('[{"host":"db-1","password":"<redacted>"}]');
    expect(text).not.toContain('hunter2');
  });

  test('a field inside a list is read by its head word, and a boolean is never withheld', () => {
    // The same three properties the path rule has: the head word decides,
    // camel humps split, and a boolean carries nothing whatever it is called.
    const text = configDumpLines(layered({
      'my-app': {
        upstreams: [
          { host: 'db-2', 'api-key': 'sk-live-3', 'key-prefix': 'orders:', passivation: 'idle' },
          { host: 'db-3', clientSecret: 'hunter3', auth: false },
        ],
      },
    }));

    expect(printed(text, 'my-app.upstreams')).toBe(
      '[{"host":"db-2","api-key":"<redacted>","key-prefix":"orders:","passivation":"idle"},'
      + '{"host":"db-3","clientSecret":"<redacted>","auth":false}]',
    );
  });

  test('a credential-named field withholds what sits beneath it, nested lists included', () => {
    // A branch named like a credential declares its whole subtree, inside a
    // list exactly as outside one — except a boolean, which says nothing.
    const text = configDumpLines(layered({
      'my-app': {
        clusters: [
          {
            name: 'eu',
            credentials: { user: 'svc', 'rotate-on-start': true },
            nodes: [{ host: 'n1', token: 'hunter4' }],
            'api-keys': ['k1', 'k2'],
          },
        ],
      },
    }));

    expect(printed(text, 'my-app.clusters')).toBe(
      '[{"name":"eu","credentials":{"user":"<redacted>","rotate-on-start":true},'
      + '"nodes":[{"host":"n1","token":"<redacted>"}],"api-keys":"<redacted>"}]',
    );
    expect(text).not.toContain('hunter4');
    expect(text).not.toContain('"k1"');
  });

  test('a URL substituted from the environment is masked — ${?REDIS_URL} through Config.load', () => {
    // The route the redis block's own reference.conf comment recommends, and
    // the reason a value cannot be judged by where it came from: once the file
    // is parsed, the substitution is an ordinary string in the merged tree.
    const variable = 'ACTOR_TS_TEST_1458_REDIS_URL';
    const directory = mkdtempSync(join(tmpdir(), 'actor-ts-config-dump-'));
    const path = join(directory, 'application.conf');
    writeFileSync(path, `actor-ts.cache.redis.url = \${?${variable}}\n`, 'utf8');
    const previous = process.env[variable];
    process.env[variable] = 'redis://default:hunter2@redis.example:6379/0';
    try {
      const text = configDumpLines(Config.load({ appConfPath: path }));

      expect(text).toContain('actor-ts.cache.redis.url = "redis://***@redis.example:6379/0"'
        + '  [application, overrides a lower layer]');
      expect(text).not.toContain('hunter2');
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('every key names the layer it came from, and says when it displaced one', () => {
    const text = configDumpLines(layered({ 'actor-ts': { actor: { throughput: 7 } } }));

    // `actor.throughput` ships in reference.conf, so an override displaces a
    // real lower-layer value — which is the whole question the dump answers.
    expect(text).toContain('actor-ts.actor.throughput = 7  [override, overrides a lower layer]');
    // A key only reference.conf sets is reported plainly, with no claim that
    // anything was displaced.
    expect(text).toContain('actor-ts.dispatcher.throughput = 16  [reference]');
  });

  test('the header counts what it withheld and names the file it looked for', () => {
    const text = configDumpLines(layered({
      'actor-ts': { cache: { redis: { password: 'hunter2' } } },
    }));
    const head = text.split('\n')[0]!;

    expect(head).toContain('configuration in effect');
    expect(head).toContain('redacted by key name');
    expect(head).toContain('no-such-application.conf');
    // The count is a number of keys, and there are a great many; a header
    // reporting `0 keys` would mean the walk found nothing and every other
    // assertion here would be vacuous.
    expect(head).toMatch(/— (\d+) keys/);
    expect(Number(/— (\d+) keys/.exec(head)![1])).toBeGreaterThan(100);
  });

  test('the header counts the values it masked apart from the keys it withheld (#1458)', () => {
    const text = configDumpLines(layered({
      'my-app': {
        dsn: 'postgres://user:hunter2@db/app',
        mirrors: ['redis://:hunter3@r1:6379', 'redis://r2:6379'],
        health: 'https://status.example/health',
        // Withheld by its key, so it is counted there and not a second time
        // as masked: the two numbers add up to what the body hides.
        password: 'redis://u:hunter4@r3:6379',
      },
    }));
    const head = text.split('\n')[0]!;

    expect(head).toContain(
      `, ${STOCK_WITHHELD.length + 1} redacted by key name, 0 redacted from a secrets file,`
      + ' 0 with credential fields withheld, 2 with URL credentials masked;',
    );
  });

  test('the header counts a list whose fields it withheld, apart from the values it masked', () => {
    // Three lists: one with a withheld field, one with a masked URL, one with
    // both.  A count is a number of keys per kind of hiding, so the third is
    // in both — and none of them is a key withheld by name.
    const text = configDumpLines(layered({
      'my-app': {
        upstreams: [{ host: 'db-1', password: 'hunter2' }],
        mirrors: ['redis://:hunter3@r1:6379'],
        replicas: [{ url: 'redis://:hunter4@r2:6379', token: 'hunter5' }],
      },
    }));
    const head = text.split('\n')[0]!;

    expect(head).toContain(
      `, ${STOCK_WITHHELD.length} redacted by key name, 0 redacted from a secrets file,`
      + ' 2 with credential fields withheld, 2 with URL credentials masked;',
    );
    expect(text).not.toContain('hunter');
  });

  test('a config with no layers says so rather than reporting everything as reference', () => {
    // `parseString` has one source and no precedence to explain.  Calling all
    // of it `reference` would be a guess dressed as an answer.
    const text = configDumpLines(Config.parseString('actor-ts.actor.throughput = 5'));

    expect(text.split('\n')[0]!).toContain('layers unavailable');
  });

  test('a newline inside a value cannot forge a line of the dump', () => {
    // The realistic route in is `${?SOMETHING}` out of the environment, which
    // resolves into the merged tree as an ordinary string.  JSON-encoding the
    // value is what keeps a dump line one dump line.
    const forgery = 'billing\n  actor-ts.cluster.seed-nodes = ["evil"]  [reference]';
    const text = configDumpLines(layered({ 'actor-ts': { system: { name: forgery } } }));

    expect(text.split('\n')).not.toContain('  actor-ts.cluster.seed-nodes = ["evil"]  [reference]');
    expect(text).toContain('actor-ts.system.name = "billing\\n  actor-ts.cluster.seed-nodes');
  });

  test('a list stays a list', () => {
    // Flattening `seed-nodes` into `seed-nodes.0` and `seed-nodes.1` would
    // turn one setting nobody configured into two.
    const text = configDumpLines(layered({
      'actor-ts': { cluster: { 'seed-nodes': ['one', 'two'] } },
    }));

    expect(text).toContain('actor-ts.cluster.seed-nodes = ["one","two"]');
  });
});

describe('six layers, five names, and the secrets file (#1546)', () => {
  /**
   * An application file and a secrets file, each with a production profile.
   *
   * Every key is named like nothing in particular — `set-by-secrets` reads as
   * a `set` to the name rule, the preposition moving the head in front of it
   * — so a key withheld here was withheld because of the file it is in.
   */
  const PROFILED = {
    'application.conf': [
      'my-app { set-by-application = "a", set-by-profile = "a", set-by-secrets = "a",'
        + ' set-by-secrets-profile = "a" }',
      'profiles.production.my-app { set-by-profile = "b", set-by-secrets = "b", set-by-secrets-profile = "b" }',
    ].join('\n'),
    'secrets.conf': [
      'my-app { set-by-secrets = "s3cr3t-root", endpoint-value = "s3cr3t-1", set-by-secrets-profile = "c",'
        + ' set-by-secrets-only = "c" }',
      'profiles.production.my-app { set-by-secrets-profile = "s3cr3t-profile", set-by-secrets-only = "s3cr3t-2" }',
    ].join('\n'),
  } as const;

  /** A directory holding `files`, removed after `body` ran. */
  const inDirectory = <T>(files: Readonly<Record<string, string>>, body: (directory: string) => T): T => {
    const directory = mkdtempSync(join(tmpdir(), 'actor-ts-config-dump-layers-'));
    try {
      for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content, 'utf8');
      return body(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  const profiledDump = (overrides: Record<string, unknown> = {}): string => inDirectory(PROFILED, (directory) =>
    configDumpLines(Config.load({
      appConfPath: join(directory, 'application.conf'),
      secretsConfPath: join(directory, 'secrets.conf'),
      profile: 'production',
      overrides,
    })));

  /** The `[layer]` column of one body line. */
  const originOf = (text: string, path: string): string => {
    const line = text.split('\n').find((one) => one.startsWith(`  ${path} = `));
    if (line === undefined) throw new Error(`the dump has no line for ${path}`);
    return /\[([^\]]*)\]$/.exec(line)![1]!;
  };

  test('every key names one of five layers — a secrets-profile key reports as secrets', () => {
    const text = profiledDump({ 'my-app': { 'from-code': 'x' } });

    expect(originOf(text, 'actor-ts.dispatcher.throughput')).toBe('reference');
    expect(originOf(text, 'my-app.set-by-application')).toBe('application');
    expect(originOf(text, 'my-app.set-by-profile')).toBe('profile, overrides a lower layer');
    expect(originOf(text, 'my-app.set-by-secrets')).toBe('secrets, overrides a lower layer');
    expect(originOf(text, 'my-app.set-by-secrets-profile')).toBe('secrets, overrides a lower layer');
    // Displaced is counted in layers, not names: the profile's value of a key
    // only the secrets file sets still overrides the root's.
    expect(originOf(text, 'my-app.set-by-secrets-only')).toBe('secrets, overrides a lower layer');
    expect(originOf(text, 'my-app.from-code')).toBe('override');
  });

  test('a value the secrets file set is withheld whatever its key is called', () => {
    const text = profiledDump();

    expect(printed(text, 'my-app.endpoint-value')).toBe(CONFIG_REDACTED);
    expect(printed(text, 'my-app.set-by-secrets')).toBe(CONFIG_REDACTED);
    expect(printed(text, 'my-app.set-by-secrets-profile')).toBe(CONFIG_REDACTED);
    expect(text).not.toContain('s3cr3t');
    // The application file's keys of the same shape print: the file decides.
    expect(printed(text, 'my-app.set-by-profile')).toBe('"b"');
    expect(printed(text, 'my-app.set-by-application')).toBe('"a"');
  });

  test('withheld when a secrets layer holds the key, not only when it wins it', () => {
    // A key the code overrides still sits in the secrets file, and a value
    // that came out of that file under another name is the case this covers:
    // a WorkerMesh worker receives its whole tree as one overrides object.
    const text = profiledDump({ 'my-app': { 'endpoint-value': 'from-code' } });

    expect(originOf(text, 'my-app.endpoint-value')).toBe('override, overrides a lower layer');
    expect(printed(text, 'my-app.endpoint-value')).toBe(CONFIG_REDACTED);
  });

  test('the header counts the secrets-file values apart from the keys withheld by name', () => {
    const head = profiledDump().split('\n')[0]!;

    // set-by-secrets, endpoint-value, set-by-secrets-profile and set-by-secrets-only.
    expect(head).toContain(`, ${STOCK_WITHHELD.length} redacted by key name, 4 redacted from a secrets file,`);
  });

  test('the header prints the profile and both files, and says which one was not there', () => {
    inDirectory({ 'application.conf': 'profiles.production {}' }, (directory) => {
      const application = join(directory, 'application.conf');
      const secrets = join(directory, 'secrets.conf');
      const head = configDumpLines(Config.load({
        appConfPath: application,
        secretsConfPath: secrets,
        profile: 'production',
      })).split('\n')[0]!;

      expect(head).toContain(`; profile: production; application.conf: ${application}; `
        + `secrets.conf: ${secrets} (not found)`);
    });
  });

  test('without a profile the header says so', () => {
    expect(configDumpLines(layered({})).split('\n')[0]!).toContain('; profile: (none);');
  });
});

/**
 * The keys `reference.conf` ships that hold a credential slot.
 *
 * Named in full rather than counted, and asserted as the *whole* withheld set,
 * because both halves of that are the property worth pinning.  A shipped key
 * that stops being withheld is a leak; a shipped tuning value that starts
 * being withheld is the defect this block exists for — the heuristic reading
 * four letters of a longer word and hiding a number an operator came to check.
 * Either direction has to show up as a diff of this list.
 */
const STOCK_WITHHELD: readonly string[] = [
  'actor-ts.cache.memcached.password',
  'actor-ts.cache.redis.password',
  'actor-ts.logger.sinks.parseable.api-key',
  'actor-ts.logger.sinks.parseable.password',
  'actor-ts.logger.sinks.seq.api-key',
  'actor-ts.logger.sinks.splunk.token',
  'actor-ts.persistence.durable-state.cloudflare-d1.api-token',
  'actor-ts.persistence.durable-state.libsql.auth-token',
  'actor-ts.persistence.journal.cloudflare-d1.api-token',
  'actor-ts.persistence.journal.libsql.auth-token',
  'actor-ts.persistence.snapshot-store.cloudflare-d1.api-token',
  'actor-ts.persistence.snapshot-store.libsql.auth-token',
];

/**
 * Shipped tuning values whose names merely *contain* letters a credential also
 * spells, with the value each one has to print.
 *
 * Every one of these read `<redacted>` while the pattern was a bare substring
 * alternation over the full dotted path: `passivation` contains `pass`,
 * `keyspace` contains `key`, and `token-reload-interval` is a duration.  A
 * dump that hides these is worse than useless — it hides exactly the tuning an
 * operator turned the dump on to check, and teaches them the output cannot be
 * trusted.
 */
const STOCK_PRINTED: readonly (readonly [string, string])[] = [
  ['actor-ts.sharding.passivation-idle', '"5m"'],
  ['actor-ts.sharding.passivation.stop-timeout', '"0ms"'],
  ['actor-ts.sharding.passivation.replacement', '"least-recently-used"'],
  ['actor-ts.sharding.passivation.admission-filter', '"off"'],
  ['actor-ts.sharding.passivation.admission-window-proportion', '0'],
  ['actor-ts.sharding.passivation.segmented-protected-proportion', '0.8'],
  ['actor-ts.cluster.receptionist.max-subscribers-per-key', '1000'],
  ['actor-ts.distributed-data.durable-keys', '[]'],
  ['actor-ts.cache.redis.key-prefix', '""'],
  ['actor-ts.cache.memcached.key-prefix', '""'],
  ['actor-ts.persistence.journal.cassandra.keyspace', '""'],
  ['actor-ts.persistence.journal.cassandra.auto-create-keyspace', '"off"'],
  ['actor-ts.persistence.snapshot-store.cassandra.keyspace', '""'],
  ['actor-ts.persistence.snapshot-store.cassandra.auto-create-keyspace', '"off"'],
  ['actor-ts.http.cors.credentials', '"off"'],
  ['actor-ts.management.auth-protect-health', 'false'],
  ['actor-ts.coordination.lease.kubernetes.token-path',
    '"/var/run/secrets/kubernetes.io/serviceaccount/token"'],
  ['actor-ts.coordination.lease.kubernetes.token-reload-interval', '"1m"'],
  ['actor-ts.persistence.snapshot-store.object-storage.encryption.kms-key-id', '""'],
];

/**
 * Every key `reference.conf` ships that takes a connection URL (#1458).
 *
 * Named in full for the reason {@link STOCK_WITHHELD} is: a URL key that lands
 * later has to show up here as a line of diff, and so goes through the
 * one-pass audit below instead of being trusted to the mask by default.  None
 * of these names a secret, so every one of them printed a credential in full
 * before the mask read values.
 */
const STOCK_URL_KEYS: readonly string[] = [
  'actor-ts.cache.redis.url',
  'actor-ts.logger.sinks.gelf.url',
  'actor-ts.logger.sinks.loki.url',
  'actor-ts.logger.sinks.otlp.url',
  'actor-ts.logger.sinks.parseable.url',
  'actor-ts.logger.sinks.seq.url',
  'actor-ts.logger.sinks.splunk.url',
  'actor-ts.persistence.durable-state.cloudflare-d1.base-url',
  'actor-ts.persistence.durable-state.dynamodb.endpoint',
  'actor-ts.persistence.durable-state.libsql.url',
  'actor-ts.persistence.durable-state.mariadb.url',
  'actor-ts.persistence.durable-state.mongodb.url',
  'actor-ts.persistence.durable-state.mssql.url',
  'actor-ts.persistence.durable-state.postgres.url',
  'actor-ts.persistence.journal.cloudflare-d1.base-url',
  'actor-ts.persistence.journal.dynamodb.endpoint',
  'actor-ts.persistence.journal.libsql.url',
  'actor-ts.persistence.journal.mariadb.url',
  'actor-ts.persistence.journal.mongodb.url',
  'actor-ts.persistence.journal.mssql.url',
  'actor-ts.persistence.journal.postgres.url',
  'actor-ts.persistence.snapshot-store.cloudflare-d1.base-url',
  'actor-ts.persistence.snapshot-store.dynamodb.endpoint',
  'actor-ts.persistence.snapshot-store.libsql.url',
  'actor-ts.persistence.snapshot-store.mariadb.url',
  'actor-ts.persistence.snapshot-store.mongodb.url',
  'actor-ts.persistence.snapshot-store.mssql.url',
  'actor-ts.persistence.snapshot-store.object-storage.s3.endpoint',
  'actor-ts.persistence.snapshot-store.postgres.url',
];

describe('every stock key that takes a URL, audited in one pass (#1458)', () => {
  test('the list above is every stock leaf named url, base-url or endpoint', () => {
    const text = configDumpLines(layered({}));
    const named = bodyOf(text)
      .map((line) => line.path)
      .filter((path) => /\.(?:url|base-url|endpoint)$/.test(path));

    expect([...named].sort()).toEqual([...STOCK_URL_KEYS].sort());
  });

  test('a credentialed URL in every one of them at once, and the dump prints none of the secrets', () => {
    // One config, one dump: the audit the issue asked for is a single pass,
    // and a mask that depended on which subsystem a key belongs to would show
    // up here as the one line that still carries its secret.
    const overlay = STOCK_URL_KEYS
      .map((path, index) => `${path} = "https://audit-user:audit-secret-${index}@host-${index}.example:8443/base"`)
      .join('\n');
    const text = configDumpLines(Config.load({
      appConfPath: 'no-such-application.conf',
      overrides: Config.parseString(overlay),
    }));

    STOCK_URL_KEYS.forEach((path, index) => {
      expect(printed(text, path)).toBe(`"https://***@host-${index}.example:8443/base"`);
    });
    expect(text).not.toContain('audit-secret');
    expect(text.split('\n')[0]!).toContain(`, ${STOCK_URL_KEYS.length} with URL credentials masked;`);
  });
});

describe('what the dump withholds in a stock configuration (#867)', () => {
  test.each(STOCK_PRINTED)('%s prints its value rather than <redacted>', (path, value) => {
    expect(printed(configDumpLines(layered({})), path)).toBe(value);
  });

  test.each([...STOCK_WITHHELD])('%s is withheld', (path) => {
    expect(printed(configDumpLines(layered({})), path)).toBe(CONFIG_REDACTED);
  });

  test('those credential slots are the ONLY keys a stock tree withholds', () => {
    expect(withheld(configDumpLines(layered({})))).toEqual([...STOCK_WITHHELD]);
  });

  test('a stock tree carries no URL credentials, so the mask moves none of its values (#1458)', () => {
    // Every printed line against the value the tree itself holds, read around
    // the renderer: a mask that reached past the userinfo of a URL would show
    // up here as a stock value an operator can no longer read back.
    const config = layered({});
    const text = configDumpLines(config);
    const tree = config.toJSON();
    const printedLines = bodyOf(text).filter((line) => line.value !== CONFIG_REDACTED);
    const moved = printedLines.filter((line) => line.value !== JSON.stringify(valueAt(tree, line.path)));

    expect(text.split('\n')[0]!).toContain(', 0 with URL credentials masked;');
    // Vacuity guard: the comparison has to have run over the whole tree.
    expect(printedLines.length).toBeGreaterThan(400);
    expect(moved).toEqual([]);
  });
});

describe('which key names count as naming a secret', () => {
  test('a secret word inside a longer word is not that word', () => {
    // `passivation` is not `pass` and `keyspace` is not `key`.  A substring
    // alternation cannot tell them apart; the tokens of the name can.
    const text = configDumpLines(layered({
      'my-app': { passivation: 'aggressive', keyspace: 'billing', authority: 'eu-west' },
    }));

    expect(printed(text, 'my-app.passivation')).toBe('"aggressive"');
    expect(printed(text, 'my-app.keyspace')).toBe('"billing"');
    expect(printed(text, 'my-app.authority')).toBe('"eu-west"');
  });

  test('the last word of the name says what the value is', () => {
    // `api-key` is a key; `key-prefix` is a prefix that happens to be about
    // keys.  Head-final is what separates the credential from the setting
    // named after one.
    const text = configDumpLines(layered({
      'my-app': { 'api-key': 'sk-live-1', 'key-prefix': 'orders:', 'token-path': '/run/tok' },
    }));

    expect(printed(text, 'my-app.api-key')).toBe(CONFIG_REDACTED);
    expect(printed(text, 'my-app.key-prefix')).toBe('"orders:"');
    expect(printed(text, 'my-app.token-path')).toBe('"/run/tok"');
  });

  test('a preposition moves the head in front of it', () => {
    // `subscribers-per-key` is a count of subscribers.  `secret-per-tenant`
    // is still a secret — the rule takes what precedes the preposition, so it
    // reads the qualified side, not the object.
    const text = configDumpLines(layered({
      'my-app': { 'max-requests-per-token': 50, 'secret-per-tenant': 'hunter2' },
    }));

    expect(printed(text, 'my-app.max-requests-per-token')).toBe('50');
    expect(printed(text, 'my-app.secret-per-tenant')).toBe(CONFIG_REDACTED);
  });

  test('a camelCase key is read as words too, so it cannot slip through', () => {
    // Nothing forces an application subtree into kebab-case, and a redaction
    // that only understands one spelling is a redaction with a hole in it.
    const text = configDumpLines(layered({
      'my-app': { apiKey: 'sk-live-2', clientSecret: 'hunter2', keyPrefix: 'orders:' },
    }));

    expect(printed(text, 'my-app.apiKey')).toBe(CONFIG_REDACTED);
    expect(printed(text, 'my-app.clientSecret')).toBe(CONFIG_REDACTED);
    expect(printed(text, 'my-app.keyPrefix')).toBe('"orders:"');
  });

  test('a value from HOCON’s boolean vocabulary is never withheld', () => {
    // Six spellings, all of them public.  `auth-protect-health = false` says
    // nothing a reader did not already know, whatever the key is called, and
    // a `<redacted>` there is pure noise.
    const text = configDumpLines(layered({
      'my-app': { password: 'off', 'api-token': false, 'client-secret': 'yes' },
    }));

    expect(printed(text, 'my-app.password')).toBe('"off"');
    expect(printed(text, 'my-app.api-token')).toBe('false');
    expect(printed(text, 'my-app.client-secret')).toBe('"yes"');
  });

  test('a real credential is still withheld under every spelling', () => {
    const text = configDumpLines(layered({
      'my-app': {
        password: 'hunter2',
        passphrase: 'correct horse',
        secret: 's',
        'client-secret': 's',
        token: 't',
        'auth-token': 't',
        'api-key': 'k',
        'private-key': 'k',
        credentials: 'c',
        'api-keys': ['k1', 'k2'],
      },
    }));

    for (const line of bodyOf(text).filter((one) => one.path.startsWith('my-app.'))) {
      expect(line.value).toBe(CONFIG_REDACTED);
    }
  });
});

describe('actor-ts.diagnostics.log-config-on-start — the switch', () => {
  test('a system nobody configured writes no dump', async () => {
    const log = new RecordingLogger();
    const system = ActorSystem.create('dump-off', ActorSystemOptions.create().withLogger(log));

    // An absence, and it needs no polling: the dump is written on the
    // constructor's own stack or not at all.
    expect(dumpOf(log)).toHaveLength(0);
    await system.terminate();
  });

  test('HOCON turns it on, and the dump appears exactly once, at info', async () => {
    const log = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withConfig({ 'actor-ts': { diagnostics: { 'log-config-on-start': true } } });
    const system = ActorSystem.create('dump-on', systemOptions);

    expect(dumpOf(log)).toHaveLength(1);
    expect(dumpOf(log)[0]!.level).toBe('info');
    // `info` and not `debug`: an operator who asked for the dump has asked
    // for output, and a switch that needs a second switch reads as broken.
    expect(dumpOf(log)[0]!.message).toContain('actor-ts.diagnostics.log-config-on-start = true');

    // Still exactly one after the system has finished starting: the record is
    // written in the constructor, so nothing later can produce a second.
    await system.terminate();
    expect(dumpOf(log)).toHaveLength(1);
  });

  test('withDiagnostics turns it on too, so the explicit layer is reachable', async () => {
    const log = new RecordingLogger();
    const diagnosticsOptions = DiagnosticsOptions.create().withLogConfigOnStart();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withDiagnostics(diagnosticsOptions);
    const system = ActorSystem.create('dump-on-code', systemOptions);

    expect(dumpOf(log)).toHaveLength(1);
    await system.terminate();
  });

  test('the record a real system writes redacts the same keys the renderer does', async () => {
    const log = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withConfig({
        'actor-ts': {
          diagnostics: { 'log-config-on-start': true },
          cache: { redis: { password: 'hunter2' } },
        },
      });
    const system = ActorSystem.create('dump-redacts', systemOptions);

    expect(dumpOf(log)[0]!.message).toContain('actor-ts.cache.redis.password = <redacted>');
    expect(dumpOf(log)[0]!.message).not.toContain('hunter2');
    await system.terminate();
  });

  test('the record a real system writes masks a URL’s credentials the same way (#1458)', async () => {
    // The channel that matters most: this record goes to every configured
    // sink.  Two stock URL keys, neither named like a secret — `enabled` stays
    // off, so setting the Loki URL starts no sink.
    const log = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withConfig({
        'actor-ts': {
          diagnostics: { 'log-config-on-start': true },
          cache: { redis: { url: 'redis://default:hunter2@redis.example:6379/0' } },
          logger: { sinks: { loki: { url: 'https://tenant:hunter3@loki.example' } } },
        },
      });
    const system = ActorSystem.create('dump-masks-urls', systemOptions);
    try {
      const message = dumpOf(log)[0]!.message;

      expect(message).toContain('actor-ts.cache.redis.url = "redis://***@redis.example:6379/0"');
      expect(message).toContain('actor-ts.logger.sinks.loki.url = "https://***@loki.example"');
      expect(message).not.toContain('hunter');
    } finally {
      await system.terminate();
    }
  });

  test('the record a real system writes withholds a credential field inside a list (found while #1458)', async () => {
    const log = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withConfig({
        'actor-ts': { diagnostics: { 'log-config-on-start': true } },
        'my-app': { upstreams: [{ host: 'db-1', password: 'hunter2' }] },
      });
    const system = ActorSystem.create('dump-withholds-list-fields', systemOptions);
    try {
      const message = dumpOf(log)[0]!.message;

      expect(message).toContain('my-app.upstreams = [{"host":"db-1","password":"<redacted>"}]');
      expect(message).not.toContain('hunter2');
    } finally {
      await system.terminate();
    }
  });
});
