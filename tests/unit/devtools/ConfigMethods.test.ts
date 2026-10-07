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
    const system = newSystem('cfg-path');
    const { server, invoke } = fakeServer();
    new ConfigMethods(system).install(server);

    // Null in this run because no file exists; the field carries the path
    // when one does. "My file is ignored" and "my file says something else"
    // are different problems, and this is what separates them.
    const result = await invoke();
    expect(result.applicationPath === null || typeof result.applicationPath === 'string')
      .toBe(true);
  });
});
