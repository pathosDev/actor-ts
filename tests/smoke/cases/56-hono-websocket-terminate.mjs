/**
 * Smoke case: the Hono backend's WebSocket adapter hard-closes a socket where
 * the runtime's own socket can, on the runtime the user actually runs.
 *
 * `WebsocketConnection.abort()` and the shutdown path drop a connection with
 * the adapter's `terminate()`, and fall back to `close()` where it has none.
 * Hono hands each runtime's socket over as `WSContext.raw`, and each runtime
 * differs, so this case asserts each outcome rather than one behaviour:
 *
 *   - **Bun** — the `ServerWebSocket`, which has `terminate()`: the adapter
 *     has one, and the client sees the connection drop — 1006, not clean
 *     (bun 1.4.2 and 1.4.4).
 *   - **Node** — `@hono/node-ws` hands over the `ws` `WebSocket`, which has
 *     `terminate()` too: the same 1006 (node v26.10.0).
 *   - **Deno** — a standard `WebSocket`, which has none: the adapter has no
 *     `terminate()`, so `abort()` falls back to a close frame, which is what
 *     the client sees.
 *
 * The client is the runtime's own `WebSocket`.  It is closed and every timer
 * cleared on every path, and the server unbound in `finally`, so no outcome
 * leaves a handle open (#1196).  Skips when `hono` cannot be loaded on this
 * runtime, like the other Hono cases — but once a server binds, every check
 * below must hold.
 */
export const name = 'hono websocket terminate';
export const description = 'the Hono WebSocket adapter hard-closes a socket on Bun and Node, where the runtime socket has terminate(), and has no terminate() on Deno, where it does not';

const ENDS_WITHIN_MS = 5_000;

/** Connect to `port` and resolve with how the client saw the connection end, or 'still open'. */
function clientEnding(port) {
  return new Promise((resolve) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/socket`);
    const timer = setTimeout(() => {
      try { client.close(); } catch { /* already closing */ }
      resolve('still open');
    }, ENDS_WITHIN_MS);
    client.onclose = (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, wasClean: event.wasClean });
    };
    client.onerror = () => { /* observed as the close that follows */ };
  });
}

/** The buffer between the upgrade and the listeners attaching: small, since nothing is sent here. */
const PRE_ATTACH_BUFFER = { maxFrames: 16, maxBytes: 64 * 1024 };

export async function run({ runtime, loadEntry }) {
  const { HonoBackend } = await loadEntry('http');

  try {
    await import('hono');
  } catch (e) {
    console.log(`  (skipped: hono not loadable on this runtime — ${e.message})`);
    return;
  }

  let accepted;
  const backend = new HonoBackend();
  backend.registerWebSocket({
    pattern: '/socket',
    maxFrameBytes: 1024,
    preAttachBuffer: PRE_ATTACH_BUFFER,
    authorize: async () => null,
    onConnection: (_request, adapter) => {
      accepted = adapter;
      adapter.setListeners({ onMessage: () => {}, onClose: () => {}, onError: () => {} });
      if (adapter.terminate) adapter.terminate();
      else adapter.close(4000, 'no terminate here');
    },
  });
  let binding;
  try {
    try {
      binding = await backend.listen('127.0.0.1', 0);
    } catch (e) {
      console.log(`  (skipped: could not bind the Hono backend on this runtime — ${e.message})`);
      return;
    }
    const ending = await clientEnding(binding.port);
    if (accepted === undefined) throw new Error(`the upgrade was never accepted on ${runtime}; the client saw ${JSON.stringify(ending)}`);

    if (runtime === 'deno') {
      if (typeof accepted.terminate !== 'undefined') {
        throw new Error('the adapter has terminate() on Deno, whose WebSocket has none — it must leave it undefined');
      }
      if (ending === 'still open' || ending.code !== 4000 || ending.wasClean !== true) {
        throw new Error(`on Deno close(4000) must reach the client as a clean 4000, saw ${JSON.stringify(ending)}`);
      }
      return;
    }

    if (typeof accepted.terminate !== 'function') {
      throw new Error(`the adapter has no terminate() on ${runtime}, whose socket has one — abort() would send a close frame`);
    }
    if (ending === 'still open' || ending.code !== 1006 || ending.wasClean !== false) {
      throw new Error(`terminate() on ${runtime} must drop the connection without a close frame (1006, not clean), saw ${JSON.stringify(ending)}`);
    }
  } finally {
    if (binding) await binding.unbind();
  }
}
