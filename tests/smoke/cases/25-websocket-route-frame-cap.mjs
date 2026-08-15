/**
 * Smoke case: a `websocket()` route that raises `maxFrameBytes` really
 * receives frames that large, on whichever runtime is running (#373).
 *
 * Runtime-sensitive in the strict sense.  The cap the route resolves to is
 * installed as the *transport* payload limit, and each runtime takes that
 * through its own knob: `Bun.serve`'s `maxPayloadLength`, the `ws` server
 * `@hono/node-ws` builds on Node, and nothing at all on Deno, whose
 * `upgradeWebSocket` has no payload option.  Three separate stacks, one
 * guarantee — and until #373 all three were handed the framework default
 * instead of the route's number, so a frame between 1 MiB and the route's cap
 * was cut off by the runtime on Bun and Node while passing on Deno.
 *
 * Only the inbound direction is large: the reply carries a length, not the
 * payload, so nothing here depends on what a *client* will accept.
 *
 * `hono` (and, on Node, `@hono/node-server` + `@hono/node-ws`) are optional
 * peer dependencies, so a runtime that cannot load them skips rather than
 * fails.
 */
import net from 'node:net';

export const name = 'websocket route frame cap';
export const description = 'a route that raises maxFrameBytes receives a frame the framework default would have refused';

/** Comfortably above the 1 MiB framework default the transport used to use. */
const ROUTE_FRAME_CAP_BYTES = 8 * 1024 * 1024;
/** Between the default and the route's cap — the band #373 is about. */
const PROBE_BYTES = 2 * 1024 * 1024;

export async function run({ actorTs, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const {
    HttpExtensionId,
    HonoBackend,
    WebsocketServerActor,
    WebsocketRouteOptions,
    websocket,
  } = await loadEntry('http');

  try {
    await import('hono');
  } catch (e) {
    console.log(`  (skipped: hono not loadable on this runtime — ${e.message})`);
    return;
  }

  const accepted = [];
  class Echo extends WebsocketServerActor {
    onMessage(message) {
      accepted.push(message.text.length);
      this.reply({ kind: 'echoed', length: message.text.length });
    }
  }

  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('smoke-ws-route-frame-cap', systemOptions);

  let binding;
  try {
    const server = system.spawn(Echo, 'echo');
    const routeOptions = WebsocketRouteOptions.create().withMaxFrameBytes(ROUTE_FRAME_CAP_BYTES);
    try {
      binding = await system.extension(HttpExtensionId)
        .newServerAt('127.0.0.1', await freePort())
        .useBackend(new HonoBackend())
        .bind(websocket('/ws', server, routeOptions));
    } catch (e) {
      console.log(`  (skipped: the Hono websocket bridge is unavailable on this runtime — ${e.message})`);
      return;
    }

    const outcome = await sendOversizeFrame(`ws://127.0.0.1:${binding.port}/ws`);
    if (outcome.kind !== 'message') {
      throw new Error(
        `a ${PROBE_BYTES}-byte frame on a ${ROUTE_FRAME_CAP_BYTES}-byte route was refused `
        + `(${outcome.kind}${outcome.code === undefined ? '' : ` ${outcome.code}`}) — `
        + 'the transport is capped at something other than the route\'s own limit',
      );
    }
    if (accepted.length !== 1 || accepted[0] !== PROBE_BYTES) {
      throw new Error(`the actor decoded ${JSON.stringify(accepted)} instead of [${PROBE_BYTES}]`);
    }
  } finally {
    if (binding) await binding.unbind();
    await system.terminate();
  }
}

/**
 * A port that is free right now, so the server can be asked for a concrete one.
 *
 * `newServerAt(host, 0)` is not usable here: on Deno the Hono runner reports
 * the port it was *asked* for rather than the one it bound (`Deno.serve`
 * exposes the real one as `server.addr.port` and the runner drops it), so
 * `binding.port` comes back as 0 and nothing can connect.  Every runner does
 * echo back a port it was given, so asking for a concrete one works
 * everywhere.  Probed through `node:net`, which all three runtimes implement.
 */
async function freePort() {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    return probe.address().port;
  } finally {
    await new Promise((resolve) => probe.close(resolve));
  }
}

/**
 * Open a socket, send one oversize frame, and report what came back first.
 *
 * Every outcome — reply, close, error, timeout — settles through the same
 * `finish`, which closes the socket before resolving.  A socket left in
 * CONNECTING or OPEN keeps Deno's event loop alive and the smoke run then
 * hangs after its last green line instead of exiting (#1196).
 */
function sendOversizeFrame(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closing, or never opened */ }
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    socket.onopen = () => socket.send(JSON.stringify({ kind: 'echo', text: 'x'.repeat(PROBE_BYTES) }));
    socket.onmessage = () => finish({ kind: 'message' });
    socket.onclose = (e) => finish({ kind: 'close', code: e.code });
    socket.onerror = () => finish({ kind: 'error' });
  });
}
