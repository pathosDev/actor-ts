import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { FastifyBackend } from '../../../../src/http/backend/FastifyBackend.js';
import { ExpressBackend } from '../../../../src/http/backend/ExpressBackend.js';
import { HonoBackend } from '../../../../src/http/backend/HonoBackend.js';
import { HttpExtensionId } from '../../../../src/http/HttpExtension.js';
import { concat, type Route } from '../../../../src/http/Route.js';
import { getFromBrowseableDirectory, getFromDirectory } from '../../../../src/http/static/StaticFiles.js';
import type { HttpServerBackend, ServerBinding } from '../../../../src/http/backend/HttpServerBackend.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'actor-ts-static-'));
  await writeFile(join(root, 'index.html'), '<h1>home</h1>');
  await writeFile(join(root, 'style.css'), 'body{}');
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'sub', 'page.txt'), 'hello sub');
  await writeFile(join(root, '.secret'), 'nope');
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

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
  const system = ActorSystem.create('http-staticfiles-test', sysOptions);
  const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).useBackend(mk()).bind(routes);
  live.push({ binding, system });
  return `http://${binding.host}:${binding.port}`;
}

describe.each(backends)('static files — %s backend', (_name, mk) => {
  const routes = (): Route => concat(
    getFromDirectory('static', root),
    getFromBrowseableDirectory('browse', root),
  );

  test('serves a file with the correct MIME type', async () => {
    const url = await start(mk, routes());
    const res = await fetch(`${url}/static/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await res.text()).toBe('body{}');
  });

  test('resolves the index file for a directory', async () => {
    const url = await start(mk, routes());
    const res = await fetch(`${url}/static/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('<h1>home</h1>');
  });

  test('redirects a directory without a trailing slash', async () => {
    const url = await start(mk, routes());
    const res = await fetch(`${url}/static`, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/static/');
  });

  test('serves a nested file', async () => {
    const url = await start(mk, routes());
    expect(await (await fetch(`${url}/static/sub/page.txt`)).text()).toBe('hello sub');
  });

  test('404 for a missing file', async () => {
    const url = await start(mk, routes());
    expect((await fetch(`${url}/static/missing.txt`)).status).toBe(404);
  });

  test('404 for a dotfile (denied by default)', async () => {
    const url = await start(mk, routes());
    expect((await fetch(`${url}/static/.secret`)).status).toBe(404);
  });

  test('404 for an encoded traversal attempt', async () => {
    const url = await start(mk, routes());
    const res = await fetch(`${url}/static/%2e%2e%2f%2e%2e%2fpackage.json`);
    expect(res.status).toBe(404);
  });

  test('honours conditional If-None-Match with a 304', async () => {
    const url = await start(mk, routes());
    const first = await fetch(`${url}/static/style.css`);
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();
    const second = await fetch(`${url}/static/style.css`, { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  test('HEAD returns headers with an empty body', async () => {
    const url = await start(mk, routes());
    const res = await fetch(`${url}/static/style.css`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await res.text()).toBe('');
  });

  test('serves a single Range as 206', async () => {
    const url = await start(mk, routes());
    const res = await fetch(`${url}/static/style.css`, { headers: { range: 'bytes=0-3' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-3/6');
    expect(await res.text()).toBe('body');
  });

  test('416 for an unsatisfiable Range', async () => {
    const url = await start(mk, routes());
    const res = await fetch(`${url}/static/style.css`, { headers: { range: 'bytes=99999-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */6');
  });

  test('browses a directory that has no index', async () => {
    const url = await start(mk, routes());
    const res = await fetch(`${url}/browse/sub/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('page.txt');
    expect(html).toContain('href="../"'); // parent link (not at mount root)
  });
});
