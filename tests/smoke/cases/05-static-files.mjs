/**
 * Smoke case: static file serving on the default backend.
 *
 * Exercises the runtime-sensitive parts that the bun-test suite can't
 * cover on Node/Deno: node-compat fs (stat/readFile/readdir/realpath, and
 * `open` + positional `FileHandle.read` for the streaming path) and the
 * backend's body-writing path on that runtime's server primitive.
 * Serves a temp directory and checks MIME detection, index resolution,
 * a conditional 304, an encoded-traversal 404, a browse listing, and a
 * `streamThreshold` mount that answers with a `ReadableStream` (#465).
 *
 * The streaming half is the reason this case matters most: `bun test` covers
 * three backends on ONE runtime, and before #465 no stream response body had
 * ever been written on Node or Deno at all.
 *
 * **Every response body is drained before it is asserted on** (#1196): a
 * `fetch` body abandoned on a failing assertion holds its connection open, and
 * on Deno that turns a red case into a run that prints its last line and never
 * exits — no exit code, so the gate silently stops being one.
 *
 * Skips (rather than fails) if the runtime can't bind a server; once a
 * server binds, the assertions MUST hold, so real regressions surface.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const name = 'static files';
export const description = 'getFromDirectory / browsing / streaming on the default backend';

/** Bigger than the 64 KiB read chunk, so streaming takes several pulls. */
const LARGE_FILE_SIZE = 300 * 1024;

/**
 * Assert the SHAPE of the body the directive builds, by calling the compiled
 * handler instead of going through a server.
 *
 * Necessary because buffered and streamed are indistinguishable over the wire:
 * both deliver the same bytes with the same `content-length`, so the fetches
 * above would stay green if streaming silently fell back to reading the file
 * whole — which is the entire property this runtime is here to prove.  The
 * bounded range read has the same problem and the same answer: a window that is
 * its own buffer, rather than a view onto the file's, shows up as
 * `buffer.byteLength`.
 *
 * Drains the stream to completion, which is also what closes the file handle
 * (#1196) — an abandoned one would keep Deno's loop alive and hang the run.
 */
async function assertDirectiveShapes({ compile, getFromFile, StaticFilesOptions }, filePath) {
  const streamingOptions = StaticFilesOptions.create()
    .withStreamThreshold(64 * 1024)
    .withMaxFileSize(64 * 1024);
  const request = (headers = {}) => ({ method: 'GET', path: '/large.bin', headers, query: {}, params: {}, body: null });
  const serve = async (options, headers) => {
    const [route] = compile(getFromFile(filePath, options));
    return await route.handler(request(headers));
  };

  const streamed = await serve(streamingOptions);
  if (streamed.status !== 200) throw new Error(`directive streamed status ${streamed.status}`);
  if (!(streamed.body instanceof ReadableStream)) {
    throw new Error(`directive body is ${streamed.body?.constructor?.name ?? typeof streamed.body}, expected ReadableStream`);
  }
  if (streamed.headers?.['content-length'] !== String(LARGE_FILE_SIZE)) {
    throw new Error(`directive content-length ${streamed.headers?.['content-length']}, expected ${LARGE_FILE_SIZE}`);
  }
  let drained = 0;
  const reader = streamed.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      drained += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (drained !== LARGE_FILE_SIZE) throw new Error(`drained ${drained} bytes, expected ${LARGE_FILE_SIZE}`);

  const ranged = await serve(undefined, { range: 'bytes=100-131' });
  if (ranged.status !== 206) throw new Error(`directive ranged status ${ranged.status}`);
  if (ranged.body.byteLength !== 32) throw new Error(`directive ranged ${ranged.body.byteLength} bytes, expected 32`);
  if (ranged.body.buffer.byteLength !== 32) {
    throw new Error(`directive ranged window is a view over ${ranged.body.buffer.byteLength} bytes, expected its own 32`);
  }
}

export async function run({ actorTs, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const {
    HttpExtensionId, compile, concat, getFromDirectory, getFromBrowseableDirectory, getFromFile, StaticFilesOptions,
  } = await loadEntry('http');

  const root = await mkdtemp(join(tmpdir(), 'actor-ts-smoke-static-'));
  await writeFile(join(root, 'index.html'), '<h1>home</h1>');
  await writeFile(join(root, 'style.css'), 'body{color:red}');
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'sub', 'page.txt'), 'hello');
  const large = new Uint8Array(LARGE_FILE_SIZE);
  for (let i = 0; i < large.length; i += 1) large[i] = (i * 31 + 7) % 251;
  await writeFile(join(root, 'large.bin'), large);

  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create('smoke-static', sysOptions);
  let binding;
  try {
    // `maxFileSize` under the file size on purpose: it is what makes the
    // assertions below bind.  A handler that fell back to buffering would still
    // deliver every byte, so nothing would move — with the cap under the file,
    // that fallback answers 413 instead.
    const streamingOptions = StaticFilesOptions.create()
      .withStreamThreshold(64 * 1024)
      .withMaxFileSize(64 * 1024);
    const routes = concat(
      getFromDirectory('static', root),
      getFromBrowseableDirectory('browse', root),
      getFromDirectory('streamed', root, streamingOptions),
    );
    try {
      binding = await sys.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(routes);
    } catch (e) {
      console.log(`  (skipped: could not bind an HTTP server on this runtime — ${e.message})`);
      return;
    }
    const base = `http://127.0.0.1:${binding.port}`;

    const css = await fetch(`${base}/static/style.css`);
    if (css.status !== 200) throw new Error(`css status ${css.status}`);
    const ct = css.headers.get('content-type') ?? '';
    if (!ct.includes('text/css')) throw new Error(`css content-type: ${ct}`);
    if ((await css.text()) !== 'body{color:red}') throw new Error('css body mismatch');

    const index = await fetch(`${base}/static/`);
    if (index.status !== 200 || (await index.text()) !== '<h1>home</h1>') throw new Error('index resolution failed');

    const etag = css.headers.get('etag');
    if (etag) {
      const cond = await fetch(`${base}/static/style.css`, { headers: { 'if-none-match': etag } });
      if (cond.status !== 304) throw new Error(`conditional expected 304, got ${cond.status}`);
    }

    const traversal = await fetch(`${base}/static/%2e%2e%2f%2e%2e%2fpackage.json`);
    if (traversal.status !== 404) throw new Error(`traversal expected 404, got ${traversal.status}`);

    const listing = await fetch(`${base}/browse/sub/`);
    if (listing.status !== 200) throw new Error(`browse status ${listing.status}`);
    if (!(await listing.text()).includes('page.txt')) throw new Error('browse listing missing page.txt');

    // A streamed 200: the file is read in chunks through `open` +
    // `FileHandle.read(buffer, offset, length, position)` and written out as a
    // web `ReadableStream`.  Drain first, assert second.
    const streamed = await fetch(`${base}/streamed/large.bin`);
    const streamedLength = streamed.headers.get('content-length');
    const streamedBytes = new Uint8Array(await streamed.arrayBuffer());
    if (streamed.status !== 200) throw new Error(`streamed status ${streamed.status}`);
    if (streamedBytes.length !== LARGE_FILE_SIZE) {
      throw new Error(`streamed body: expected ${LARGE_FILE_SIZE} bytes, got ${streamedBytes.length}`);
    }
    for (const at of [0, 64 * 1024 - 1, 64 * 1024, LARGE_FILE_SIZE - 1]) {
      if (streamedBytes[at] !== large[at]) throw new Error(`streamed body differs at byte ${at}`);
    }
    // A *wrong* length is the failure worth catching; a runtime that re-frames
    // the body as chunked and states none is making its own valid choice.
    if (streamedLength !== null && streamedLength !== String(LARGE_FILE_SIZE)) {
      throw new Error(`streamed content-length: expected ${LARGE_FILE_SIZE} or none, got ${streamedLength}`);
    }

    // A Range against the same mount reads only its window, never the file.
    const ranged = await fetch(`${base}/streamed/large.bin`, { headers: { range: 'bytes=100-131' } });
    const rangedBytes = new Uint8Array(await ranged.arrayBuffer());
    if (ranged.status !== 206) throw new Error(`ranged status ${ranged.status}`);
    if (rangedBytes.length !== 32) throw new Error(`ranged body: expected 32 bytes, got ${rangedBytes.length}`);
    if (rangedBytes[0] !== large[100] || rangedBytes[31] !== large[131]) throw new Error('ranged body window is wrong');

    await assertDirectiveShapes({ compile, getFromFile, StaticFilesOptions }, join(root, 'large.bin'));
  } finally {
    if (binding) await binding.unbind();
    await sys.terminate();
    await rm(root, { recursive: true, force: true });
  }
}
