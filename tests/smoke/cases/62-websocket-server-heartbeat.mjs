/**
 * Smoke case: the server-side WebSocket heartbeat reaps a peer that went
 * quiet without a close frame, and keeps a live one, on the runtime the user
 * actually runs (#651).
 *
 * Runtime-sensitive because the ping and its pong travel through each
 * runtime's own socket, and each reports the pong differently:
 *
 *   - **Bun** (Hono) — `ServerWebSocket.ping()`, with the pong reported only
 *     to `Bun.serve`'s `websocket.pong` handler, which the Hono runner wires.
 *   - **Node** (Hono) — `@hono/node-ws` hands over a `ws` `WebSocket`, whose
 *     `ping()` and `'pong'` event the backend uses directly.
 *   - **Deno** (Hono) — a standard `WebSocket`, which has no ping at all: the
 *     route warns that it runs without the heartbeat, and the peer is left to
 *     Deno's own `idleTimeout`.
 *   - **the default backend** (Fastify, through `ws`) wherever it binds.
 *
 * The silent peer is raw TCP through `node:net`, which all three runtimes
 * implement: it completes the upgrade and then answers nothing.  The live
 * client is the runtime's own `WebSocket`, which answers pings by itself.
 * Every socket and timer is released on every path, and every server unbound
 * in `finally`, so no outcome leaves a handle open (#1196).
 */
import { randomBytes } from 'node:crypto';
import net from 'node:net';

export const name = 'websocket server heartbeat';
export const description = 'a route\'s heartbeat drops a peer that answers no ping and keeps one that does, on Bun, Node and Deno';

const HEARTBEAT_MS = 200;
const REAPED_WITHIN_MS = 4_000;
const LIVE_FOR_MS = 6 * HEARTBEAT_MS;

/** A logger that keeps the warnings, for the one outcome only a warning shows. */
function recordingLogger(LogLevel) {
  const warnings = [];
  const logger = {
    level: LogLevel.Warn,
    warnings,
    debug() {},
    info() {},
    warn(message) { warnings.push(String(message)); },
    error() {},
    withSource() { return logger; },
    withFields() { return logger; },
  };
  return logger;
}

export async function run({ runtime, actorTs, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel } = actorTs;
  const http = await loadEntry('http');

  let honoLoadable = true;
  try {
    await import('hono');
  } catch {
    honoLoadable = false;
  }

  const backends = [{ label: 'default', make: () => null }];
  if (honoLoadable) backends.push({ label: 'hono', make: () => new http.HonoBackend() });

  let exercised = 0;
  for (const backend of backends) {
    if (await exercise(runtime, ActorSystem, ActorSystemOptions, LogLevel, http, backend)) exercised += 1;
  }
  if (exercised === 0) console.log('  (skipped: no backend could bind a websocket route on this runtime)');
}

async function exercise(runtime, ActorSystem, ActorSystemOptions, LogLevel, http, backend) {
  const { HttpExtensionId, WebsocketServerActor, WebsocketRouteOptions, websocket } = http;
  const disconnects = [];
  let connects = 0;
  class Hub extends WebsocketServerActor {
    onMessage(message) { this.reply({ kind: 'pong', n: message.n }); }
    onClientConnected() { connects += 1; }
    onClientDisconnected(_client, info) { disconnects.push(info); }
  }

  const logger = recordingLogger(LogLevel);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Warn);
  const system = ActorSystem.create(`smoke-ws-heartbeat-${backend.label}`, systemOptions);
  let binding;
  let peer;
  try {
    const hub = system.spawn(Hub, 'hub');
    const routeOptions = WebsocketRouteOptions.create()
      .withHeartbeatIntervalMs(HEARTBEAT_MS)
      .withMaxConnections(1);
    try {
      let builder = system.extension(HttpExtensionId).newServerAt('127.0.0.1', await freePort());
      const made = backend.make();
      if (made !== null) builder = builder.useBackend(made);
      binding = await builder.bind(websocket('/ws', hub, routeOptions));
    } catch (e) {
      console.log(`  (${backend.label}: skipped — cannot bind a websocket route on ${runtime}: ${e.message})`);
      return false;
    }

    peer = await silentPeer(binding.port);
    await until(() => connects === 1, 3_000, `${backend.label}: the silent peer was never connected`);

    if (runtime === 'deno' && backend.label === 'hono') {
      // Deno's WebSocket cannot ping, so the route says it runs without one.
      await until(
        () => logger.warnings.some((w) => w.includes('heartbeat-interval')),
        3_000,
        'hono on deno: no warning that the heartbeat cannot run on this transport',
      );
      return true;
    }

    await until(() => disconnects.length === 1, REAPED_WITHIN_MS, `${backend.label} on ${runtime}: the silent peer was not dropped`);
    const info = disconnects[0];
    if (info.code !== 1001 || info.reason !== 'heartbeat timeout' || info.initiatedBy !== 'server') {
      throw new Error(`${backend.label} on ${runtime}: the hub heard ${JSON.stringify(info)}, not 1001 'heartbeat timeout' from the server`);
    }
    await until(() => peer.closed, 3_000, `${backend.label} on ${runtime}: the silent peer's socket was never closed`);

    // The route's one slot is back, and a client that answers pings keeps it.
    const reply = await liveClient(binding.port);
    if (reply !== 7) throw new Error(`${backend.label} on ${runtime}: the live client got ${JSON.stringify(reply)} instead of its pong`);
    if (disconnects.length !== 2 || disconnects[1].initiatedBy !== 'client') {
      throw new Error(`${backend.label} on ${runtime}: the live client was dropped by the heartbeat: ${JSON.stringify(disconnects)}`);
    }
    return true;
  } finally {
    peer?.destroy();
    if (binding) await binding.unbind();
    await system.terminate();
  }
}

/** Poll `condition` until it holds or `ms` passes; the timer is cleared on both paths. */
async function until(condition, ms, failure) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(failure);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Give the hub a beat to finish the turn that made the condition true.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** Raw TCP: complete the upgrade, then answer nothing.  `destroy()` is safe on every path. */
function silentPeer(port) {
  const key = randomBytes(16).toString('base64');
  const request = `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\n`
    + `Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`;
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const peer = { closed: false, destroy: () => socket.destroy() };
    let upgraded = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout awaiting the upgrade'));
    }, 3_000);
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk) => {
      if (upgraded) return;
      clearTimeout(timer);
      const status = chunk.toString('latin1').split('\r\n')[0];
      if (!status.startsWith('HTTP/1.1 101')) {
        socket.destroy();
        reject(new Error(`upgrade refused: ${status}`));
        return;
      }
      upgraded = true;
      resolve(peer);
    });
    socket.on('error', () => { /* seen as the close that follows */ });
    socket.on('close', () => {
      clearTimeout(timer);
      peer.closed = true;
      if (!upgraded) reject(new Error('socket closed before the upgrade'));
    });
  });
}

/**
 * The runtime's own `WebSocket`, which answers pings by itself: hold the
 * connection for several intervals with nothing but pongs on the wire, then
 * ask once and close.  Settles through `finish` on every path.
 */
function liveClient(port) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let holdTimer = null;
    const finish = (settle) => {
      clearTimeout(deadline);
      if (holdTimer !== null) clearTimeout(holdTimer);
      try { client.close(); } catch { /* already closing */ }
      settle();
    };
    const deadline = setTimeout(() => finish(() => reject(new Error('the live client got no answer in time'))), LIVE_FOR_MS + 4_000);
    client.onopen = () => {
      holdTimer = setTimeout(() => {
        holdTimer = null;
        client.send(JSON.stringify({ kind: 'ping', n: 7 }));
      }, LIVE_FOR_MS);
    };
    client.onmessage = (event) => {
      const n = JSON.parse(String(event.data)).n;
      finish(() => resolve(n));
    };
    client.onclose = (event) => finish(() => reject(new Error(`the live client was closed (${event.code}) before its answer`)));
    client.onerror = () => { /* seen as the close that follows */ };
  }).then(async (n) => {
    // The client's close reaches the hub a moment later.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return n;
  });
}

/** A port free right now — see `25-websocket-route-frame-cap.mjs` for why not 0. */
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
