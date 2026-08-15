import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { ConfigError } from '../../../src/config/Config.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { HttpResponseTooLargeError } from '../../../src/http/HttpClient.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { complete, get } from '../../../src/http/Route.js';
import { Status } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';

/**
 * `actor-ts.http.backend` and `actor-ts.http.shutdown-grace-period` were
 * documented but inert (#653).  These drive them through the real
 * `newServerAt(...).bind()` path rather than asserting on a reader.
 */

let running: { system: ActorSystem; binding: ServerBinding } | null = null;

function systemWith(config: Record<string, unknown>): ActorSystem {
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

/**
 * The outbound bounds were operable only from code (#602): the shared client
 * took the built-in numbers and offered no way to move them, so a deployment
 * that needed a different ceiling had to stop using the shared client.  These
 * drive the real request path — a framework server on one end, the system's
 * own client on the other — rather than asserting on the reader.
 */
describe('actor-ts.http.client', () => {
  /** Bind a route answering `size` bytes, and hand back its URL. */
  async function serveBytes(system: ActorSystem, size: number): Promise<string> {
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(get(() => complete(Status.OK, 'a'.repeat(size))));
    running = { system, binding };
    return `http://${binding.host}:${binding.port}/`;
  }

  test('the shared client takes its response ceiling from the config file', async () => {
    const system = systemWith({ 'actor-ts': { http: { client: { maxResponseBytes: '1K' } } } });
    const url = await serveBytes(system, 4096);
    await expect(system.extension(HttpExtensionId).client.get(url))
      .rejects.toBeInstanceOf(HttpResponseTooLargeError);
  });

  test('the shared client takes its deadline from the config file', async () => {
    const system = systemWith({ 'actor-ts': { http: { client: { defaultTimeoutMs: '50ms' } } } });
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(get(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        return complete(Status.OK, 'late');
      }));
    running = { system, binding };
    // Without the config layer this waits the full 2 s and resolves, so the
    // assertion fails on a value rather than on a timeout.
    const settled = await system.extension(HttpExtensionId)
      .client.get(`http://${binding.host}:${binding.port}/`)
      .then(() => 'resolved', () => 'aborted');
    expect(settled).toBe('aborted');
  });

  test('an explicit option beats the config file, which beats the built-in default', async () => {
    const system = systemWith({ 'actor-ts': { http: { client: { maxResponseBytes: '1K' } } } });
    const url = await serveBytes(system, 4096);
    const extension = system.extension(HttpExtensionId);
    // Explicit > HOCON: newClient names its own ceiling and gets the body.
    expect((await extension.newClient({ maxResponseBytes: 8192 }).get(url)).body.byteLength).toBe(4096);
    // HOCON > built-in: 1 KiB is nowhere near the built-in 8 MiB.
    await expect(extension.newClient().get(url)).rejects.toBeInstanceOf(HttpResponseTooLargeError);
  });

  test('an unset block leaves the built-in bounds in place', async () => {
    const system = systemWith({});
    const url = await serveBytes(system, 4096);
    expect((await system.extension(HttpExtensionId).client.get(url)).body.byteLength).toBe(4096);
  });

  test('an out-of-domain value is rejected as an OptionsError, not deep in a request', async () => {
    // The whole point of a validated read: a bad value surfaces where the
    // configuration mistake is, not as a redirect policy nobody chose.
    const system = systemWith({ 'actor-ts': { http: { client: { redirect: 'sideways' } } } });
    try {
      expect(() => system.extension(HttpExtensionId)).toThrow(OptionsError);
      expect(() => system.extension(HttpExtensionId)).toThrow('redirect');
    } finally {
      await system.terminate();
    }
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
