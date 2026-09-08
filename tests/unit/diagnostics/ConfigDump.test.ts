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
 * **The gap is pinned deliberately.**  One case asserts that a secret in a
 * key named `dsn` is printed in full.  That is not an oversight left
 * un-fixed: redaction is by key name and cannot be anything else — a
 * `${?DATABASE_PASSWORD}` has resolved to a plain string long before the
 * merged tree exists — and the documentation says so in both languages.  A
 * test that only showed the heuristic working would let that sentence rot
 * into a promise the code does not keep.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
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

describe('configDumpLines — the text the dump writes', () => {
  test('a value whose KEY says it is a secret is withheld', () => {
    const text = configDumpLines(layered({
      'actor-ts': { cache: { redis: { password: 'hunter2' } } },
    }));

    expect(text).toContain('actor-ts.cache.redis.password = <redacted>');
    expect(text).not.toContain('hunter2');
  });

  test('a secret whose key does NOT say so is printed — the stated gap', () => {
    // `dsn` matches none of pass|secret|token|key|credential|auth, and the
    // value carries the password inside a URL.  Both docs pages say this in
    // as many words; this is the assertion that keeps them true.
    const text = configDumpLines(layered({
      'my-app': { database: { dsn: 'postgres://user:hunter2@db/app' } },
    }));

    expect(text).toContain('my-app.database.dsn = "postgres://user:hunter2@db/app"');
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
});
