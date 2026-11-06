/**
 * Profiles and the secrets file — the two layers `Config.load` gained (#1546).
 *
 * Every file here is written to a fresh temporary directory and named by an
 * explicit option, and the three environment variables `Config.load` reads
 * are cleared around each load unless a case sets one on purpose — so neither
 * a stray `application.conf` or `secrets.conf` beside the test runner nor a
 * profile exported in the shell running it can decide what a case sees.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config, ConfigError, type LoadOptions } from '../../../src/config/Config.js';
import { configDumpLines, secretLayerPaths } from '../../../src/diagnostics/ConfigDump.js';
import { NoopLogger } from '../../../src/Logger.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A fresh directory holding `files`, removed after the case. */
function directoryWith(files: Readonly<Record<string, string>>): string {
  const directory = mkdtempSync(join(tmpdir(), 'actor-ts-config-profiles-'));
  directories.push(directory);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content, 'utf8');
  return directory;
}

/** The variables `Config.load` reads, so a case can clear them all. */
const LOAD_VARIABLES = [
  'ACTOR_TS_CONFIG', 'ACTOR_TS_PROFILE', 'ACTOR_TS_SECRETS_CONF', 'ACTOR_TS_REFERENCE_CONFIG', 'ACTOR_TS_ENV_FILE',
] as const;

/**
 * Run `body` with the load variables cleared and `variables` set on top,
 * restoring every one of them afterwards — `undefined` deletes.
 */
function withEnvironment<T>(variables: Readonly<Record<string, string | undefined>>, body: () => T): T {
  const names = [...new Set([...LOAD_VARIABLES, ...Object.keys(variables)])];
  const previous = new Map(names.map((name) => [name, process.env[name]] as const));
  for (const name of names) {
    const value = variables[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** `Config.load` with the load variables cleared. */
const load = (options: LoadOptions): Config => withEnvironment({}, () => Config.load(options));

/**
 * Paths to the files of `directory`, whichever of them exist — every file
 * `Config.load` reads, so none is taken from the working directory.
 */
const filesOf = (directory: string): LoadOptions => ({
  appConfPath: join(directory, 'application.conf'),
  secretsConfPath: join(directory, 'secrets.conf'),
  referenceConfPath: join(directory, 'reference.conf'),
  environmentFilePath: join(directory, '.env'),
});

/** One key per layer, each set by its own layer and by every layer below it. */
const PRECEDENCE_FILES = {
  'application.conf': [
    'actor-ts.dispatcher.throughput = 3',
    'my-app { a = "application", b = "application", c = "application", d = "application", e = "application" }',
    'profiles.production.my-app { b = "application-profile", c = "application-profile",'
      + ' d = "application-profile", e = "application-profile" }',
    'profiles.staging.my-app { b = "staging" }',
  ].join('\n'),
  'secrets.conf': [
    'my-app { c = "secrets", d = "secrets", e = "secrets" }',
    'profiles.production.my-app { d = "secrets-profile", e = "secrets-profile" }',
  ].join('\n'),
} as const;

describe('Config.load — the six layers and their order', () => {
  test('reference < application < its profile < secrets < its profile < overrides', () => {
    const directory = directoryWith(PRECEDENCE_FILES);
    const config = load({
      ...filesOf(directory),
      profile: 'production',
      overrides: { 'my-app': { e: 'override' } },
    });

    expect(config.getString('my-app.a')).toBe('application');
    expect(config.getString('my-app.b')).toBe('application-profile');
    expect(config.getString('my-app.c')).toBe('secrets');
    expect(config.getString('my-app.d')).toBe('secrets-profile');
    expect(config.getString('my-app.e')).toBe('override');
    expect(config.getInt('actor-ts.dispatcher.throughput')).toBe(3);
    // A key only reference.conf sets is still there underneath all of it.
    expect(config.getInt('actor-ts.sharding.number-of-shards')).toBe(64);
  });

  test('the layers are kept whole, each with the keys its own part of a file set', () => {
    const directory = directoryWith(PRECEDENCE_FILES);
    const layers = load({ ...filesOf(directory), profile: 'production' })._sources()!;

    expect(layers.application.getString('my-app.b')).toBe('application');
    expect(layers.applicationProfile.getString('my-app.b')).toBe('application-profile');
    expect(layers.applicationProfile.hasPath('my-app.a')).toBe(false);
    expect(layers.secrets.getString('my-app.d')).toBe('secrets');
    expect(layers.secretsProfile.getString('my-app.d')).toBe('secrets-profile');
    expect(layers.secretsProfile.hasPath('my-app.c')).toBe(false);
    expect(layers.profile).toBe('production');
    expect(layers.applicationPath).toBe(join(directory, 'application.conf'));
    expect(layers.applicationFound).toBe(true);
    expect(layers.secretsPath).toBe(join(directory, 'secrets.conf'));
    expect(layers.secretsFound).toBe(true);
  });

  test('without a profile, both files contribute their root and nothing else', () => {
    const directory = directoryWith(PRECEDENCE_FILES);
    const config = load(filesOf(directory));

    expect(config.getString('my-app.b')).toBe('application');
    expect(config.getString('my-app.d')).toBe('secrets');
    expect(config._sources()!.profile).toBeNull();
    expect(config._sources()!.applicationProfile.toJSON()).toEqual({});
  });
});

describe('Config.load — the profiles block is stripped', () => {
  test('no profile, active or not, reaches the effective tree', () => {
    const directory = directoryWith(PRECEDENCE_FILES);

    for (const profile of [undefined, 'production', 'staging']) {
      const config = load({ ...filesOf(directory), profile });
      expect(Object.keys(config.toJSON())).not.toContain('profiles');
      expect(config.hasPath('profiles')).toBe(false);
    }
  });

  test('a key called profiles below the root is an ordinary key', () => {
    const directory = directoryWith({ 'application.conf': 'my-app.profiles { admin = "all" }' });

    expect(load(filesOf(directory)).getString('my-app.profiles.admin')).toBe('all');
  });

  test('an inactive profile is never resolved, so a variable only it needs may be unset', () => {
    // The production profile reads a variable a laptop does not have.  It must
    // not stop a run without that profile from starting.
    const directory = directoryWith({
      'application.conf': 'profiles.production.my-app.password = ${ACTOR_TS_TEST_1546_UNSET}',
    });

    expect(() => load(filesOf(directory))).not.toThrow();
    expect(() => load({ ...filesOf(directory), profile: 'production' }))
      .toThrow('Unresolved substitution: ${ACTOR_TS_TEST_1546_UNSET}');
  });

  test('a root profiles key in the code overrides is refused, not dropped', () => {
    // A silently ignored block is the failure this refuses: profiles are read
    // from the two files `Config.load` reads itself, never from code.
    expect(() => load({ overrides: { profiles: { production: { 'my-app': { x: 1 } } } } }))
      .toThrow(ConfigError);
    expect(() => load({ overrides: Config.parseString('profiles.production.my-app.x = 1') }))
      .toThrow(/reserved/);
  });

  test('a root profiles key that is not a block of profiles is refused', () => {
    const notABlock = directoryWith({ 'application.conf': 'profiles = "production"' });
    const notAProfile = directoryWith({ 'application.conf': 'profiles.production = 5' });

    expect(() => load(filesOf(notABlock))).toThrow(ConfigError);
    // Refused whether or not that profile is the active one, so a broken
    // production block fails on the first run anywhere, not in production.
    expect(() => load(filesOf(notAProfile))).toThrow('profiles.production');
  });
});

describe('Config.load — selecting the profile', () => {
  test('a profile no file defines is refused, naming the ones that are', () => {
    const directory = directoryWith({
      'application.conf': 'profiles { production {}, staging {} }',
      'secrets.conf': 'profiles.vault-only {}',
    });

    expect(() => load({ ...filesOf(directory), profile: 'prodution' }))
      .toThrow(/profile "prodution".*not defined.*production, staging, vault-only/s);
  });

  test('a profile is refused even when there is no file at all to define it', () => {
    expect(() => load({
      appConfPath: 'no-such-application.conf',
      secretsConfPath: 'no-such-secrets.conf',
      profile: 'production',
    })).toThrow(/not defined.*none/s);
  });

  test('a profile defined only by the secrets file is enough', () => {
    const directory = directoryWith({
      'application.conf': 'my-app.x = "root"',
      'secrets.conf': 'profiles.production.my-app.x = "secret"',
    });

    expect(load({ ...filesOf(directory), profile: 'production' }).getString('my-app.x')).toBe('secret');
  });

  test('ACTOR_TS_PROFILE selects one, and the option beats it', () => {
    const directory = directoryWith(PRECEDENCE_FILES);
    const options = filesOf(directory);

    withEnvironment({ ACTOR_TS_PROFILE: 'staging' }, () => {
      expect(Config.load(options).getString('my-app.b')).toBe('staging');
      expect(Config.load({ ...options, profile: 'production' }).getString('my-app.b'))
        .toBe('application-profile');
      // An empty option is the code's way of saying "no profile", whatever
      // the environment says.
      expect(Config.load({ ...options, profile: '' }).getString('my-app.b')).toBe('application');
    });
  });

  test('the refusal says which of the two selected the profile', () => {
    const directory = directoryWith({ 'application.conf': 'profiles.production {}' });

    withEnvironment({ ACTOR_TS_PROFILE: 'prod' }, () => {
      expect(() => Config.load(filesOf(directory))).toThrow('ACTOR_TS_PROFILE');
    });
  });

  test('an empty ACTOR_TS_PROFILE selects no profile', () => {
    const directory = directoryWith(PRECEDENCE_FILES);

    withEnvironment({ ACTOR_TS_PROFILE: '' }, () => {
      expect(Config.load(filesOf(directory))._sources()!.profile).toBeNull();
    });
  });

  test('ActorSystemOptions.withProfile reaches system.config', async () => {
    const directory = directoryWith(PRECEDENCE_FILES);
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfigFile(join(directory, 'application.conf'))
      .withProfile('production');
    const system = withEnvironment({}, () => ActorSystem.create('config-profiles', systemOptions));
    try {
      expect(system.config.getString('my-app.b')).toBe('application-profile');
      expect(system.config._sources()!.profile).toBe('production');
    } finally {
      await system.terminate();
    }
  });
});

describe('Config.load — the secrets file', () => {
  test('a secrets file that is not there is an empty layer, not an error', () => {
    const missing = join(directoryWith({}), 'secrets.conf');
    const config = load({ appConfPath: 'no-such-application.conf', secretsConfPath: missing });
    const layers = config._sources()!;

    expect(layers.secretsPath).toBe(missing);
    expect(layers.secretsFound).toBe(false);
    expect(layers.secrets.toJSON()).toEqual({});
    expect(config.getInt('actor-ts.sharding.number-of-shards')).toBe(64);
  });

  test('without an option or ACTOR_TS_SECRETS_CONF it is ./secrets.conf in the working directory', () => {
    const directory = directoryWith({ 'secrets.conf': 'my-app.token = "from-the-working-directory"' });
    const previous = process.cwd();
    let config: Config;
    // Synchronous from chdir to restore, so nothing else in this file can run
    // with the working directory moved.
    process.chdir(directory);
    try {
      config = load({ appConfPath: 'no-such-application.conf' });
    } finally {
      process.chdir(previous);
    }

    expect(config.getString('my-app.token')).toBe('from-the-working-directory');
    expect(config._sources()!.secretsPath).toBe(resolve(directory, 'secrets.conf'));
  });

  test('ACTOR_TS_SECRETS_CONF names it, and the option beats the variable', () => {
    const fromVariable = directoryWith({ 'secrets.conf': 'my-app.token = "variable"' });
    const fromOption = directoryWith({ 'secrets.conf': 'my-app.token = "option"' });
    const variablePath = join(fromVariable, 'secrets.conf');

    withEnvironment({ ACTOR_TS_SECRETS_CONF: variablePath }, () => {
      const base = { appConfPath: 'no-such-application.conf' };
      expect(Config.load(base).getString('my-app.token')).toBe('variable');
      expect(Config.load({ ...base, secretsConfPath: join(fromOption, 'secrets.conf') }).getString('my-app.token'))
        .toBe('option');
    });
  });
});

/** What `body` threw, or `null` — so a case can restore the working directory before it asserts. */
function thrownBy(body: () => unknown): unknown {
  try {
    body();
  } catch (error) {
    return error;
  }
  return null;
}

/** `body` run with `directory` as the working directory, synchronously, and what it threw. */
function thrownInWorkingDirectory(directory: string, body: () => unknown): unknown {
  const previous = process.cwd();
  // Synchronous from chdir to restore, so nothing else in this file can run
  // with the working directory moved.
  process.chdir(directory);
  try {
    return thrownBy(body);
  } finally {
    process.chdir(previous);
  }
}

/** Another tool's file of the same name: nginx syntax, which is not HOCON. */
const NOT_HOCON = 'server {\n  listen 80;\n}\n';

describe('Config.load — a file that cannot be loaded names itself and why it was read', () => {
  test('a ./secrets.conf nothing named says it was read from the working directory', () => {
    // Read on every start from wherever the process starts, so a file of that
    // name may well belong to something else.
    const directory = directoryWith({ 'secrets.conf': NOT_HOCON });
    const thrown = thrownInWorkingDirectory(directory, () => load({ appConfPath: 'no-such-application.conf' }));

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).toBe(
      `The secrets file ${resolve(directory, 'secrets.conf')} could not be loaded: HOCON parse error at line 2, `
      + 'col 10: Expected \'=\' or \':\' after key "listen".  Config.load read it because it is secrets.conf in the '
      + 'working directory, which is read whenever neither LoadOptions.secretsConfPath nor ACTOR_TS_SECRETS_CONF '
      + 'names another file — if that one is not this application\'s, move it, or name the right one.',
    );
    // The parser's own error stays reachable.
    expect(((thrown as ConfigError).cause as Error).message).toStartWith('HOCON parse error at line 2, col 10');
  });

  test('a secrets file a variable or the option named says which', () => {
    const directory = directoryWith({ 'secrets.conf': NOT_HOCON });
    const path = join(directory, 'secrets.conf');
    const base = { appConfPath: 'no-such-application.conf' };

    const fromVariable = withEnvironment({ ACTOR_TS_SECRETS_CONF: path }, () => thrownBy(() => Config.load(base)));
    expect((fromVariable as ConfigError).message).toStartWith(`The secrets file ${path} could not be loaded: `);
    expect((fromVariable as ConfigError).message).toEndWith('Config.load read it because ACTOR_TS_SECRETS_CONF names it.');

    const fromOption = thrownBy(() => load({ ...base, secretsConfPath: path }));
    expect((fromOption as ConfigError).message).toEndWith('Config.load read it because LoadOptions.secretsConfPath names it.');
  });

  test('so does the application file, found in the working directory or named', () => {
    const directory = directoryWith({ 'application.conf': NOT_HOCON });
    const path = resolve(directory, 'application.conf');

    const fromWorkingDirectory = thrownInWorkingDirectory(directory, () => load({}));
    expect((fromWorkingDirectory as ConfigError).message).toStartWith(`The application file ${path} could not be loaded: `);
    expect((fromWorkingDirectory as ConfigError).message).toContain(
      'because it is application.conf in the working directory, which is read whenever neither '
      + 'withConfigFile / LoadOptions.appConfPath nor ACTOR_TS_CONFIG names another file',
    );

    const fromOption = thrownBy(() => load({ appConfPath: path }));
    expect((fromOption as ConfigError).message)
      .toEndWith('Config.load read it because withConfigFile / LoadOptions.appConfPath names it.');
    const fromVariable = withEnvironment({ ACTOR_TS_CONFIG: path }, () => thrownBy(() => Config.load({})));
    expect((fromVariable as ConfigError).message).toEndWith('Config.load read it because ACTOR_TS_CONFIG names it.');
  });

  test('a path that is there but cannot be read is refused the same way', () => {
    // A directory called secrets.conf: it exists, so it is no empty layer.
    const directory = directoryWith({});
    mkdirSync(join(directory, 'secrets.conf'));
    const thrown = thrownInWorkingDirectory(directory, () => load({ appConfPath: 'no-such-application.conf' }));

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).toStartWith(
      `The secrets file ${resolve(directory, 'secrets.conf')} could not be loaded: `,
    );
    expect((thrown as ConfigError).message).toContain('because it is secrets.conf in the working directory');
  });
});

describe('Config.load — how a file with a profile resolves its substitutions', () => {
  const ALIASED = [
    'my-app.host = "localhost"',
    'my-app.primary-host = ${my-app.host}',
    'profiles.production.my-app.host = "prod.example"',
  ].join('\n');

  test('the profile is laid over the root first, so a root alias follows the profile', () => {
    const directory = directoryWith({ 'application.conf': ALIASED });

    const production = load({ ...filesOf(directory), profile: 'production' });
    expect(production.getString('my-app.host')).toBe('prod.example');
    expect(production.getString('my-app.primary-host')).toBe('prod.example');

    const none = load(filesOf(directory));
    expect(none.getString('my-app.primary-host')).toBe('localhost');
  });

  test('the root layer keeps what the root wrote, with its alias read through the overlay', () => {
    const directory = directoryWith({ 'application.conf': ALIASED });
    const layers = load({ ...filesOf(directory), profile: 'production' })._sources()!;

    expect(layers.application.getString('my-app.host')).toBe('localhost');
    expect(layers.application.getString('my-app.primary-host')).toBe('prod.example');
  });

  test('a profile ${?VAR} that finds nothing leaves the root value, and the profile layer without the key', () => {
    const directory = directoryWith({
      'application.conf': [
        'my-app.port = 2552',
        'profiles.production.my-app.port = ${?ACTOR_TS_TEST_1546_UNSET_PORT}',
      ].join('\n'),
    });
    const config = load({ ...filesOf(directory), profile: 'production' });

    expect(config.getInt('my-app.port')).toBe(2552);
    expect(config._sources()!.applicationProfile.hasPath('my-app.port')).toBe(false);
  });

  test('a file reads the layers beneath it (#1785): the secrets file reads the application file', () => {
    // #1546 kept each file resolving alone (#1071); a file now also reads the
    // layers already resolved beneath it — downward only.
    const directory = directoryWith({
      'application.conf': 'my-app.host = "db.internal"',
      'secrets.conf': 'my-app.dsn-host = ${my-app.host}',
    });

    const config = load(filesOf(directory));
    expect(config.getString('my-app.dsn-host')).toBe('db.internal');
    // The value is the secrets file's own: the application layer does not gain it.
    expect(config._sources()!.secrets.hasPath('my-app.dsn-host')).toBe(true);
    expect(config._sources()!.application.hasPath('my-app.dsn-host')).toBe(false);
  });

  test('and a profile reads reference.conf (#1785)', () => {
    const directory = directoryWith({
      'application.conf': 'profiles.production.my-app.system = ${actor-ts.system.name}',
    });

    expect(load({ ...filesOf(directory), profile: 'production' }).getString('my-app.system')).toBe('default');
  });

  test('never upward: the application file cannot read the secrets file', () => {
    const directory = directoryWith({
      'application.conf': 'my-app.copy = ${my-app.password}',
      'secrets.conf': 'my-app.password = "s3cret"',
    });

    expect(() => load(filesOf(directory))).toThrow('Unresolved substitution: ${my-app.password}');
  });

  /**
   * The refusal's own words for `reference` in `file` — asserted whole,
   * because the reference alone is in the generic "Unresolved substitution"
   * message too, so a pin on it holds with the refusal gone.
   */
  const profilesReferenceRefusal = (reference: string, file: string): string =>
    `\${${reference}} in ${file} reads the profiles block, which Config.load strips before it resolves the file.`;

  test('a substitution that reads the profiles block is refused by name', () => {
    // The block is stripped before the file resolves, so such a reference
    // could only ever fail — said here instead of as an unresolved one.
    const directory = directoryWith({
      'application.conf': [
        'profiles.production.my-app.x = 1',
        'my-app.x = ${profiles.production.my-app.x}',
      ].join('\n'),
    });

    expect(() => load(filesOf(directory))).toThrow(
      profilesReferenceRefusal('profiles.production.my-app.x', join(directory, 'application.conf')),
    );
  });

  test('so is one naming the tree load resolves the file in, or the bare block', () => {
    // `load` resolves a file's root and its active profile inside one tree,
    // under the reserved key.  Unrefused, the first reads the root's own value
    // out of it and the second splices that whole tree into itself.
    for (const reference of ['profiles.root.my-app.x', 'profiles']) {
      const directory = directoryWith({
        'application.conf': ['my-app.x = 1', `my-app.y = \${${reference}}`].join('\n'),
      });

      expect(() => load(filesOf(directory))).toThrow(
        profilesReferenceRefusal(reference, join(directory, 'application.conf')),
      );
    }
  });

  test('and so is one in the active profile', () => {
    const directory = directoryWith({
      'application.conf': [
        'my-app.x = 1',
        'profiles.production.my-app.y = ${profiles.root.my-app.x}',
      ].join('\n'),
    });

    expect(() => load({ ...filesOf(directory), profile: 'production' })).toThrow(
      profilesReferenceRefusal('profiles.root.my-app.x', join(directory, 'application.conf')),
    );
  });
});

describe('Config.load — copying one profile into another', () => {
  test('profiles.staging = ${profiles.production} copies the whole block verbatim', () => {
    const directory = directoryWith({
      'application.conf': [
        'my-app.host = "localhost"',
        'profiles.production.my-app { host = "prod.example", replicas = 3 }',
        'profiles.staging = ${profiles.production}',
      ].join('\n'),
    });
    const config = load({ ...filesOf(directory), profile: 'staging' });

    expect(config.getString('my-app.host')).toBe('prod.example');
    expect(config.getInt('my-app.replicas')).toBe(3);
  });

  test('a later delta replaces the copy rather than merging into it — the limit the docs state (#537)', () => {
    // HOCON would merge `b = 3` into the copied block.  This parser replaces
    // the substitution instead, so `host` is gone; the docs say so, and this
    // turns red when the parser learns to merge, so they can stop saying it.
    const directory = directoryWith({
      'application.conf': [
        'profiles.production.my-app { host = "prod.example", replicas = 3 }',
        'profiles.staging = ${profiles.production}',
        'profiles.staging.my-app.replicas = 1',
      ].join('\n'),
    });
    const config = load({ ...filesOf(directory), profile: 'staging' });

    expect(config.getInt('my-app.replicas')).toBe(1);
    expect(config.hasPath('my-app.host')).toBe(false);
  });

  test('a copy of a profile the file does not define is refused', () => {
    const directory = directoryWith({ 'application.conf': 'profiles.staging = ${profiles.production}' });

    expect(() => load(filesOf(directory))).toThrow('profiles.staging');
  });
});

/** How long a load may take once the child has started it — see {@link loadInChild}. */
const CHILD_LOAD_CAP_MS = 1_000;
/** How long the child may take to get that far: starting a runtime and importing the loader. */
const CHILD_STARTUP_CAP_MS = 20_000;

/**
 * What the child runs: one `Config.load` of the files its environment names,
 * reported as `name: message`, or `loaded`.  The line before the load is
 * written synchronously, so it has left the process before the load starts.
 */
const CHILD_SCRIPT = [
  "import { writeSync } from 'node:fs';",
  'const { Config } = await import(process.env.CHILD_CONFIG_MODULE);',
  "writeSync(1, 'loading\\n');",
  'let outcome;',
  'try {',
  '  Config.load({',
  '    appConfPath: process.env.CHILD_APPLICATION_CONF,',
  '    secretsConfPath: process.env.CHILD_SECRETS_CONF,',
  '  });',
  "  outcome = 'loaded';",
  '} catch (error) {',
  "  outcome = String(error && error.name) + ': ' + String(error && error.message);",
  '}',
  "writeSync(1, JSON.stringify({ outcome }) + '\\n');",
].join('\n');

/**
 * `Config.load` of the files in `directory`, run in a child process: the
 * refusal as `name: message`, `loaded`, or what stopped the child.
 *
 * In a child, and capped there, because a copy cycle nobody refuses is a loop
 * inside one synchronous call — this runner's per-test timeout cannot
 * interrupt it, and it allocates as fast as it loops, hundreds of megabytes a
 * second.  So the cap starts only once the child says it is about to load, a
 * slow start does not count against it, and it is short: a refusal takes a
 * millisecond.
 */
function loadInChild(directory: string): Promise<string> {
  const script = join(directory, 'load-in-child.mjs');
  writeFileSync(script, CHILD_SCRIPT, 'utf8');
  const environment: Record<string, string | undefined> = {
    ...process.env,
    CHILD_CONFIG_MODULE: pathToFileURL(resolve(import.meta.dir, '../../../src/config/Config.ts')).href,
    CHILD_APPLICATION_CONF: join(directory, 'application.conf'),
    CHILD_SECRETS_CONF: join(directory, 'secrets.conf'),
  };
  for (const name of LOAD_VARIABLES) delete environment[name];
  return new Promise((resolveOutcome) => {
    const child = spawn(process.execPath, [script], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let outcome: string | null = null;
    let loadCap: ReturnType<typeof setTimeout> | undefined;
    const decide = (decided: string): void => {
      if (outcome !== null) return;
      outcome = decided;
      clearTimeout(startupCap);
      clearTimeout(loadCap);
      child.kill();
    };
    const startupCap = setTimeout(
      () => decide(`the child did not start loading within ${CHILD_STARTUP_CAP_MS} ms: ${stderr}`),
      CHILD_STARTUP_CAP_MS,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (loadCap === undefined && stdout.includes('loading\n')) {
        loadCap = setTimeout(
          () => decide(`Config.load did not return within ${CHILD_LOAD_CAP_MS} ms`),
          CHILD_LOAD_CAP_MS,
        );
      }
      const report = stdout.split('\n').find((line) => line.startsWith('{'));
      if (report !== undefined) decide((JSON.parse(report) as { readonly outcome: string }).outcome);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    // `close`, not `exit`: it comes after the last of the output, and once the
    // process is gone, so the directory can be removed.
    child.on('close', (code, signal) => {
      decide(`the child ended (${code ?? signal}) without an outcome: ${stderr}`);
      resolveOutcome(outcome!);
    });
  });
}

describe('Config.load — a profile copy that comes back round', () => {
  // Every profile is followed when the file is read, active or not, so no
  // profile is selected here.  Without the refusal the walk never ends.
  test('a cycle of two is refused by name', async () => {
    const directory = directoryWith({
      'application.conf': [
        'profiles.a = ${profiles.b}',
        'profiles.b = ${profiles.a}',
      ].join('\n'),
    });

    expect(await loadInChild(directory)).toBe(
      `ConfigError: profiles.a in ${join(directory, 'application.conf')} copies itself through \${profiles.b}`,
    );
  }, 30_000);

  test('so is a cycle of three', async () => {
    const directory = directoryWith({
      'application.conf': [
        'profiles.a = ${profiles.b}',
        'profiles.b = ${profiles.c}',
        'profiles.c = ${profiles.a}',
      ].join('\n'),
    });

    expect(await loadInChild(directory)).toBe(
      `ConfigError: profiles.a in ${join(directory, 'application.conf')} copies itself through \${profiles.b}`,
    );
  }, 30_000);
});

describe('the secrets file in the config dump', () => {
  test('a value the secrets file set is withheld whatever its key is called', () => {
    const directory = directoryWith({ 'secrets.conf': 'my-app.db.endpoint-value = "s3cr3t"' });
    const text = configDumpLines(load({
      appConfPath: 'no-such-application.conf',
      secretsConfPath: join(directory, 'secrets.conf'),
    }));

    expect(text).toContain('my-app.db.endpoint-value = <redacted>  [secrets]');
    expect(text).not.toContain('s3cr3t');
  });

  test('a worker-shaped load, its whole tree one overrides object, still withholds it', () => {
    // WorkerMesh hands every worker `system.config.toJSON()` as its overrides,
    // so each leaf of a worker's tree is won by `override`.  The worker's own
    // load reads the same secrets file — the variable names it in both
    // threads — and a secrets layer that holds the key is what decides.
    const directory = directoryWith({ 'secrets.conf': 'my-app.db.endpoint-value = "s3cr3t"' });

    withEnvironment({ ACTOR_TS_SECRETS_CONF: join(directory, 'secrets.conf') }, () => {
      const main = Config.load({ appConfPath: 'no-such-application.conf' });
      const worker = Config.load({ appConfPath: 'no-such-application.conf', overrides: main.toJSON() });
      const text = configDumpLines(worker);

      expect(text).toContain('my-app.db.endpoint-value = <redacted>  [override, overrides a lower layer]');
      expect(text).not.toContain('s3cr3t');
    });
  });

  test('a loaded config passed back in as overrides keeps its secrets withheld', () => {
    // How code names a secrets file for an ActorSystem: withConfig(Config.load({
    // secretsConfPath })).  The outer load sees no secrets file of its own, and
    // its overrides layer is that loaded config — whose own layers say which
    // of its keys the file set.
    const directory = directoryWith({ 'secrets.conf': 'my-app.db.endpoint-value = "s3cr3t"' });
    const inner = load({ appConfPath: 'no-such-application.conf', secretsConfPath: join(directory, 'secrets.conf') });
    const text = configDumpLines(load({ appConfPath: 'no-such-application.conf', overrides: inner }));

    expect(text).toContain('my-app.db.endpoint-value = <redacted>  [override]');
    expect(text).not.toContain('s3cr3t');
  });

  test('a worker load that cannot see the file withholds the paths its main thread carried over', () => {
    // A tree that left its load as plain data — a WorkerMesh init frame — and
    // the paths the main thread withheld by layer, carried beside it.
    const directory = directoryWith({ 'secrets.conf': 'my-app.db.endpoint-value = "s3cr3t"' });
    const main = load({ appConfPath: 'no-such-application.conf', secretsConfPath: join(directory, 'secrets.conf') });
    const carried = Config._withSecretPaths(main.toJSON(), secretLayerPaths(main));
    const text = configDumpLines(load({ appConfPath: 'no-such-application.conf', overrides: carried }));

    expect(secretLayerPaths(main)).toEqual(['my-app.db.endpoint-value']);
    expect(text).toContain('my-app.db.endpoint-value = <redacted>  [override]');
    expect(text).not.toContain('s3cr3t');
  });
});
