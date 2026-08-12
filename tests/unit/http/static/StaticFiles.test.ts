import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { FastifyBackend } from '../../../../src/http/backend/FastifyBackend.js';
import { ExpressBackend } from '../../../../src/http/backend/ExpressBackend.js';
import { HonoBackend } from '../../../../src/http/backend/HonoBackend.js';
import { HttpExtensionId } from '../../../../src/http/HttpExtension.js';
import { compile, concat, type CompiledRoute, type Route } from '../../../../src/http/Route.js';
import { getFromBrowseableDirectory, getFromDirectory, getFromFile } from '../../../../src/http/static/StaticFiles.js';
import type { StaticFilesOptions } from '../../../../src/http/static/StaticFilesOptions.js';
import type { HttpServerBackend, ServerBinding } from '../../../../src/http/backend/HttpServerBackend.js';
import type { HttpRequest, HttpResponse } from '../../../../src/http/types.js';
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
    const response = await fetch(`${url}/static/style.css`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await response.text()).toBe('body{}');
  });

  test('resolves the index file for a directory', async () => {
    const url = await start(mk, routes());
    const response = await fetch(`${url}/static/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toBe('<h1>home</h1>');
  });

  test('redirects a directory without a trailing slash', async () => {
    const url = await start(mk, routes());
    const response = await fetch(`${url}/static`, { redirect: 'manual' });
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/static/');
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
    const response = await fetch(`${url}/static/%2e%2e%2f%2e%2e%2fpackage.json`);
    expect(response.status).toBe(404);
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
    const response = await fetch(`${url}/static/style.css`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await response.text()).toBe('');
  });

  test('serves a single Range as 206', async () => {
    const url = await start(mk, routes());
    const response = await fetch(`${url}/static/style.css`, { headers: { range: 'bytes=0-3' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-3/6');
    expect(await response.text()).toBe('body');
  });

  test('416 for an unsatisfiable Range', async () => {
    const url = await start(mk, routes());
    const response = await fetch(`${url}/static/style.css`, { headers: { range: 'bytes=99999-' } });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */6');
  });

  test('browses a directory that has no index', async () => {
    const url = await start(mk, routes());
    const response = await fetch(`${url}/browse/sub/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('page.txt');
    expect(html).toContain('href="../"'); // parent link (not at mount root)
  });
});

/*
 * Directive-level, deliberately NOT through a backend: the backends stamp
 * `nosniff` on every response of their own accord, which would make a
 * live-server assertion pass even with the directive broken.  Calling the
 * compiled handler proves the static-file response carries it itself.
 */
describe('static files — nosniff on the served file', () => {
  const requestFor = (headers: Readonly<Record<string, string>> = {}): HttpRequest => ({
    method: 'GET', path: '/', headers, query: {}, params: {}, body: null,
  });

  async function serveStyleCss(headers?: Readonly<Record<string, string>>): Promise<HttpResponse> {
    const compiled = compile(getFromFile(join(root, 'style.css')));
    const route = compiled[0] as CompiledRoute;
    return await route.handler(requestFor(headers));
  }

  test('a 200 file response carries nosniff', async () => {
    const response = await serveStyleCss();
    expect(response.status).toBe(200);
    expect(response.headers?.['x-content-type-options']).toBe('nosniff');
  });

  test('the conditional 304 carries it too', async () => {
    const etag = (await serveStyleCss()).headers?.['etag']!;
    const response = await serveStyleCss({ 'if-none-match': etag });
    expect(response.status).toBe(304);
    expect(response.headers?.['x-content-type-options']).toBe('nosniff');
  });

  test('a range 206 and an unsatisfiable 416 carry it too', async () => {
    const partial = await serveStyleCss({ range: 'bytes=0-3' });
    expect(partial.status).toBe(206);
    expect(partial.headers?.['x-content-type-options']).toBe('nosniff');
    const unsatisfiable = await serveStyleCss({ range: 'bytes=99999-' });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers?.['x-content-type-options']).toBe('nosniff');
  });

  test('HEAD carries it as well', async () => {
    const compiled = compile(getFromFile(join(root, 'style.css')));
    const route = compiled[0] as CompiledRoute;
    const response = await route.handler({ ...requestFor(), method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers?.['x-content-type-options']).toBe('nosniff');
  });
});

/*
 * `symlinks: 'within-root'` (#575) — the policy has to hold on every
 * filesystem hop a request touches, not only on the one the URL resolves to:
 * a directory's index file and each listing entry are hops of their own.
 * Directive-level for the same reason as the block above — this is the
 * directive's own policy, and a live backend would add nothing but three
 * server starts per case.
 */

/** Drive a compiled `getFromDirectory`; `rest` `''` hits the mount-root endpoint. */
async function serveFrom(fsRoot: string, options: StaticFilesOptions | undefined, urlPath: string, rest = ''): Promise<HttpResponse> {
  const compiled = compile(getFromDirectory(fsRoot, options));
  const route = compiled[rest === '' ? 0 : 1] as CompiledRoute;
  const request: HttpRequest = {
    method: 'GET', path: urlPath, headers: {}, query: {}, params: rest === '' ? {} : { '*': rest }, body: null,
  };
  return await route.handler(request);
}

const bodyText = (response: HttpResponse): string =>
  typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body as Uint8Array);

/*
 * Directory links run everywhere: `symlink(..., 'junction')` asks Windows for
 * a junction, which an unprivileged process may create, while POSIX ignores
 * the type and makes an ordinary symlink.  Both are reparse hops `realpath`
 * resolves, so this half of the policy is pinned on a developer machine too,
 * not only on CI.
 */
describe('static files — within-root confinement on directory links', () => {
  let linkedRoot: string;
  let outside: string;

  beforeAll(async () => {
    outside = await mkdtemp(join(tmpdir(), 'actor-ts-static-outside-'));
    await mkdir(join(outside, 'elsewhere'));
    await writeFile(join(outside, 'elsewhere', 'secret.txt'), 'out-of-root secret');

    linkedRoot = await mkdtemp(join(tmpdir(), 'actor-ts-static-junctions-'));
    await mkdir(join(linkedRoot, 'real-directory'));
    await mkdir(join(linkedRoot, 'sub'));
    await symlink(join(outside, 'elsewhere'), join(linkedRoot, 'sub', 'directory-escape'), 'junction');
    await symlink(join(linkedRoot, 'real-directory'), join(linkedRoot, 'sub', 'directory-alias'), 'junction');
  });
  afterAll(async () => {
    // `rm` unlinks a link instead of following it, so the targets under
    // `outside` survive until it is removed on its own line.
    await rm(linkedRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const serve = (options: StaticFilesOptions | undefined, urlPath: string, rest = ''): Promise<HttpResponse> =>
    serveFrom(linkedRoot, options, urlPath, rest);

  test('the escaping directory itself is refused', async () => {
    expect((await serve(undefined, '/sub/directory-escape/', 'sub/directory-escape/')).status).toBe(404);
    expect((await serve(undefined, '/sub/directory-escape/secret.txt', 'sub/directory-escape/secret.txt')).status).toBe(404);
  });

  test('the listing omits it and keeps the in-root link, as a directory', async () => {
    const response = await serve({ browse: true }, '/sub/', 'sub/');
    expect(response.status).toBe(200);
    const html = bodyText(response);
    expect(html).toContain('href="directory-alias/"'); // trailing slash: a link to a directory is one
    expect(html).not.toContain('directory-escape');
  });

  test("'follow' puts the escaping directory back", async () => {
    const options: StaticFilesOptions = { browse: true, symlinks: 'follow' };
    const response = await serve(options, '/sub/', 'sub/');
    expect(response.status).toBe(200);
    expect(bodyText(response)).toContain('href="directory-escape/"');
    expect((await serve(options, '/sub/directory-escape/secret.txt', 'sub/directory-escape/secret.txt')).status).toBe(200);
  });
});

/**
 * Capability probe for the file-link block below.  A stock Windows box
 * refuses `fs.symlink` to a file without elevation or Developer Mode, and
 * that is the ONLY reason those cases may be skipped: any other failure
 * re-throws, so a genuinely broken filesystem cannot hide behind the guard
 * and let the block pass forever.  The Linux CI runner creates symlinks
 * freely, so they do run where it counts.
 */
async function fileSymlinksAreCreatable(): Promise<boolean> {
  const probeDirectory = await mkdtemp(join(tmpdir(), 'actor-ts-symlink-probe-'));
  try {
    await writeFile(join(probeDirectory, 'target'), 'probe');
    await symlink(join(probeDirectory, 'target'), join(probeDirectory, 'link'));
    return true;
  } catch (error) {
    const code = (error as { readonly code?: string }).code;
    if (code === 'EPERM' || code === 'EACCES') return false;
    throw error;
  } finally {
    await rm(probeDirectory, { recursive: true, force: true });
  }
}

const describeIfFileSymlinks = (await fileSymlinksAreCreatable()) ? describe : describe.skip;

/*
 * A file link is the reachable half of #575: the index file the directory
 * branch serves, and the entries the listing reports.
 */
describeIfFileSymlinks('static files — within-root confinement on file links', () => {
  let linkedRoot: string;
  let outside: string;

  beforeAll(async () => {
    outside = await mkdtemp(join(tmpdir(), 'actor-ts-static-outside-file-'));
    await writeFile(join(outside, 'secret.txt'), 'out-of-root secret');

    linkedRoot = await mkdtemp(join(tmpdir(), 'actor-ts-static-links-'));
    await writeFile(join(linkedRoot, 'inside.txt'), 'in root');
    await mkdir(join(linkedRoot, 'sub'));
    // Both index candidates the directory requests below reach are links out
    // of the tree — the mount root's own and the subdirectory's.
    await symlink(join(outside, 'secret.txt'), join(linkedRoot, 'index.html'));
    await symlink(join(outside, 'secret.txt'), join(linkedRoot, 'sub', 'index.html'));
    await symlink(join(outside, 'secret.txt'), join(linkedRoot, 'sub', 'escape.txt'));
    // …and one that stays inside it, to prove the check does not over-block.
    await symlink(join(linkedRoot, 'inside.txt'), join(linkedRoot, 'sub', 'alias.txt'));
  });
  afterAll(async () => {
    await rm(linkedRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const serve = (options: StaticFilesOptions | undefined, urlPath: string, rest = ''): Promise<HttpResponse> =>
    serveFrom(linkedRoot, options, urlPath, rest);

  test('the mount root index file is refused when it links out of the root', async () => {
    expect((await serve(undefined, '/')).status).toBe(404);
  });

  test("'follow' serves that same index file", async () => {
    const response = await serve({ symlinks: 'follow' }, '/');
    expect(response.status).toBe(200);
    expect(bodyText(response)).toBe('out-of-root secret');
  });

  test('a subdirectory index file is refused when it links out of the root', async () => {
    expect((await serve(undefined, '/sub/', 'sub/')).status).toBe(404);
  });

  test('the direct request for that same index file still 404s', async () => {
    expect((await serve(undefined, '/sub/index.html', 'sub/index.html')).status).toBe(404);
  });

  test('a link that stays inside the root is served, one that escapes is not', async () => {
    const alias = await serve(undefined, '/sub/alias.txt', 'sub/alias.txt');
    expect(alias.status).toBe(200);
    expect(bodyText(alias)).toBe('in root');
    expect((await serve(undefined, '/sub/escape.txt', 'sub/escape.txt')).status).toBe(404);
  });

  test('the listing omits the escaping entries and keeps the in-root one', async () => {
    const response = await serve({ browse: true }, '/sub/', 'sub/');
    expect(response.status).toBe(200); // the escaping index counts as absent → listing
    const html = bodyText(response);
    expect(html).toContain('alias.txt');
    expect(html).not.toContain('index.html');
    expect(html).not.toContain('escape.txt');
  });

  test("'follow' puts the escaping entries back into the listing", async () => {
    const options: StaticFilesOptions = { browse: true, symlinks: 'follow', indexFiles: [] };
    const response = await serve(options, '/sub/', 'sub/');
    expect(response.status).toBe(200);
    const html = bodyText(response);
    expect(html).toContain('escape.txt');
    expect(html).toContain('index.html');
  });
});
