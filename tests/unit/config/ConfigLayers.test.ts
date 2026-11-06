/**
 * `Config.load` with a project `reference.conf` and a `.env` file (#1785).
 *
 * Every case uses files in a fresh directory, named through `LoadOptions` or
 * an `ACTOR_TS_*` variable, and clears those variables around itself — a
 * file of the same name in the working directory must never answer.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Config, ConfigError, type LoadOptions } from '../../../src/config/Config.js';

const directories: string[] = [];
afterEach(() => {
  // Guarded: `rmSync('', { recursive: true })` empties the working directory on Bun 1.4.2.
  for (const directory of directories.splice(0)) if (directory !== '') rmSync(directory, { recursive: true, force: true });
});

/** A fresh directory holding `files`, removed after the case. */
function directoryWith(files: Readonly<Record<string, string>>): string {
  const directory = mkdtempSync(join(tmpdir(), 'actor-ts-config-layers-'));
  directories.push(directory);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content, 'utf8');
  return directory;
}

const LOAD_VARIABLES = [
  'ACTOR_TS_CONFIG', 'ACTOR_TS_PROFILE', 'ACTOR_TS_SECRETS_CONF', 'ACTOR_TS_REFERENCE_CONFIG', 'ACTOR_TS_ENV_FILE',
] as const;

/** `body` with the load variables cleared and `variables` set, all restored afterwards. */
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

/** The files of `directory`, named one by one, so nothing comes from the working directory. */
const filesOf = (directory: string): LoadOptions => ({
  appConfPath: join(directory, 'application.conf'),
  secretsConfPath: join(directory, 'secrets.conf'),
  referenceConfPath: join(directory, 'reference.conf'),
  environmentFilePath: join(directory, '.env'),
});

const load = (options: LoadOptions, variables: Readonly<Record<string, string>> = {}): Config =>
  withEnvironment(variables, () => Config.load(options));

describe('Config.load — the project reference.conf (#1785)', () => {
  test('sits over the bundled defaults and under the application file, field by field', () => {
    const directory = directoryWith({
      'reference.conf': 'my-app { a = "reference", b = "reference" }\nactor-ts.dispatcher.throughput = 7',
      'application.conf': 'my-app.b = "application"',
    });
    const config = load(filesOf(directory));

    expect(config.getString('my-app.a')).toBe('reference');
    expect(config.getString('my-app.b')).toBe('application');
    expect(config.getInt('actor-ts.dispatcher.throughput')).toBe(7);
    // A bundled key neither file sets keeps the bundled default.
    expect(config.getString('actor-ts.system.name')).toBe('default');
  });

  test('is found through ACTOR_TS_REFERENCE_CONFIG when no option names one', () => {
    const directory = directoryWith({ 'defaults.conf': 'my-app.a = "from-variable"' });
    const config = load(
      { appConfPath: false, secretsConfPath: false, environmentFilePath: false },
      { ACTOR_TS_REFERENCE_CONFIG: join(directory, 'defaults.conf') },
    );
    expect(config.getString('my-app.a')).toBe('from-variable');
  });

  test('has profiles like the other files, and a profile only it defines is defined', () => {
    const directory = directoryWith({
      'reference.conf': 'my-app.pool = 4\nprofiles.production.my-app.pool = 32',
    });
    expect(load({ ...filesOf(directory), profile: 'production' }).getInt('my-app.pool')).toBe(32);
    expect(load({ ...filesOf(directory) }).getInt('my-app.pool')).toBe(4);
  });

  test('a profile no file defines is refused, naming every file it looked in', () => {
    const directory = directoryWith({ 'reference.conf': 'my-app.pool = 4' });
    expect(() => load({ ...filesOf(directory), profile: 'production' }))
      .toThrow(/the project reference file \(.*reference\.conf\) or the application file/);
  });

  test('records its layers and where it was looked for', () => {
    const directory = directoryWith({ 'reference.conf': 'my-app.a = 1\nprofiles.p.my-app.b = 2' });
    const layers = load({ ...filesOf(directory), profile: 'p' })._sources()!;

    expect(layers.projectReference.getInt('my-app.a')).toBe(1);
    expect(layers.projectReferenceProfile.getInt('my-app.b')).toBe(2);
    expect(layers.projectReferencePath).toBe(join(directory, 'reference.conf'));
    expect(layers.projectReferenceFound).toBe(true);
  });

  test('a missing file is an empty layer, recorded as not found', () => {
    const directory = directoryWith({});
    const layers = load(filesOf(directory))._sources()!;
    expect(layers.projectReferenceFound).toBe(false);
    expect(layers.projectReference.toJSON()).toStrictEqual({});
  });

  test('false reads no such file at all', () => {
    const directory = directoryWith({ 'reference.conf': 'my-app.a = 1' });
    const config = load({ ...filesOf(directory), referenceConfPath: false });
    expect(config.hasPath('my-app.a')).toBe(false);
    expect(config._sources()!.projectReferencePath).toBeNull();
  });

  test('a file that does not load is refused, naming itself and why it was read', () => {
    const directory = directoryWith({ 'reference.conf': 'server {\n  listen 80;\n}\n' });
    expect(() => load(filesOf(directory))).toThrow(
      new RegExp(`The project reference file .*reference\\.conf could not be loaded: HOCON parse error.*`
        + 'Config\\.load read it because LoadOptions\\.referenceConfPath names it\\.'),
    );
  });
});

describe('Config.load — a file reads the layers beneath it (#1785)', () => {
  test('application.conf reads a key the project reference.conf sets', () => {
    const directory = directoryWith({
      'reference.conf': 'my-app.db.host = "localhost"',
      'application.conf': 'my-app.db.url = "postgres://"${my-app.db.host}"/app"',
    });
    expect(load(filesOf(directory)).getString('my-app.db.url')).toBe('postgres://localhost/app');
  });

  test('the value read comes from the highest layer beneath that has it', () => {
    const directory = directoryWith({
      'reference.conf': 'my-app.host = "reference"',
      'application.conf': 'my-app.host = "application"',
      'secrets.conf': 'my-app.copy = ${my-app.host}',
    });
    expect(load(filesOf(directory)).getString('my-app.copy')).toBe('application');
  });

  test('an override builds on the value beneath', () => {
    const directory = directoryWith({
      'reference.conf': 'my-app.path = "/base"',
      'application.conf': 'my-app.path = ${my-app.path}":/extra"',
    });
    expect(load(filesOf(directory)).getString('my-app.path')).toBe('/base:/extra');
  });

  test('never upward: a lower file keeps its own value, and cannot read a higher one', () => {
    const directory = directoryWith({
      'reference.conf': 'my-app.base = "base"\nmy-app.derived = ${my-app.base}"-derived"',
      'application.conf': 'my-app.base = "overridden"',
    });
    // No late binding: the derived default was fixed when its own file resolved.
    expect(load(filesOf(directory)).getString('my-app.derived')).toBe('base-derived');

    const upward = directoryWith({
      'reference.conf': 'my-app.copy = ${my-app.only-above}',
      'application.conf': 'my-app.only-above = 1',
    });
    expect(() => load(filesOf(upward))).toThrow('Unresolved substitution: ${my-app.only-above}');
  });

  test('an unset optional override drops out of its layer, so the layer beneath shows through', () => {
    const directory = directoryWith({
      'reference.conf': 'my-app.port = 2552',
      'application.conf': 'my-app.port = ${?ACTOR_TS_TEST_NO_SUCH_PORT}',
    });
    const config = load(filesOf(directory));
    expect(config.getInt('my-app.port')).toBe(2552);
    expect(config._sources()!.application.hasPath('my-app.port')).toBe(false);
  });
});

describe('Config.load — the .env file (#1785)', () => {
  test('answers a substitution the real environment does not', () => {
    const directory = directoryWith({
      '.env': 'DB_PASSWORD=from-env-file\n',
      'application.conf': 'my-app.password = ${DB_PASSWORD}',
    });
    expect(load(filesOf(directory)).getString('my-app.password')).toBe('from-env-file');
  });

  test('the real environment wins over it, and process.env is never written', () => {
    const directory = directoryWith({
      '.env': 'ACTOR_TS_TEST_LAYER_A=from-file\nACTOR_TS_TEST_LAYER_B=only-in-file\n',
      'application.conf': 'my-app { a = ${ACTOR_TS_TEST_LAYER_A}, b = ${ACTOR_TS_TEST_LAYER_B} }',
    });
    const config = load(filesOf(directory), { ACTOR_TS_TEST_LAYER_A: 'from-process' });

    expect(config.getString('my-app.a')).toBe('from-process');
    expect(config.getString('my-app.b')).toBe('only-in-file');
    expect(process.env['ACTOR_TS_TEST_LAYER_B']).toBeUndefined();
  });

  test('an empty variable in the real environment does not hide the file', () => {
    const directory = directoryWith({
      '.env': 'ACTOR_TS_TEST_LAYER_A=from-file\n',
      'application.conf': 'my-app.a = ${ACTOR_TS_TEST_LAYER_A}',
    });
    expect(load(filesOf(directory), { ACTOR_TS_TEST_LAYER_A: '' }).getString('my-app.a')).toBe('from-file');
  });

  test('feeds every file, the project reference.conf and the secrets file included', () => {
    const directory = directoryWith({
      '.env': 'A=1\nB=2\nC=3\n',
      'reference.conf': 'my-app.a = ${A}',
      'application.conf': 'my-app.b = ${B}',
      'secrets.conf': 'my-app.c = ${C}',
    });
    const config = load(filesOf(directory));
    expect([config.getInt('my-app.a'), config.getInt('my-app.b'), config.getInt('my-app.c')]).toStrictEqual([1, 2, 3]);
  });

  test('may name the other files and the profile, as the real environment can', () => {
    const directory = directoryWith({
      'other.conf': 'my-app.a = "named"\nprofiles.staging.my-app.a = "staged"',
    });
    const environmentFile = directoryWith({
      '.env': `ACTOR_TS_CONFIG=${join(directory, 'other.conf')}\nACTOR_TS_PROFILE=staging\n`,
    });
    const config = load({
      environmentFilePath: join(environmentFile, '.env'),
      secretsConfPath: false,
      referenceConfPath: false,
    });
    expect(config.getString('my-app.a')).toBe('staged');
  });

  test('is found through ACTOR_TS_ENV_FILE, read from the real environment', () => {
    const directory = directoryWith({ 'vars.env': 'X=from-named-file\n', 'application.conf': 'my-app.x = ${X}' });
    const config = load(
      { appConfPath: join(directory, 'application.conf'), secretsConfPath: false, referenceConfPath: false },
      { ACTOR_TS_ENV_FILE: join(directory, 'vars.env') },
    );
    expect(config.getString('my-app.x')).toBe('from-named-file');
  });

  test('a directory where the file would be counts as no file', () => {
    // A Python virtual environment is commonly a directory called `.env`.
    const directory = directoryWith({ 'application.conf': 'my-app.x = 1' });
    mkdirSync(join(directory, '.env'));
    const layers = load(filesOf(directory))._sources()!;
    expect(layers.environmentFileFound).toBe(false);
  });

  test('a directory where a config file would be is still refused', () => {
    const directory = directoryWith({});
    mkdirSync(join(directory, 'application.conf'));
    expect(() => load(filesOf(directory))).toThrow(ConfigError);
  });

  test('false reads no .env file', () => {
    const directory = directoryWith({ '.env': 'X=1\n', 'application.conf': 'my-app.x = ${?X}' });
    const config = load({ ...filesOf(directory), environmentFilePath: false });
    expect(config.hasPath('my-app.x')).toBe(false);
    expect(config._sources()!.environmentFilePath).toBeNull();
  });

  test('records where it was looked for and whether it was found', () => {
    const directory = directoryWith({ '.env': 'X=1\n' });
    const layers = load(filesOf(directory))._sources()!;
    expect(layers.environmentFilePath).toBe(join(directory, '.env'));
    expect(layers.environmentFileFound).toBe(true);
  });
});

describe('Config.load — files read byte for byte', () => {
  test('a byte-order mark at the start of a file is dropped', () => {
    const directory = directoryWith({ 'application.conf': '\uFEFFmy-app.x = 1', '.env': '\uFEFFY=2\n' });
    const config = load({ ...filesOf(directory) });
    expect(config.getInt('my-app.x')).toBe(1);
    expect(Config.parseFile(join(directory, 'application.conf')).getInt('my-app.x')).toBe(1);
  });

  test('an empty ACTOR_TS_CONFIG counts as unset', () => {
    // Before #1785 an empty variable was taken as the path "", which read no file.
    const directory = directoryWith({ 'application.conf': 'my-app.x = "found"' });
    const previous = process.cwd();
    process.chdir(directory);
    try {
      const config = load({ secretsConfPath: false, referenceConfPath: false, environmentFilePath: false }, { ACTOR_TS_CONFIG: '' });
      expect(config.getString('my-app.x')).toBe('found');
    } finally {
      process.chdir(previous);
    }
  });
});

describe('Config.load — which variables supplied each leaf (#1788)', () => {
  const variablesOf = (config: Config, layer: 'application' | 'projectReference' | 'secrets'): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const [key, names] of config._sources()!.variables[layer] ?? []) {
      out[(JSON.parse(key) as string[]).join('.')] = [...names].sort();
    }
    return out;
  };

  test('each file\'s layer keeps the variables behind its own leaves', () => {
    const directory = directoryWith({
      '.env': 'DB_PASSWORD=pw\nAPI_TOKEN=t\n',
      'reference.conf': 'my-app.token = ${?API_TOKEN}',
      'application.conf': 'my-app.db = ${DB_PASSWORD}\nmy-app.plain = 1',
    });
    const config = load(filesOf(directory));
    expect(variablesOf(config, 'application')).toStrictEqual({ 'my-app.db': ['DB_PASSWORD'] });
    expect(variablesOf(config, 'projectReference')).toStrictEqual({ 'my-app.token': ['API_TOKEN'] });
  });

  test('a value read from a layer beneath brings its variables into the layer that read it', () => {
    const directory = directoryWith({
      '.env': 'DB_PASSWORD=pw\n',
      'reference.conf': 'my-app.db.password = ${DB_PASSWORD}',
      'secrets.conf': 'my-app.dsn = "postgres://app:"${my-app.db.password}"@db/app"',
    });
    const config = load(filesOf(directory));
    expect(config.getString('my-app.dsn')).toBe('postgres://app:pw@db/app');
    expect(variablesOf(config, 'secrets')).toStrictEqual({ 'my-app.dsn': ['DB_PASSWORD'] });
  });
});
