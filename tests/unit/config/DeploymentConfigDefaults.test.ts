/**
 * `actor-ts.deployment` (#868) — per-path entries read into the record the
 * system compiles once, and the precedence that picks one entry per actor.
 *
 * The reader has to get three things right, and each is easy to get wrong in
 * a way `toEqual` cannot see.  The keys are the application's actor paths, so
 * they come back verbatim, a `.` in an actor name included — a reader that
 * went through `Config.hasPath` would split `/user/ingest.v2` at the dot and
 * read nothing.  An entry keeps only the leaves it sets, because the cell
 * layers each one over the system default with `??` and an own `undefined`
 * would read as "set".  And everything a deployment could get wrong is
 * refused when the system starts, naming the key, rather than turning into an
 * entry that silently matches nothing.  So every read goes through
 * `expectExactOptions`, and every refusal through `ActorSystem.create`.
 *
 * Whether the cell applies what is read — the bound, the batch, the
 * provenance rule — is `tests/unit/mailbox/DeploymentBlock.test.ts`'s
 * business.  `Config.parseString` throughout for the blocks: `Config.fromObject`
 * with a dotted key keeps it as one literal top-level key.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ActorPath } from '../../../src/ActorPath.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import type { ConfigObject, ConfigValue } from '../../../src/config/HoconParser.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { compileDeployment, readDeploymentFromConfig } from '../../../src/internal/Deployment.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { expectExactOptions } from '../../util/ExactOptions.js';

/** An actor path built the way a cell builds one: a nameless root, then one name per level. */
function actorPathOf(address: string): ActorPath {
  return address.split('/').filter((name) => name !== '')
    .reduce((parent, name) => parent.child(name), new ActorPath('', null, 'deployment-test'));
}

/** The key of the entry `lookup` picks for `address`, or `undefined` for none. */
function winnerOf(keys: readonly string[], address: string): string | undefined {
  // Each entry's throughput is its key's position, so the entry identifies its key.
  const configuration = Object.fromEntries(keys.map((key, index) => [key, { throughput: index + 1 }]));
  const entry = compileDeployment(configuration)!.lookup(actorPathOf(address));
  return entry === undefined ? undefined : keys[entry.throughput! - 1];
}

/** What `ActorSystem.create` threw for a system whose deployment block is `deployment`. */
async function refusalOf(deployment: ConfigObject): Promise<ConfigError> {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { deployment } });
  let caught: unknown = null;
  let started: ActorSystem | null = null;
  try { started = ActorSystem.create('deployment-refusal', options); } catch (error) { caught = error; }
  // A system that started is the failure asserted below; it must not hold the runner open.
  await started?.terminate();
  expect(caught).toBeInstanceOf(ConfigError);
  return caught as ConfigError;
}

describe('readDeploymentFromConfig', () => {
  test('the shipped reference.conf configures no entry', () => {
    // The block ships comment-only: an entry there would be a live default in
    // every deployment, and a capacity in it the bound #1148 removed.
    expectExactOptions(readDeploymentFromConfig(Config.parseString(REFERENCE_CONF)), {});
  });

  test('an absent block reads as no entry', () => {
    expectExactOptions(readDeploymentFromConfig(Config.parseString('actor-ts.system.name = x')), {});
  });

  test('a configured block reads back exactly: keys verbatim, a dot in a name kept, unset leaves omitted', () => {
    const config = Config.parseString(`
      actor-ts.deployment {
        "/user/ingest" { throughput = 64, mailbox-capacity = 10000, mailbox-overflow = "drop-new" }
        "/user/ingest.v2" { throughput = 8 }
        "/user/chat/ws-*" { mailbox-capacity = 256 }
        "/user/special" { }
        "/system/cluster/sharding/region-orders/**" { mailbox-capacity = 0, mailbox-overflow = "reject" }
      }
    `);

    expectExactOptions(readDeploymentFromConfig(config), {
      '/user/ingest': { throughput: 64, mailboxCapacity: 10_000, mailboxOverflow: 'drop-new' },
      '/user/ingest.v2': { throughput: 8 },
      '/user/chat/ws-*': { mailboxCapacity: 256 },
      '/user/special': {},
      '/system/cluster/sharding/region-orders/**': { mailboxCapacity: 0, mailboxOverflow: 'reject' },
    });
  });

  test('each of the three overflow policies reads back exactly as written', () => {
    for (const overflow of ['drop-head', 'drop-new', 'reject'] as const) {
      const config = Config.parseString(`actor-ts.deployment { "/user/x" { mailbox-overflow = "${overflow}" } }`);
      expectExactOptions(readDeploymentFromConfig(config), { '/user/x': { mailboxOverflow: overflow } });
    }
  });

  test('a throughput of 0 or below reads as 1, the clamp actor.throughput applies', () => {
    const config = Config.parseString(`
      actor-ts.deployment {
        "/user/zero" { throughput = 0 }
        "/user/negative" { throughput = -3 }
      }
    `);

    expectExactOptions(readDeploymentFromConfig(config), {
      '/user/zero': { throughput: 1 },
      '/user/negative': { throughput: 1 },
    });
  });

  test('a file layer and a code layer merge per entry, leaf by leaf', () => {
    const directory = mkdtempSync(join(tmpdir(), 'actor-ts-deployment-'));
    try {
      const applicationConf = join(directory, 'application.conf');
      writeFileSync(applicationConf, [
        'actor-ts.deployment {',
        '  "/user/x" { throughput = 4, mailbox-overflow = "reject" }',
        '  "/user/file-only" { mailbox-capacity = 7 }',
        '}',
      ].join('\n'));
      const config = Config.load({
        appConfPath: applicationConf,
        secretsConfPath: join(directory, 'no-secrets.conf'),
        profile: '',
        overrides: { 'actor-ts': { deployment: { '/user/x': { 'mailbox-capacity': 3, throughput: 9 } } } },
      });

      // The code layer wins where both set a leaf, and leaves the file's others.
      expectExactOptions(readDeploymentFromConfig(config), {
        '/user/x': { throughput: 9, mailboxOverflow: 'reject', mailboxCapacity: 3 },
        '/user/file-only': { mailboxCapacity: 7 },
      });
    } finally {
      if (directory !== '') rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a block that is not an object is refused, naming the key', () => {
    expect(() => readDeploymentFromConfig(Config.parseString('actor-ts.deployment = 5')))
      .toThrow(/actor-ts\.deployment/);
  });
});

describe('a deployment block the system refuses to start with', () => {
  test.each([
    ['user/x', 'not absolute'],
    ['/user//x', 'an empty segment'],
    ['/user/x/', 'a trailing separator'],
    ['/user/./x', 'a "." segment'],
    ['/user/../x', 'a ".." segment'],
    ['/user', 'a guardian'],
    ['/*', 'nothing but a guardian'],
    ['/', 'the root'],
  ])('the key %s (%s) is refused, naming it', async (key) => {
    const refusal = await refusalOf({ [key]: { throughput: 2 } });

    expect(refusal.message).toContain(`actor-ts.deployment.${JSON.stringify(key)}`);
  });

  test('an entry that is not a block is refused, naming its key', async () => {
    const refusal = await refusalOf({ '/user/x': 5 });

    expect(refusal.message).toContain('actor-ts.deployment."/user/x"');
    expect(refusal.message).toContain('not a bare value');
  });

  test.each(['mailbox-size', 'mailboxCapacity', 'dispatcher'])('the leaf %s is refused, naming key and leaf', async (leaf) => {
    const refusal = await refusalOf({ '/user/x': { [leaf]: 2 } });

    expect(refusal.message).toContain(`actor-ts.deployment."/user/x".${leaf}`);
    for (const known of ['throughput', 'mailbox-capacity', 'mailbox-overflow']) expect(refusal.message).toContain(known);
  });

  test('a camelCase spelling of a leaf is told the kebab-case one', async () => {
    const refusal = await refusalOf({ '/user/x': { mailboxOverflow: 'reject' } });

    expect(refusal.message).toContain('write mailbox-overflow');
  });

  const valueRefusals: Array<[string, ConfigValue]> = [
    ['throughput', 1.5],
    ['throughput', 'fast'],
    ['mailbox-capacity', -1],
    ['mailbox-capacity', 1.5],
    ['mailbox-capacity', 'many'],
    ['mailbox-overflow', 'drop-oldest'],
    ['mailbox-overflow', ['reject']],
  ];

  test.each(valueRefusals)('%s = %p is refused, naming key and leaf', async (leaf, value) => {
    const refusal = await refusalOf({ '/user/x': { [leaf]: value } });

    expect(refusal.message).toContain(`actor-ts.deployment."/user/x".${leaf}`);
    // Refused on its merits and under the full key, never with the getter's
    // kind wording, which names only the leaf inside the entry.
    expect(refusal.message).not.toMatch(/^Config at /);
  });

  test('an overflow outside the three names all three and the value', async () => {
    const refusal = await refusalOf({ '/user/x': { 'mailbox-overflow': 'drop-oldest' } });

    expect(refusal.message).toContain('"drop-oldest"');
    for (const policy of ['drop-head', 'drop-new', 'reject']) expect(refusal.message).toContain(policy);
  });

  test('a block of usable keys starts the system, /** and /system/** included', async () => {
    const options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          deployment: {
            '/**': { throughput: 2 },
            '/system/**': { 'mailbox-capacity': 0 },
            '/user/a.b': { 'mailbox-capacity': 1 },
            '/user/pool/worker-*': { 'mailbox-overflow': 'reject' },
          },
        },
      });
    const system = ActorSystem.create('deployment-accepted', options);
    try {
      expect(system._deployment).not.toBeNull();
    } finally {
      await system.terminate();
    }
  });
});

describe('compileDeployment', () => {
  test('an empty block compiles to nothing, so a cell pays one null check', () => {
    expect(compileDeployment({})).toBeNull();
    expect(compileDeployment(readDeploymentFromConfig(Config.parseString(REFERENCE_CONF)))).toBeNull();
  });

  test('a key matching nothing picks nothing', () => {
    expect(winnerOf(['/user/a', '/user/b*', '/user/c/**'], '/user/z')).toBeUndefined();
    expect(winnerOf(['/user/a'], '/user/a/child')).toBeUndefined();
  });

  test('an exact key matches its actor, a dot in the name included', () => {
    expect(winnerOf(['/user/ingest.v2', '/user/ingest'], '/user/ingest.v2')).toBe('/user/ingest.v2');
    expect(winnerOf(['/user/ingest.v2', '/user/ingest'], '/user/ingest')).toBe('/user/ingest');
  });

  /**
   * Each pair is written in both orders: the record keeps the order the
   * config gave its keys, so a precedence that fell back on that order would
   * pass one direction and fail the other.
   */
  test.each([
    ['an exact key over a `*` key', '/user/a', '/user/*', '/user/a'],
    ['a `*` key over a `**` key', '/user/*', '/user/**', '/user/a'],
    ['an exact key over a `**` key', '/user/a', '/user/**', '/user/a'],
    ['the longer literal prefix', '/user/ab*', '/user/a*b', '/user/abb'],
    ['the longer literal prefix among `**` keys', '/user/pool/**', '/user/**', '/user/pool/worker-1'],
    // Same prefix, so the count decides; code-unit order alone would pick
    // `/user/a*`, the shorter string, so this pair tells the two steps apart.
    ['more literal characters', '/user/a*x', '/user/a*', '/user/abx'],
    ['code-unit order, when prefix and count tie', '/user/a*b*', '/user/a*c*', '/user/abc'],
  ])('%s: %s wins over %s for %s', (_rule, winner, loser, address) => {
    expect(winnerOf([winner, loser], address)).toBe(winner);
    expect(winnerOf([loser, winner], address)).toBe(winner);
  });

  test('the entry is chosen whole: a leaf it leaves out is not taken from a less specific key', () => {
    const index = compileDeployment({
      '/user/**': { throughput: 8, mailboxCapacity: 100 },
      '/user/special': {},
    })!;

    expectExactOptions(index.lookup(actorPathOf('/user/special')), {});
    expectExactOptions(index.lookup(actorPathOf('/user/other')), { throughput: 8, mailboxCapacity: 100 });
  });

  test('`**` reaches any depth and `*` one segment, whatever the last name', () => {
    expect(winnerOf(['/user/hub/**'], '/user/hub/connection/child')).toBe('/user/hub/**');
    expect(winnerOf(['/user/hub/**'], '/user/hub')).toBeUndefined();
    expect(winnerOf(['/user/pool/*'], '/user/pool/worker-1')).toBe('/user/pool/*');
    expect(winnerOf(['/user/pool/*'], '/user/pool/worker-1/child')).toBeUndefined();
    expect(winnerOf(['/**'], '/system/cluster/sharding/shard-0/e-1')).toBe('/**');
  });

  test('a wildcard key whose last segment is a literal name matches that name only', () => {
    // The index rules a key out on the actor's own name before it builds the
    // path, so a literal last segment behind a wildcard is the case where
    // that shortcut has to keep the key in.
    expect(winnerOf(['/user/*/inbox'], '/user/a/inbox')).toBe('/user/*/inbox');
    expect(winnerOf(['/user/**/inbox'], '/user/a/b/inbox')).toBe('/user/**/inbox');
    expect(winnerOf(['/user/*/inbox'], '/user/a/outbox')).toBeUndefined();
    expect(winnerOf(['/user/pool/worker-*'], '/user/pool/worker-7')).toBe('/user/pool/worker-*');
    expect(winnerOf(['/user/pool/worker-*'], '/user/pool/manager')).toBeUndefined();
  });
});
