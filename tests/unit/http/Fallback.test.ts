import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import {
  complete,
  compile,
  concat,
  fallback,
  path,
  type Route,
} from '../../../src/http/Route.js';
import type { HttpServerBackend, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { Status } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

const live: Array<{ binding: ServerBinding; system: ActorSystem }> = [];
afterEach(async () => {
  while (live.length) {
    const { binding, system } = live.shift()!;
    await binding.unbind();
    await system.terminate();
  }
});

async function start(mk: () => HttpServerBackend, routes: Route): Promise<string> {
  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('http-fallback-test', sysOptions);
  try {
    const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).useBackend(mk()).bind(routes);
    live.push({ binding, system });
    return `http://${binding.host}:${binding.port}`;
  } catch (e) {
    await system.terminate();
    throw e;
  }
}

describe('fallback() — compile + bind guards', () => {
  test('a fallback scoped under path() throws at compile time', () => {
    expect(() => compile(path('api', fallback(() => complete(Status.NotFound, '')))))
      .toThrow(/root of the route tree/);
  });

  test('two fallbacks are rejected at bind', async () => {
    await expect(start(() => new FastifyBackend({ logger: false }), concat(
      fallback(() => complete(Status.NotFound, 'a')),
      fallback(() => complete(Status.NotFound, 'b')),
    ))).rejects.toThrow(/exactly one not-found handler/);
  });

  test('a backend without a setNotFound hook is rejected at bind', async () => {
    const stub: HttpServerBackend = {
      name: 'stub',
      registerRoute() {},
      async listen(host, port) { return { host, port, async unbind() {} }; },
    };
    await expect(start(() => stub, fallback(() => complete(Status.NotFound, ''))))
      .rejects.toThrow(/does not support fallback/);
  });
});
