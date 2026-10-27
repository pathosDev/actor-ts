import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Config } from '../../../src/config/Config.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { ConfigMethods } from '../../../src/devtools/config/ConfigMethods.js';
import { CONFIG_REDACTED } from '../../../src/devtools/protocol/index.js';
import type {
  DevToolsRequestMethod,
  ResolvedConfigEntry,
  ResolvedConfigResult,
} from '../../../src/devtools/protocol/index.js';
import type { DevToolsRequestHandler, DevToolsServer } from '../../../src/devtools/DevToolsServer.js';

/** Minimal stand-in that only collects the registered handlers. */
function fakeServer(): {
  server: DevToolsServer;
  invoke: () => Promise<ResolvedConfigResult>;
} {
  const handlers = new Map<DevToolsRequestMethod, DevToolsRequestHandler>();
  const server = {
    registerMethod(method: DevToolsRequestMethod, handler: DevToolsRequestHandler): void {
      handlers.set(method, handler);
    },
  } as unknown as DevToolsServer;
  return {
    server,
    invoke: (): Promise<ResolvedConfigResult> => {
      const handler = handlers.get('config.resolved');
      if (handler === undefined) throw new Error('not registered: config.resolved');
      return handler(undefined) as Promise<ResolvedConfigResult>;
    },
  };
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
});

function newSystem(name: string, overrides?: ConfigObject): ActorSystem {
  let options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (overrides !== undefined) options = options.withConfig(overrides);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

/** Run `body` with one environment variable set, restoring it afterwards. */
function withVariable<T>(name: string, value: string, body: () => T): T {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function resolve(result: ResolvedConfigResult, path: string): ResolvedConfigEntry {
  const entry = result.entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`no such key: ${path}`);
  return entry;
}

describe('ConfigMethods', () => {
  test('reports every reference key as coming from the reference', async () => {
    const system = newSystem('cfg-reference');
    const { server, invoke } = fakeServer();
    new ConfigMethods(system).install(server);

    const result = await invoke();
    expect(result.attributed).toBe(true);
    expect(result.entries.length).toBeGreaterThan(20);
    const entry = resolve(result, 'actor-ts.system.shutdown-drain-timeout');
    expect(entry.source).toBe('reference');
    expect(entry.overridden).toBe(false);
  });

  test('attributes a code override to the override layer, and says it displaced one', async () => {
    const system = newSystem('cfg-override', {
      'actor-ts': { system: { 'shutdown-drain-timeout': '9s' } },
    });
    const { server, invoke } = fakeServer();
    new ConfigMethods(system).install(server);

    const entry = resolve(await invoke(), 'actor-ts.system.shutdown-drain-timeout');
    expect(entry.source).toBe('override');
    expect(entry.value).toBe('9s');
    // The interesting keys in a misbehaving system are the displaced ones,
    // and a source alone does not say whether anything was displaced.
    expect(entry.overridden).toBe(true);
  });

  test('a key only the override sets displaced nothing', async () => {
    const system = newSystem('cfg-new-key', {
      'actor-ts': { 'made-up': { setting: 42 } },
    });
    const { server, invoke } = fakeServer();
    new ConfigMethods(system).install(server);

    const entry = resolve(await invoke(), 'actor-ts.made-up.setting');
    expect(entry.source).toBe('override');
    expect(entry.overridden).toBe(false);
  });

  test('redacts a value whose key names a secret', async () => {
    const system = newSystem('cfg-secret', {
      'actor-ts': {
        persistence: {
          postgres: { password: 'hunter2', 'connection-string': 'postgres://x' },
        },
      },
    });
    const { server, invoke } = fakeServer();
    new ConfigMethods(system).install(server);

    const result = await invoke();
    // By key, not by value: a password that happens to look ordinary is
    // still a password, and the key is what names it.
    expect(resolve(result, 'actor-ts.persistence.postgres.password').value)
      .toBe(CONFIG_REDACTED);
    expect(resolve(result, 'actor-ts.persistence.postgres.connection-string').value)
      .toBe('postgres://x');
  });

  test('masks the credentials of a URL whatever its key is called (#1458)', async () => {
    const system = newSystem('cfg-url-credentials', {
      'actor-ts': { cache: { redis: { url: 'redis://default:hunter2@redis.example:6379/0' } } },
      'my-app': { nats: { servers: ['nats://a:hunter3@h1:4222', 'nats://h2:4222'] } },
    });
    const { server, invoke } = fakeServer();
    new ConfigMethods(system).install(server);

    const result = await invoke();
    // Only the userinfo goes: the host, port and path are what tell an
    // operator which Redis this is.
    expect(resolve(result, 'actor-ts.cache.redis.url').value)
      .toBe('redis://***@redis.example:6379/0');
    expect(resolve(result, 'my-app.nats.servers').value)
      .toEqual(['nats://***@h1:4222', 'nats://h2:4222']);
    // The whole answer, not only the entries asked about: a credential on the
    // wire under any key is the defect.
    expect(JSON.stringify(result)).not.toContain('hunter');
  });

  test('withholds a credential-named field of an object inside a list (found while #1458)', async () => {
    // The same decision the boot dump takes, through the same function: the
    // list is one leaf whose path names no secret, so the field's own name is
    // what has to be read.  The URL mask still applies to the fields it keeps.
    const system = newSystem('cfg-list-fields', {
      'my-app': {
        upstreams: [
          { host: 'db-1', password: 'hunter2', url: 'redis://u:hunter3@r1:6379' },
          { host: 'db-2', 'key-prefix': 'orders:', auth: true },
        ],
      },
    });
    const { server, invoke } = fakeServer();
    new ConfigMethods(system).install(server);

    const result = await invoke();
    expect(resolve(result, 'my-app.upstreams').value).toEqual([
      { host: 'db-1', password: CONFIG_REDACTED, url: 'redis://***@r1:6379' },
      { host: 'db-2', 'key-prefix': 'orders:', auth: true },
    ]);
    expect(JSON.stringify(result)).not.toContain('hunter');
  });

  test('masks before the wire cut, so a truncation cannot leave part of a password (#1458)', async () => {
    // Longer than the wire's 8 192-character string limit, with the `@` that
    // ends the userinfo beyond it.  Cut first, and the mask finds no `@` to
    // anchor on — eight thousand characters of the password go out as they are.
    const password = 'p'.repeat(9_000);
    const system = newSystem('cfg-url-long', {
      'my-app': { database: { dsn: `postgres://user:${password}@db/app` } },
    });
    const { server, invoke } = fakeServer();
    new ConfigMethods(system).install(server);

    const entry = resolve(await invoke(), 'my-app.database.dsn');
    expect(entry.value).toBe('postgres://***@db/app');
    expect(entry.truncated).toBe(false);
  });

  test('keeps a list whole rather than splitting it into indexed keys', async () => {
    const system = newSystem('cfg-list', {
      'actor-ts': { cluster: { 'seed-nodes': ['a:1', 'b:2'] } },
    });
    const { server, invoke } = fakeServer();
    new ConfigMethods(system).install(server);

    const result = await invoke();
    // One setting whose value is a list, not two settings nobody configured.
    expect(resolve(result, 'actor-ts.cluster.seed-nodes').value).toEqual(['a:1', 'b:2']);
    expect(result.entries.some((entry) => entry.path.endsWith('seed-nodes.0'))).toBe(false);
  });

  test('sorts by path, so a key can be found by name', async () => {
    const system = newSystem('cfg-sorted');
    const { server, invoke } = fakeServer();
    new ConfigMethods(system).install(server);

    const paths = (await invoke()).entries.map((entry) => entry.path);
    expect([...paths].sort((left, right) => left.localeCompare(right))).toEqual(paths);
  });

  test('says it cannot attribute a config that was not loaded in layers', async () => {
    const system = newSystem('cfg-unattributed');
    const { server, invoke } = fakeServer();
    // A config from `parseString` has one source and no precedence to
    // explain — reporting every key as `reference` would be a guess.
    (system as unknown as { config: Config }).config =
      Config.parseString('actor-ts { system { name = "x" } }');
    new ConfigMethods(system).install(server);

    const result = await invoke();
    expect(result.attributed).toBe(false);
    expect(result.applicationPath).toBeNull();
  });

  test('reports where application.conf was read from', async () => {
    // "My file is ignored" and "my file says something else" are different
    // problems, and this is what separates them.
    const directory = mkdtempSync(join(tmpdir(), 'actor-ts-config-methods-'));
    const path = join(directory, 'application.conf');
    writeFileSync(path, 'my-app.x = 1\n', 'utf8');
    try {
      const systemOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withConfigFile(path);
      const system = ActorSystem.create('cfg-path', systemOptions);
      systems.push(system);
      const { server, invoke } = fakeServer();
      new ConfigMethods(system).install(server);

      expect((await invoke()).applicationPath).toBe(path);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('attributes a key to one of five sources and withholds what the secrets file set (#1546)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'actor-ts-config-methods-'));
    const applicationPath = join(directory, 'application.conf');
    const secretsPath = join(directory, 'secrets.conf');
    writeFileSync(applicationPath, [
      'my-app { set-by-application = "a", set-by-profile = "a" }',
      'profiles.production.my-app.set-by-profile = "b"',
    ].join('\n'), 'utf8');
    writeFileSync(secretsPath, [
      'my-app { endpoint-value = "s3cr3t-root", set-by-secrets-profile = "c" }',
      'profiles.production.my-app.set-by-secrets-profile = "s3cr3t-profile"',
    ].join('\n'), 'utf8');
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfigFile(applicationPath)
      .withProfile('production')
      .withConfig({ 'my-app': { 'set-by-code': 'x' } });
    // ActorSystemOptions names no secrets file, so the variable does — read
    // once, in the constructor.
    const system = withVariable('ACTOR_TS_SECRETS_CONF', secretsPath, () =>
      ActorSystem.create('cfg-five-sources', systemOptions));
    systems.push(system);
    try {
      const { server, invoke } = fakeServer();
      new ConfigMethods(system).install(server);
      const result = await invoke();

      expect(resolve(result, 'actor-ts.dispatcher.throughput').source).toBe('reference');
      expect(resolve(result, 'my-app.set-by-application').source).toBe('application');
      expect(resolve(result, 'my-app.set-by-profile').source).toBe('profile');
      expect(resolve(result, 'my-app.endpoint-value').source).toBe('secrets');
      // Six layers, five names: the secrets file's profile reports as secrets.
      expect(resolve(result, 'my-app.set-by-secrets-profile').source).toBe('secrets');
      expect(resolve(result, 'my-app.set-by-secrets-profile').overridden).toBe(true);
      expect(resolve(result, 'my-app.set-by-code').source).toBe('override');
      expect(resolve(result, 'my-app.endpoint-value').value).toBe(CONFIG_REDACTED);
      expect(resolve(result, 'my-app.set-by-secrets-profile').value).toBe(CONFIG_REDACTED);
      expect(JSON.stringify(result)).not.toContain('s3cr3t');
      expect(result.profile).toBe('production');
      expect(result.secretsPath).toBe(secretsPath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('withholds and attributes a secrets-file key quoted because it holds a dot (#1546)', async () => {
    // Root, nested and in the secrets file's profile; none named like a
    // credential.  `"region.name"` sits beside the application file's nested
    // `region.name`, which reads the same once segments are joined by a dot.
    const directory = mkdtempSync(join(tmpdir(), 'actor-ts-config-methods-'));
    const applicationPath = join(directory, 'application.conf');
    const secretsPath = join(directory, 'secrets.conf');
    writeFileSync(applicationPath, 'my-app { "hosts.internal" = "db-1", region { name = "eu" } }\n', 'utf8');
    writeFileSync(secretsPath, [
      '"db.dsn" = "dotted-root-1"',
      'my-app { "stripe.live" = "dotted-nested-2", "region.name" = "dotted-beside-3" }',
      'profiles.production { my-app { "payments.v2" = "dotted-profile-4" } }',
    ].join('\n'), 'utf8');
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfigFile(applicationPath)
      .withProfile('production');
    const system = withVariable('ACTOR_TS_SECRETS_CONF', secretsPath, () =>
      ActorSystem.create('cfg-quoted-dotted', systemOptions));
    systems.push(system);
    try {
      const { server, invoke } = fakeServer();
      new ConfigMethods(system).install(server);
      const result = await invoke();

      const wire = JSON.stringify(result);
      for (const value of ['dotted-root-1', 'dotted-nested-2', 'dotted-beside-3', 'dotted-profile-4']) {
        expect(wire).not.toContain(value);
      }
      // However the paths are spelled: the four keys the file set, each
      // withheld and reported as the file's.
      const fromSecrets = result.entries.filter((entry) => entry.source === 'secrets');
      expect(fromSecrets).toHaveLength(4);
      for (const entry of fromSecrets) expect(entry.value).toBe(CONFIG_REDACTED);
      expect(fromSecrets.map((entry) => entry.path).sort()).toEqual([
        '"db.dsn"', 'my-app."payments.v2"', 'my-app."region.name"', 'my-app."stripe.live"',
      ]);
      expect(resolve(result, 'my-app."hosts.internal"')).toMatchObject({ value: 'db-1', source: 'application' });
      expect(resolve(result, 'my-app.region.name')).toMatchObject({ value: 'eu', source: 'application' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('reports no profile and no secrets file when there was neither (#1546)', async () => {
    const system = newSystem('cfg-no-profile');
    const { server, invoke } = fakeServer();
    new ConfigMethods(system).install(server);

    const result = await invoke();
    expect(result.profile).toBeNull();
    expect(result.secretsPath).toBeNull();
  });

  test('reports no application.conf when the file it looked for is not there (found while #1546)', async () => {
    // The loader names the path it looked at either way — the boot dump
    // prints it, which is how a wrong ACTOR_TS_CONFIG shows up — but the wire
    // field means "read from", and the panel says "application.conf read from
    // <path>" for whatever arrives in it.
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfigFile(join(tmpdir(), 'actor-ts-no-such-application.conf'));
    const system = ActorSystem.create('cfg-no-file', systemOptions);
    systems.push(system);
    const { server, invoke } = fakeServer();
    new ConfigMethods(system).install(server);

    expect((await invoke()).applicationPath).toBeNull();
  });
});
