/**
 * Smoke case: native Express middleware runs at the WebSocket handshake (#623).
 *
 * The Express backend dispatches an upgrade through the app itself — a
 * synthesised `ServerResponse` is bound to the raw `'upgrade'` socket and the
 * app is called with it — so `app.use(...)` guards the handshake the same way
 * they guard any other request.  Both halves of that are runtime-sensitive
 * (`ServerResponse.assignSocket` on a hijacked socket, then `detachSocket`
 * before `ws` takes it over), and `bun test` only ever exercises Bun.  This
 * case pins the accept path *and* the reject path on Node and Deno too.
 *
 * `express` and `ws` are optional peer dependencies, so a runtime that cannot
 * load them skips rather than fails — but once the server binds, both
 * outcomes MUST hold, so a real regression still surfaces.
 */
export const name = 'express upgrade middleware';
export const description = 'app.use(...) gates the WebSocket handshake on the Express backend';

export async function run({ actorTs }) {
  const {
    ActorSystem, ActorSystemOptions, LogLevel, NoopLogger,
    HttpExtensionId, WebsocketServerActor, websocket,
    ExpressBackend, ExpressBackendOptions,
  } = actorTs;

  let express;
  try {
    express = (await import('express')).default ?? (await import('express'));
    await import('ws');
  } catch (e) {
    console.log(`  (skipped: express/ws not loadable on this runtime — ${e.message})`);
    return;
  }

  class Echo extends WebsocketServerActor {
    onMessage(message) { this.reply({ pong: message.n }); }
  }

  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('smoke-express-upgrade', systemOptions);

  // One middleware, two jobs: record that it saw the handshake at all, and
  // refuse it unless the caller asked nicely via the query string (the only
  // channel a `new WebSocket(url)` client can use).
  const seen = [];
  const application = express();
  application.use((request, response, next) => {
    seen.push(request.url);
    if (!String(request.url).includes('token=good')) { response.status(401).end('denied'); return; }
    next();
  });

  let binding;
  try {
    const backendOptions = ExpressBackendOptions.create().withApp(application);
    const server = system.spawn(Echo, 'echo');
    try {
      binding = await system.extension(HttpExtensionId)
        .newServerAt('127.0.0.1', 0)
        .useBackend(new ExpressBackend(backendOptions))
        .bind(websocket('/ws', server));
    } catch (e) {
      console.log(`  (skipped: express backend unsupported on this runtime — ${e.message})`);
      return;
    }

    const base = `ws://127.0.0.1:${binding.port}/ws`;
    const refused = await settle(base);
    if (refused !== 'closed') {
      throw new Error(`middleware did not gate the handshake: expected 'closed', got '${refused}'`);
    }

    const accepted = await settle(`${base}?token=good`);
    if (accepted !== 'open') {
      throw new Error(`middleware allowed it but the handshake failed: got '${accepted}'`);
    }

    // Guards the guard: if the middleware never ran, both outcomes above
    // could still be produced by an unrelated failure.  The count is a
    // floor rather than an equality — Node's WebSocket client retries the
    // refused handshake once, so the middleware legitimately sees three.
    if (seen.length < 2 || !seen.includes('/ws') || !seen.includes('/ws?token=good')) {
      throw new Error(`the middleware did not see both handshakes: ${JSON.stringify(seen)}`);
    }
  } finally {
    if (binding) await binding.unbind();
    await system.terminate();
  }
}

/**
 * Resolve 'open' if the handshake completed, 'closed' if it did not.
 *
 * The timeout is a real outcome, not a safety net: on Deno a refused upgrade
 * reaches the client as neither a response nor a close, so the wait is the
 * only signal there — which is why this case takes ~5 s on that runtime.
 */
function settle(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    let done = false;
    const finish = (outcome) => { if (!done) { done = true; resolve(outcome); } };
    const timer = setTimeout(() => finish('closed'), timeoutMs);
    // Record the outcome *before* closing: some runtimes dispatch 'close'
    // synchronously from close(), which would otherwise overwrite it.
    socket.onopen = () => { clearTimeout(timer); finish('open'); try { socket.close(); } catch { /* ignore */ } };
    socket.onerror = () => { clearTimeout(timer); finish('closed'); };
    socket.onclose = () => { clearTimeout(timer); finish('closed'); };
  });
}
