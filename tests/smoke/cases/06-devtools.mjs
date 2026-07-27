/**
 * Smoke case: the DevTools suite end to end (#445).
 *
 * This is the only check that the EMBEDDED UI bundle actually ships and
 * loads: on Node and Deno the harness imports from `dist/`, so a broken
 * asset pipeline (missing generated module, base64 that will not decode,
 * a `Buffer`-only path that Deno rejects) fails here and nowhere else.
 * It also covers the tap handshake on each runtime's WebSocket
 * primitive, which the bun-test suite can only exercise on Bun.
 *
 * Skips (rather than fails) if the runtime cannot bind a server; once
 * bound, every assertion MUST hold so real regressions surface.
 */
export const name = 'devtools';
export const description = 'attach, embedded UI, conditional GET, tap handshake';

export async function run({ actorTs }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;

  // DevTools is a separate entry point on purpose (the package root must
  // not carry the UI bundle), so the harness's `actorTs` does not have it.
  const fromBuild = globalThis.process?.env?.ACTOR_TS_SMOKE_USE_DIST === '1'
    || globalThis.Deno?.env?.get?.('ACTOR_TS_SMOKE_USE_DIST') === '1';
  const devtoolsPath = fromBuild ? '../../../dist/devtools/index.js' : '../../../src/devtools/index.ts';
  const { DevTools, DevToolsOptions, DEVTOOLS_PROTOCOL_VERSION } =
    await import(new URL(devtoolsPath, import.meta.url).href);

  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('smoke-devtools', systemOptions);

  let devtools;
  try {
    const devtoolsOptions = DevToolsOptions.create().withHost('127.0.0.1').withPort(0);
    try {
      devtools = await DevTools.attach(system, devtoolsOptions);
    } catch (e) {
      console.log(`  (skipped: could not bind the DevTools server on this runtime — ${e.message})`);
      return;
    }
    const base = devtools.url;

    // 1. The embedded shell is served and references its bundle.
    const shell = await fetch(`${base}/`);
    if (shell.status !== 200) throw new Error(`shell status ${shell.status}`);
    const shellType = shell.headers.get('content-type') ?? '';
    if (!shellType.includes('text/html')) throw new Error(`shell content-type: ${shellType}`);
    const html = await shell.text();
    if (!html.includes('id="app"')) throw new Error('shell is missing its mount point');
    if (!html.includes('assets/main.js')) throw new Error('shell does not reference its bundle');

    // 2. The bundle itself decodes out of the embedded module.
    const bundle = await fetch(`${base}/assets/main.js`);
    if (bundle.status !== 200) throw new Error(`bundle status ${bundle.status}`);
    const bundleBody = await bundle.text();
    if (bundleBody.length === 0) throw new Error('bundle decoded to an empty body');

    // 3. Content-hashed ETags survive a conditional request.
    const etag = bundle.headers.get('etag');
    if (!etag) throw new Error('bundle has no ETag');
    const conditional = await fetch(`${base}/assets/main.js`, { headers: { 'if-none-match': etag } });
    if (conditional.status !== 304) throw new Error(`conditional expected 304, got ${conditional.status}`);

    // 4. Identity encoding works for a client that cannot take gzip —
    //    this is the path that decompresses on the server.
    const identity = await fetch(`${base}/assets/main.js`, { headers: { 'accept-encoding': 'identity' } });
    if (identity.status !== 200) throw new Error(`identity status ${identity.status}`);
    if ((await identity.text()).length === 0) throw new Error('identity body was empty');

    // 5. The handshake, as JSON.
    const info = await (await fetch(`${base}/api/info`)).json();
    if (info.protocolVersion !== DEVTOOLS_PROTOCOL_VERSION) {
      throw new Error(`info protocol ${info.protocolVersion} != ${DEVTOOLS_PROTOCOL_VERSION}`);
    }
    if (info.systemName !== 'smoke-devtools') throw new Error(`info system ${info.systemName}`);

    // 6. The handshake, over the socket.
    if (typeof globalThis.WebSocket !== 'function') {
      console.log('  (partial: no global WebSocket on this runtime — tap handshake not checked)');
      return;
    }
    const welcome = await handshake(`${base.replace(/^http/, 'ws')}/api/ws`, DEVTOOLS_PROTOCOL_VERSION);
    if (welcome.kind !== 'welcome') throw new Error(`expected a welcome frame, got ${welcome.kind}`);
    if (welcome.protocolVersion !== DEVTOOLS_PROTOCOL_VERSION) {
      throw new Error(`welcome protocol ${welcome.protocolVersion}`);
    }
    if (welcome.systemName !== 'smoke-devtools') throw new Error(`welcome system ${welcome.systemName}`);
    if (!welcome.panels?.some((panel) => panel.id === 'dashboard' && panel.status === 'active')) {
      throw new Error('welcome does not advertise an active dashboard');
    }
  } finally {
    if (devtools) await devtools.detach();
    await system.terminate();
  }
}

/** Open the tap, say hello, resolve with the first frame back. */
function handshake(url, protocolVersion) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('timed out waiting for the DevTools welcome frame'));
    }, 5000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ kind: 'hello', protocolVersion, client: 'smoke' }));
    });
    socket.addEventListener('message', (event) => {
      clearTimeout(timer);
      socket.close();
      try {
        resolve(JSON.parse(String(event.data)));
      } catch (e) {
        reject(new Error(`welcome frame was not JSON: ${e.message}`));
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('DevTools websocket failed to open'));
    });
  });
}
