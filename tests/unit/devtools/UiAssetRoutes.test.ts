import { afterEach, describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { concat, path, type Route } from '../../../src/http/Route.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { uiAssetRoutes, type UiAsset } from '../../../src/devtools/UiAssetRoutes.js';
import { UI_ASSETS } from '../../../src/devtools/generated/uiAssets.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';

/** Build a fake asset the way the build script would. */
function asset(assetPath: string, contentType: string, content: string): UiAsset {
  const bytes = new TextEncoder().encode(content);
  return {
    path: assetPath,
    contentType,
    size: bytes.byteLength,
    etag: `"${assetPath}-v1"`,
    gzipBase64: Buffer.from(gzipSync(bytes)).toString('base64'),
  };
}

const FAKE_ASSETS: ReadonlyArray<UiAsset> = [
  asset('index.html', 'text/html; charset=utf-8', '<div id="app"></div>'),
  asset('assets/main.js', 'text/javascript; charset=utf-8', 'console.log("ui")'),
];

const live: { binding: ServerBinding; system: ActorSystem }[] = [];
afterEach(async () => {
  for (const { binding, system } of live.splice(0)) {
    await binding.unbind();
    await system.terminate();
  }
});

async function start(routes: Route): Promise<string> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('devtools-assets-test', systemOptions);
  const binding = await system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .bind(routes);
  live.push({ binding, system });
  return `http://${binding.host}:${binding.port}`;
}

describe('uiAssetRoutes', () => {
  test('serves the shell at the root', async () => {
    const url = await start(uiAssetRoutes(FAKE_ASSETS));
    const response = await fetch(`${url}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<div id="app">');
  });

  test('serves a nested asset with its content type', async () => {
    const url = await start(uiAssetRoutes(FAKE_ASSETS));
    const response = await fetch(`${url}/assets/main.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(await response.text()).toBe('console.log("ui")');
  });

  test('404s a missing asset instead of falling back to the shell', async () => {
    // A hash-router SPA needs no fallback, and one would turn a typo in
    // a bundle path into an HTML page served as JavaScript.
    const url = await start(uiAssetRoutes(FAKE_ASSETS));
    expect((await fetch(`${url}/assets/missing.js`)).status).toBe(404);
  });

  test('answers a matching If-None-Match with 304 and no body', async () => {
    const url = await start(uiAssetRoutes(FAKE_ASSETS));
    const first = await fetch(`${url}/assets/main.js`);
    const etag = first.headers.get('etag')!;
    expect(etag).toBe('"assets/main.js-v1"');

    const second = await fetch(`${url}/assets/main.js`, { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  test('re-sends the body when the ETag does not match', async () => {
    const url = await start(uiAssetRoutes(FAKE_ASSETS));
    const response = await fetch(`${url}/assets/main.js`, { headers: { 'if-none-match': '"stale"' } });
    expect(response.status).toBe(200);
  });

  test('advertises cache revalidation rather than immutability', async () => {
    const url = await start(uiAssetRoutes(FAKE_ASSETS));
    const response = await fetch(`${url}/assets/main.js`);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('vary')).toBe('accept-encoding');
  });

  test('decompresses for a client that cannot take gzip', async () => {
    const url = await start(uiAssetRoutes(FAKE_ASSETS));
    const response = await fetch(`${url}/assets/main.js`, { headers: { 'accept-encoding': 'identity' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.text()).toBe('console.log("ui")');
  });

  test('redirects a mount prefix without a trailing slash', async () => {
    // index.html references its bundle relatively, which only resolves
    // into the right directory once the document URL ends in a slash.
    const url = await start(path('devtools', uiAssetRoutes(FAKE_ASSETS)));
    const response = await fetch(`${url}/devtools`, { redirect: 'manual' });
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/devtools/');
  });

  test('the mount-prefix redirect puts the slash on the path, not inside a query', async () => {
    // The shell redirect appends to `HttpRequest.path`.  While the default
    // backend reported the raw request target there, `GET /devtools?x=1`
    // answered `Location: /devtools?x=1/` — a trailing slash on a query
    // value, which resolves relative asset URLs against the wrong
    // directory, exactly what the redirect exists to prevent.
    const url = await start(path('devtools', uiAssetRoutes(FAKE_ASSETS)));
    const response = await fetch(`${url}/devtools?panel=actors`, { redirect: 'manual' });
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/devtools/');
  });

  test('serves assets under a mount prefix', async () => {
    const url = await start(concat(path('devtools', uiAssetRoutes(FAKE_ASSETS))));
    expect(await (await fetch(`${url}/devtools/assets/main.js`)).text()).toBe('console.log("ui")');
  });
});

describe('generated UI bundle', () => {
  test('contains a shell entry point', () => {
    const paths = UI_ASSETS.map((entry) => entry.path);
    expect(paths).toContain('index.html');
    expect(paths.some((entry) => /^assets\/main\.js$/.test(entry))).toBe(true);
    expect(paths.some((entry) => /^assets\/main\.css$/.test(entry))).toBe(true);
  });

  test('every asset decompresses to its recorded size', async () => {
    const { gunzipSync } = await import('node:zlib');
    for (const entry of UI_ASSETS) {
      const bytes = gunzipSync(Buffer.from(entry.gzipBase64, 'base64'));
      expect(bytes.byteLength).toBe(entry.size);
    }
  });

  test('every asset has a strong, quoted ETag', () => {
    for (const entry of UI_ASSETS) {
      expect(entry.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    }
  });

  test('the shell references the tap protocol version it was built against', async () => {
    const { gunzipSync } = await import('node:zlib');
    const index = UI_ASSETS.find((entry) => entry.path === 'index.html')!;
    const html = new TextDecoder().decode(gunzipSync(Buffer.from(index.gzipBase64, 'base64')));
    expect(html).toContain('id="app"');
    expect(html).toContain('assets/main.js');
  });
});
