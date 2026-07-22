import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { HonoBackend } from '../../../src/http/backend/HonoBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { compile, complete, get, path, type Route } from '../../../src/http/Route.js';
import type { HttpServerBackend, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { Status } from '../../../src/http/types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

test('compile emits a trailing-* pattern for a wildcard route', () => {
  const compiled = compile(path('assets', path('*', get(() => complete(Status.OK, '')))));
  expect(compiled[0]!.kind === 'http' && compiled[0]!.pattern).toBe('/assets/*');
});

const backends: Array<[string, () => HttpServerBackend]> = [
  ['fastify', () => new FastifyBackend({ logger: false })],
  ['express', () => new ExpressBackend()],
  ['hono', () => new HonoBackend()],
];

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
  const system = ActorSystem.create('http-wildcard-test', sysOptions);
  const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).useBackend(mk()).bind(routes);
  live.push({ binding, system });
  return `http://${binding.host}:${binding.port}`;
}

describe.each(backends)('wildcard params[*] — %s backend', (_name, mk) => {
  // Only the wildcard route, so no sibling route competes for the match.
  const routes = (): Route =>
    path('assets', path('*', get((request) => complete(Status.OK, request.params['*'] ?? '<none>'))));

  test('captures a multi-segment remainder', async () => {
    const url = await start(mk, routes());
    expect(await (await fetch(`${url}/assets/a/b/c.txt`)).text()).toBe('a/b/c.txt');
  });

  test('captures an empty remainder for the trailing slash', async () => {
    const url = await start(mk, routes());
    expect(await (await fetch(`${url}/assets/`)).text()).toBe('');
  });

  test('HEAD on a GET route answers 200 with an empty body', async () => {
    const url = await start(mk, routes());
    const response = await fetch(`${url}/assets/x`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });
});
