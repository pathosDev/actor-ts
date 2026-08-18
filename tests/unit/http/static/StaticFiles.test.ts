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
import { StaticFilesOptions } from '../../../../src/http/static/StaticFilesOptions.js';
import { readFileStream } from '../../../../src/http/static/FsAccess.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import type { HttpServerBackend, ServerBinding } from '../../../../src/http/backend/HttpServerBackend.js';
import type { HttpRequest, HttpResponse } from '../../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';

/**
 * Size of `large.bin`.  Bigger than one read chunk (64 KiB) so a streamed
 * response is forced through several `pull` rounds instead of finishing in
 * one, and bigger than Node's 4 KiB Buffer pool so `readFile`'s allocation is
 * exact — which is what lets the range assertions compare `buffer.byteLength`
 * against the whole-file size and mean something.
 */
const LARGE_FILE_SIZE = 300 * 1024;

/** Deterministic, position-dependent bytes, so a mis-ordered chunk shows up. */
function largeFileBytes(): Uint8Array {
  const bytes = new Uint8Array(LARGE_FILE_SIZE);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) % 251;
  return bytes;
}

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'actor-ts-static-'));
  await writeFile(join(root, 'index.html'), '<h1>home</h1>');
  await writeFile(join(root, 'style.css'), 'body{}');
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'sub', 'page.txt'), 'hello sub');
  await writeFile(join(root, '.secret'), 'nope');
  await writeFile(join(root, 'large.bin'), largeFileBytes());
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

/**
 * Which backends put the streamed body's length on the wire — a measurement,
 * not a preference.  Fastify and Express both keep a `content-length` the
 * handler set before the body.  Hono hands its `Response` to whatever server
 * the runtime provides, and `Bun.serve` drops the header and re-frames the body
 * as chunked; `node:http` and `Deno.serve` keep it, so the same mount IS
 * length-stated on the other two runtimes (the smoke case covers that side —
 * `bun test` only ever runs here).
 */
const backendsStatingStreamLength = new Set(['fastify', 'express']);

describe.each(backends)('static files — %s backend', (backendName, mk) => {
  const routes = (): Route => {
    /*
     * A second mount of the same tree with streaming on — the cross-backend
     * half of #465.  `maxFileSize` is deliberately BELOW the file and equal to
     * the threshold, which is what binds these cases: a handler that quietly
     * fell back to buffering would still deliver every byte and still let the
     * backend compute a correct `content-length`, so nothing below would move.
     * With the cap under the file size, that fallback answers 413 instead.
     */
    const streamingOptions = StaticFilesOptions.create()
      .withStreamThreshold(64 * 1024)
      .withMaxFileSize(64 * 1024);
    return concat(
      getFromDirectory('static', root),
      getFromBrowseableDirectory('browse', root),
      getFromDirectory('streamed', root, streamingOptions),
    );
  };

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

  test('the directory redirect keeps the query and puts the slash on the path', async () => {
    // The query is re-appended after the trailing slash, never inside it.
    // A backend reporting the raw request target in `HttpRequest.path`
    // produced `/static?a=1/` here — the slash landing in the query value,
    // so the redirect target addressed a different resource and the
    // documented "query preserved" guarantee held on two backends of three.
    const url = await start(mk, routes());
    const response = await fetch(`${url}/static?a=1&b=2`, { redirect: 'manual' });
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/static/?a=1&b=2');
  });

  test('the directory listing heading is the pathname, without the query', async () => {
    const url = await start(mk, routes());
    const response = await fetch(`${url}/browse/sub/?show=all`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('/browse/sub/');
    expect(html).not.toContain('show=all');
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

  test('a streamed file arrives byte-for-byte over the wire', async () => {
    const url = await start(mk, routes());
    const response = await fetch(`${url}/streamed/large.bin`);
    expect(response.status).toBe(200);
    const received = new Uint8Array(await response.arrayBuffer());
    expect(received.length).toBe(LARGE_FILE_SIZE);
    // Spot-check the ends and a chunk boundary rather than 300 KiB of
    // comparisons: a dropped or reordered `pull` moves at least one of them.
    const expected = largeFileBytes();
    expect(received[0]).toBe(expected[0]);
    expect(received[64 * 1024 - 1]).toBe(expected[64 * 1024 - 1]);
    expect(received[64 * 1024]).toBe(expected[64 * 1024]);
    expect(received[LARGE_FILE_SIZE - 1]).toBe(expected[LARGE_FILE_SIZE - 1]);
  });

  test('a streamed 200 states its content-length wherever the backend can', async () => {
    // The handler always sets the header (pinned exactly in the directive-level
    // block below).  Whether it reaches the client is the backend's half: with
    // nothing set, a stream body has no length for a backend to measure and
    // every large download would silently become chunked, so what is asserted
    // here is that the length arrives *correct* rather than merely present.
    const url = await start(mk, routes());
    const response = await fetch(`${url}/streamed/large.bin`);
    expect(response.status).toBe(200);
    if (backendsStatingStreamLength.has(backendName)) {
      expect(response.headers.get('content-length')).toBe(String(LARGE_FILE_SIZE));
    } else {
      // Never a *wrong* length — a stated 0, as Fastify used to answer, is
      // worse than an honest chunked framing.
      expect(response.headers.get('content-length')).toBeNull();
      expect(response.headers.get('transfer-encoding')).toBe('chunked');
    }
    await response.arrayBuffer(); // drain: an abandoned body keeps the socket open
  });

  test('a Range against a streaming mount still answers 206 with the window', async () => {
    const url = await start(mk, routes());
    const response = await fetch(`${url}/streamed/large.bin`, { headers: { range: 'bytes=100-131' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 100-131/${LARGE_FILE_SIZE}`);
    const received = new Uint8Array(await response.arrayBuffer());
    expect(received.length).toBe(32);
    expect(received[0]).toBe(largeFileBytes()[100]);
    expect(received[31]).toBe(largeFileBytes()[131]);
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

/**
 * Read a directive-level body as text.  The stream arm is not decoration: a
 * `streamThreshold` mount answers with a `ReadableStream`, and `TextDecoder`
 * throws on one — so a helper that only handled `Uint8Array` would make
 * "return bytes again" look like the fix for a failing streaming test and
 * silently revert #465.
 */
async function bodyText(response: HttpResponse): Promise<string> {
  const body = response.body;
  if (typeof body === 'string') return body;
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return new TextDecoder().decode(await drainStream(body));
  }
  return new TextDecoder().decode(body as Uint8Array);
}

/** Concatenate every chunk of a one-shot response stream. */
async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

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
    const html = await bodyText(response);
    expect(html).toContain('href="directory-alias/"'); // trailing slash: a link to a directory is one
    expect(html).not.toContain('directory-escape');
  });

  test("'follow' puts the escaping directory back", async () => {
    const options: StaticFilesOptions = { browse: true, symlinks: 'follow' };
    const response = await serve(options, '/sub/', 'sub/');
    expect(response.status).toBe(200);
    expect(await bodyText(response)).toContain('href="directory-escape/"');
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
    expect(await bodyText(response)).toBe('out-of-root secret');
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
    expect(await bodyText(alias)).toBe('in root');
    expect((await serve(undefined, '/sub/escape.txt', 'sub/escape.txt')).status).toBe(404);
  });

  test('the listing omits the escaping entries and keeps the in-root one', async () => {
    const response = await serve({ browse: true }, '/sub/', 'sub/');
    expect(response.status).toBe(200); // the escaping index counts as absent → listing
    const html = await bodyText(response);
    expect(html).toContain('alias.txt');
    expect(html).not.toContain('index.html');
    expect(html).not.toContain('escape.txt');
  });

  test("'follow' puts the escaping entries back into the listing", async () => {
    const options: StaticFilesOptions = { browse: true, symlinks: 'follow', indexFiles: [] };
    const response = await serve(options, '/sub/', 'sub/');
    expect(response.status).toBe(200);
    const html = await bodyText(response);
    expect(html).toContain('escape.txt');
    expect(html).toContain('index.html');
  });
});

/*
 * How much of a file the handler holds in memory (#465, #969).  Directive-level
 * on purpose: the invariants here are about the SHAPE of `HttpResponse.body` —
 * a stream vs a buffer, and how large the buffer behind a range view is — and
 * every backend erases that distinction by the time bytes reach a socket.  The
 * cross-backend block above proves the wire behaviour; this block proves the
 * memory behaviour, and only one of the two can regress silently.
 */
describe('static files — read window and streaming', () => {
  const requestFor = (
    headers: Readonly<Record<string, string>> = {},
    method: HttpRequest['method'] = 'GET',
  ): HttpRequest => ({
    method, path: '/large.bin', headers, query: {}, params: {}, body: null,
  });

  const serveLarge = async (
    options: StaticFilesOptions | undefined,
    headers?: Readonly<Record<string, string>>,
    method?: HttpRequest['method'],
  ): Promise<HttpResponse> => {
    const compiled = compile(getFromFile(join(root, 'large.bin'), options));
    const route = compiled[0] as CompiledRoute;
    return await route.handler(requestFor(headers, method));
  };

  test('by default a 200 body is still a buffer, not a stream', async () => {
    // The opt-in half of the decision: a stream body is one-shot, and the
    // middleware that mishandles one (#674) and the backend that pipes it
    // without an error handler (#979) are both still open.  If this ever goes
    // red because the default flipped, those two have to have landed first.
    const response = await serveLarge(undefined);
    expect(response.status).toBe(200);
    expect(response.body).toBeInstanceOf(Uint8Array);
    expect((response.body as Uint8Array).byteLength).toBe(LARGE_FILE_SIZE);
  });

  test('a Range buffers the requested window only, not the whole file', async () => {
    // The read-amplification invariant.  The old implementation read the file
    // whole and returned `bytes.subarray(start, end + 1)`; a subarray is a
    // VIEW, so the response kept the entire 300 KiB `ArrayBuffer` alive to
    // answer 32 bytes — once per in-flight request.  `byteLength` alone cannot
    // tell the two apart, which is why the assertion that matters is on the
    // backing buffer.
    const response = await serveLarge(undefined, { range: 'bytes=100-131' });
    expect(response.status).toBe(206);
    const bytes = response.body as Uint8Array;
    expect(bytes.byteLength).toBe(32);
    expect(bytes.buffer.byteLength).toBe(32);
    expect(bytes[0]).toBe(largeFileBytes()[100]);
    expect(bytes[31]).toBe(largeFileBytes()[131]);
  });

  test('a one-byte Range does not allocate the file', async () => {
    const response = await serveLarge(undefined, { range: 'bytes=0-0' });
    expect(response.status).toBe(206);
    expect(response.headers?.['content-length']).toBe('1');
    expect((response.body as Uint8Array).buffer.byteLength).toBe(1);
  });

  test('above the threshold the 200 body is a stream with a stated length', async () => {
    const options = StaticFilesOptions.create().withStreamThreshold(64 * 1024);
    const response = await serveLarge(options);
    expect(response.status).toBe(200);
    expect(response.body).toBeInstanceOf(ReadableStream);
    expect(response.headers?.['content-length']).toBe(String(LARGE_FILE_SIZE));
    const drained = await drainStream(response.body as ReadableStream<Uint8Array>);
    expect(drained.byteLength).toBe(LARGE_FILE_SIZE);
    const expected = largeFileBytes();
    expect(drained[0]).toBe(expected[0]);
    expect(drained[64 * 1024]).toBe(expected[64 * 1024]);
    expect(drained[LARGE_FILE_SIZE - 1]).toBe(expected[LARGE_FILE_SIZE - 1]);
  });

  test('below the threshold the same mount still buffers', async () => {
    // The threshold is a boundary, not a switch: a 300 KiB file under a 1 MiB
    // threshold keeps the cheaper single-read path.
    const options = StaticFilesOptions.create().withStreamThreshold(1024 * 1024);
    const response = await serveLarge(options);
    expect(response.status).toBe(200);
    expect(response.body).toBeInstanceOf(Uint8Array);
  });

  test('the threshold applies to the Range window, not the file size', async () => {
    const options = StaticFilesOptions.create().withStreamThreshold(64 * 1024);
    const small = await serveLarge(options, { range: 'bytes=0-15' });
    expect(small.status).toBe(206);
    expect(small.body).toBeInstanceOf(Uint8Array);

    const wide = await serveLarge(options, { range: `bytes=0-${LARGE_FILE_SIZE - 1}` });
    expect(wide.status).toBe(206);
    expect(wide.body).toBeInstanceOf(ReadableStream);
    const drained = await drainStream(wide.body as ReadableStream<Uint8Array>);
    expect(drained.byteLength).toBe(LARGE_FILE_SIZE);
  });

  test('HEAD reads nothing whether streaming is on or off', async () => {
    const options = StaticFilesOptions.create().withStreamThreshold(64 * 1024);
    for (const settings of [undefined, options]) {
      const response = await serveLarge(settings, {}, 'HEAD');
      expect(response.status).toBe(200);
      expect(response.body).toBeNull();
      expect(response.headers?.['content-length']).toBe(String(LARGE_FILE_SIZE));
    }
  });

  test('a file over maxFileSize is refused with 413 while bodies are buffered', async () => {
    // First test this branch has ever had: `maxFileSize` is documented as the
    // in-memory buffering cap, and nothing pinned the refusal it produces.
    const options = StaticFilesOptions.create().withMaxFileSize(1024);
    const response = await serveLarge(options);
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: 'file too large' });
  });

  test('a threshold retires that 413 instead of refusing what streaming exists for', async () => {
    const options = StaticFilesOptions.create()
      .withMaxFileSize(1024)
      .withStreamThreshold(1024);
    const response = await serveLarge(options);
    expect(response.status).toBe(200);
    expect(response.body).toBeInstanceOf(ReadableStream);
    await (response.body as ReadableStream<Uint8Array>).cancel();
  });

  test('a threshold above maxFileSize is rejected as a contradiction', () => {
    // The rule that makes skipping the 413 safe: with it held, no response can
    // buffer more than `streamThreshold` bytes, so the cap is unreachable
    // rather than waived.  Without it there would be a band of sizes that
    // streaming is enabled for and the cap still refuses.
    const options = StaticFilesOptions.create()
      .withMaxFileSize(1024)
      .withStreamThreshold(2048);
    expect(() => getFromFile(join(root, 'large.bin'), options)).toThrow(OptionsError);
    expect(() => getFromFile(join(root, 'large.bin'), options)).toThrow(/streamThreshold must not exceed maxFileSize/);
  });

  test('a non-integer or zero threshold is rejected', () => {
    expect(() => getFromFile(join(root, 'large.bin'), { streamThreshold: 0 })).toThrow(OptionsError);
    expect(() => getFromFile(join(root, 'large.bin'), { streamThreshold: 2.5 })).toThrow(OptionsError);
  });
});

/*
 * The stream source itself.  Driven directly rather than through the handler
 * because the properties under test — chunking, a window that starts mid-file,
 * and releasing the file handle on every exit — are `readFileStream`'s and
 * would be invisible once a response has been drained for its bytes.
 */
describe('static files — readFileStream', () => {
  test('chunks a window that starts mid-file and ends exactly', async () => {
    const stream = readFileStream(join(root, 'large.bin'), 1000, 200 * 1024);
    const chunkSizes: number[] = [];
    const reader = stream.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkSizes.push(value.byteLength);
      total += value.byteLength;
    }
    reader.releaseLock();
    expect(total).toBe(200 * 1024);
    // 64 KiB chunks: three full ones plus an 8 KiB remainder.
    expect(chunkSizes).toEqual([64 * 1024, 64 * 1024, 64 * 1024, 8 * 1024]);
  });

  test('an empty window opens no handle and closes immediately', async () => {
    const stream = readFileStream(join(root, 'large.bin'), 0, 0);
    const reader = stream.getReader();
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
  });

  test('cancelling after a partial read releases the handle and does not double-close', async () => {
    // `cancel` can arrive while a `pull` is still settling, and closing a
    // handle twice rejects on Node — so the release has to be idempotent.
    // On Windows the `rm` below is the real detector: an open handle makes
    // unlinking the file fail, which is exactly a leak.  On POSIX unlink
    // succeeds regardless, and a leak surfaces instead as a Deno
    // `--trace-leaks` op in the smoke case.
    const scratch = await mkdtemp(join(tmpdir(), 'actor-ts-static-cancel-'));
    const file = join(scratch, 'large.bin');
    await writeFile(file, largeFileBytes());
    const stream = readFileStream(file, 0, LARGE_FILE_SIZE);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
    reader.releaseLock();
    await rm(scratch, { recursive: true });
  });

  test('a missing file surfaces as a stream error, not a silent empty body', async () => {
    const stream = readFileStream(join(root, 'does-not-exist.bin'), 0, 10);
    const reader = stream.getReader();
    await expect(reader.read()).rejects.toThrow();
    reader.releaseLock();
  });
});
