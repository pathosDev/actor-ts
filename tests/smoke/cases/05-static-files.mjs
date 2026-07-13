/**
 * Smoke case: static file serving on the default backend.
 *
 * Exercises the runtime-sensitive parts that the bun-test suite can't
 * cover on Node/Deno: node-compat fs (stat/readFile/readdir/realpath) and
 * the backend's body-writing path on that runtime's server primitive.
 * Serves a temp directory and checks MIME detection, index resolution,
 * a conditional 304, an encoded-traversal 404, and a browse listing.
 *
 * Skips (rather than fails) if the runtime can't bind a server; once a
 * server binds, the assertions MUST hold, so real regressions surface.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const name = 'static files';
export const description = 'getFromDirectory / browsing on the default backend';

export async function run({ actorTs }) {
  const {
    ActorSystem, ActorSystemOptions, LogLevel, NoopLogger,
    HttpExtensionId, concat, getFromDirectory, getFromBrowseableDirectory,
  } = actorTs;

  const root = await mkdtemp(join(tmpdir(), 'actor-ts-smoke-static-'));
  await writeFile(join(root, 'index.html'), '<h1>home</h1>');
  await writeFile(join(root, 'style.css'), 'body{color:red}');
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'sub', 'page.txt'), 'hello');

  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create('smoke-static', sysOptions);
  let binding;
  try {
    const routes = concat(getFromDirectory('static', root), getFromBrowseableDirectory('browse', root));
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
  } finally {
    if (binding) await binding.unbind();
    await sys.terminate();
    await rm(root, { recursive: true, force: true });
  }
}
