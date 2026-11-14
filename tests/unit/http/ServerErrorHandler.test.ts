import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { complete, get, type Route } from '../../../src/http/Route.js';
import type { HttpServerBackend, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { Status, type HttpRequest, type HttpResponse } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

type ErrHandler = (err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse;

const live: Array<{ binding: ServerBinding; system: ActorSystem }> = [];
afterEach(async () => {
  while (live.length) {
    const { binding, system } = live.shift()!;
    await binding.unbind();
    await system.terminate();
  }
});

async function start(mk: () => HttpServerBackend, routes: Route, onError?: ErrHandler): Promise<string> {
  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('http-errorhandler-test', sysOptions);
  try {
    let builder = system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).useBackend(mk());
    if (onError) builder = builder.withErrorHandler(onError);
    const binding = await builder.bind(routes);
    live.push({ binding, system });
    return `http://${binding.host}:${binding.port}`;
  } catch (e) {
    await system.terminate();
    throw e;
  }
}

describe('withErrorHandler — bind guard', () => {
  test('a backend without a setErrorHandler hook is rejected at bind', async () => {
    const stub: HttpServerBackend = {
      name: 'stub',
      registerRoute() {},
      async listen(host, port) { return { host, port, async unbind() {} }; },
    };
    await expect(start(() => stub, get(() => complete(Status.OK, '')), () => complete(Status.OK, '')))
      .rejects.toThrow(/does not support withErrorHandler/);
  });
});
