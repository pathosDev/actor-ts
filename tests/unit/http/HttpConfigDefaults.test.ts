import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { ConfigError } from '../../../src/config/Config.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { complete, get } from '../../../src/http/Route.js';
import { Status } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';

/**
 * `actor-ts.http.backend` and `actor-ts.http.shutdown-grace-period` were
 * documented but inert (#653).  These drive them through the real
 * `newServerAt(...).bind()` path rather than asserting on a reader.
 */

let running: { system: ActorSystem; binding: ServerBinding } | null = null;

function systemWith(config: ConfigObject): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(config);
  return ActorSystem.create('http-config', options);
}

afterEach(async () => {
  if (running) {
    await running.binding.unbind();
    await running.system.terminate();
    running = null;
  }
});

describe('actor-ts.http.backend', () => {
  test('an unset key keeps the built-in Fastify backend', async () => {
    const system = systemWith({});
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(get(() => complete(Status.OK, 'ok')));
    running = { system, binding };

    const response = await fetch(`http://${binding.host}:${binding.port}/`);
    expect(response.status).toBe(200);
  });

  test('a backend passed in code wins over the config file', async () => {
    // `useBackend` is the explicit layer.  The config names a backend that
    // does not exist, so if it were consulted at all this would throw —
    // which is what makes the assertion mean something.
    const system = systemWith({ 'actor-ts': { http: { backend: 'not-a-backend' } } });
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new FastifyBackend({ logger: false }))
      .bind(get(() => complete(Status.OK, 'ok')));
    running = { system, binding };

    const response = await fetch(`http://${binding.host}:${binding.port}/`);
    expect(response.status).toBe(200);
  });

  test('an unknown backend name fails with a ConfigError naming the key', async () => {
    // `bun` is the case worth pinning: reference.conf advertised it as a
    // backend for a long time and it never existed.
    const system = systemWith({ 'actor-ts': { http: { backend: 'bun' } } });

    const bind = (): Promise<ServerBinding> => system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(get(() => complete(Status.OK, 'ok')));

    await expect(bind()).rejects.toThrow(ConfigError);
    await expect(bind()).rejects.toThrow('actor-ts.http.backend');
    await system.terminate();
  });
});

describe('actor-ts.http.shutdown-grace-period', () => {
  test('unbind resolves promptly when nothing is in flight', async () => {
    // The grace period is an upper bound, not a sleep: with no in-flight
    // request the backend's close() wins the race immediately.  Worth
    // pinning — a misread would add the full window to every shutdown.
    const system = systemWith({ 'actor-ts': { http: { 'shutdown-grace-period': '30s' } } });
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(get(() => complete(Status.OK, 'ok')));

    const startedAt = Date.now();
    await binding.unbind();
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    await system.terminate();
  });
});
