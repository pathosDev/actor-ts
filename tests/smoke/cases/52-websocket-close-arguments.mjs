/**
 * Smoke case: a WebSocket close that asks for more than a close frame carries
 * still closes the socket and gives its connection slot back, on the
 * runtime's real transports (#1431).
 *
 * A close frame carries a code from a fixed set and at most 123 bytes of
 * reason.  Handed anything else, the `ws` package — Fastify's transport, and
 * Hono's on Node — throws from `close()` after it has already moved the
 * socket to CLOSING, and Deno's socket — Hono's on Deno — throws on a long
 * reason before it closes anything.  Either way the socket stayed open, kept
 * its `maxConnections` slot and could keep sending, while the hub had already
 * been told the client left.  `bun test` never runs either transport: Bun
 * answers `import 'ws'` with a module of its own, and on 1.4.2, the release
 * `.bun-version` pins, that module's `close()` never throws.  So the real ones
 * are reached here, where CI runs them on Node and Deno.
 *
 * Per backend the hub is asked for four closes a close frame cannot carry as
 * given — `abort()` and `close()`, each once with the reserved code 1006 and
 * once with a 200-byte reason — each on a fresh route capped at one
 * connection.  The client must see the close within the budget, carrying
 * what a close frame can: a dropped connection for an abort the backend
 * hard-closes, otherwise the method's own default in place of 1006 and the
 * reason cut to 61 two-byte characters.  A second client must then get in and
 * be answered, which it can only once the first socket has really closed.
 *
 * Fastify hard-closes an abort, and so does Hono under Bun and Node, whose
 * sockets have a `terminate()` Hono's adapter hands on; Hono under Deno,
 * whose standard `WebSocket` has none, sends the close frame instead.  So
 * between them they cover both ways an abort reaches the socket, the second
 * on Deno.  A backend that cannot bind a websocket route on this runtime is
 * skipped with a line saying so; once one binds, every check MUST hold.
 * Every client is closed, every timer cleared, every binding unbound and
 * every system terminated on every path — a socket left open keeps Deno's
 * event loop alive past the last line (#1196).
 */
export const name = 'websocket close arguments';
export const description = 'abort() and close() with a reserved code or a 200-byte reason close the socket and give its maxConnections slot back, on Fastify and on Hono';

/** Per wait: a loopback close lands in milliseconds, so this is headroom for a loaded CI runner. */
const CLIENT_BUDGET_MS = 3_000;
/** 100 two-byte characters: 200 bytes, and byte 123 falls inside one of them. */
const LONG_REASON = 'é'.repeat(100);
/** The longest prefix of LONG_REASON a close frame carries. */
const LONG_REASON_AS_SENT = 'é'.repeat(61);

const REQUESTS = [
  { kind: 'abort', code: 1006, reason: 'rate limited' },
  { kind: 'abort', code: 1008, reason: LONG_REASON },
  { kind: 'close', code: 1006, reason: 'bye' },
  { kind: 'close', code: 4000, reason: LONG_REASON },
];

/**
 * The code a client reads for a connection that ended without a close frame.
 * 1006 on Node's and Bun's clients; Deno's reports 0 instead (measured on deno
 * 2.6.8, for a socket the server destroyed).
 */
function droppedCode(runtime) {
  return runtime === 'deno' ? 0 : 1006;
}

/** What the client must read: `null` reason means "any" — a hard close sends no close frame. */
function expectedClose(request, terminates, runtime) {
  if (request.kind === 'abort' && terminates) return { code: droppedCode(runtime), reason: null };
  const code = request.code === 1006 ? (request.kind === 'abort' ? 1008 : 1000) : request.code;
  const reason = request.reason === LONG_REASON ? LONG_REASON_AS_SENT : request.reason;
  return { code, reason };
}

function describeRequest(request) {
  const reason = request.reason === LONG_REASON ? '<200 bytes>' : `'${request.reason}'`;
  return `${request.kind}(${request.code}, ${reason})`;
}

/** Resolves once the handshake completes; rejects if it does not. */
function openClient(url, clients) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    clients.push(client);
    const timer = setTimeout(() => reject(new Error(`no handshake within ${CLIENT_BUDGET_MS} ms`)), CLIENT_BUDGET_MS);
    client.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.addEventListener('close', (event) => {
      clearTimeout(timer);
      reject(new Error(`closed during the handshake with ${event.code}`));
    });
  });
}

/** What the first client read when the server closed it. */
async function closeSeenAfter(url, request, clients) {
  const client = await openClient(url, clients);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the client was still connected ${CLIENT_BUDGET_MS} ms after ${describeRequest(request)} (readyState ${client.readyState})`));
    }, CLIENT_BUDGET_MS);
    client.addEventListener('close', (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason });
    });
    client.send(JSON.stringify(request));
  });
}

/** The route takes one connection, so this client gets in only once the first one's slot is back. */
async function expectAnswered(url, request, clients) {
  const client = await openClient(url, clients);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`a second client was not answered within ${CLIENT_BUDGET_MS} ms after ${describeRequest(request)}`));
    }, CLIENT_BUDGET_MS);
    client.addEventListener('message', () => {
      clearTimeout(timer);
      resolve();
    });
    client.addEventListener('close', (event) => {
      clearTimeout(timer);
      reject(new Error(`a second client was closed with ${event.code} '${event.reason}' after ${describeRequest(request)} — the first one still held the route's only slot`));
    });
    client.send(JSON.stringify({ kind: 'ping', n: 2 }));
  });
}

export async function run({ actorTs, runtime, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { FastifyBackend, HonoBackend, HttpExtensionId, WebsocketRouteOptions, WebsocketServerActor, websocket } = await loadEntry('http');

  if (typeof globalThis.WebSocket !== 'function') {
    console.log(`  (skipped: no WebSocket client on ${runtime})`);
    return;
  }

  class ClosingHub extends WebsocketServerActor {
    onMessage(message) {
      if (message.kind === 'abort') this.onAbort(message);
      else if (message.kind === 'close') this.onClose(message);
      else this.onPing(message);
    }

    onAbort(message) {
      this.connection.abort(message.code, message.reason);
    }

    onClose(message) {
      this.connection.close(message.code, message.reason);
    }

    onPing(message) {
      this.reply({ kind: 'pong', n: message.n });
    }
  }

  const backends = [
    { name: 'fastify', create: () => new FastifyBackend(), terminates: true, needs: null },
    // Hono's adapter hard-closes where the runtime's socket can: Bun's and
    // Node's can, Deno's standard WebSocket cannot (13309751d).
    { name: 'hono', create: () => new HonoBackend(), terminates: runtime !== 'deno', needs: 'hono' },
  ];
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const checked = [];
  // Every request runs on a system and a route of its own, so one that fails
  // does not disturb the next — and a red run names every combination at once.
  const failures = [];

  for (const backend of backends) {
    if (backend.needs !== null) {
      try {
        await import(backend.needs);
      } catch (e) {
        console.log(`  (skipped ${backend.name}: ${backend.needs} not loadable on ${runtime} — ${e.message})`);
        continue;
      }
    }
    for (const [index, request] of REQUESTS.entries()) {
      const system = ActorSystem.create(`smoke-ws-close-arguments-${backend.name}-${index}`, systemOptions);
      const clients = [];
      let binding;
      let bound = false;
      try {
        const hub = system.spawn(ClosingHub, 'hub');
        const routeOptions = WebsocketRouteOptions.create().withMaxConnections(1);
        try {
          binding = await system.extension(HttpExtensionId)
            .newServerAt('127.0.0.1', 0)
            .useBackend(backend.create())
            .bind(websocket('/ws', hub, routeOptions));
          bound = true;
        } catch (e) {
          console.log(`  (skipped ${backend.name}: could not bind a websocket route on ${runtime} — ${e.message})`);
        }
        if (bound) {
          const url = `ws://127.0.0.1:${binding.port}/ws`;
          try {
            const seen = await closeSeenAfter(url, request, clients);
            const expected = expectedClose(request, backend.terminates, runtime);
            if (seen.code !== expected.code || (expected.reason !== null && seen.reason !== expected.reason)) {
              throw new Error(`the client read ${seen.code} '${seen.reason}', expected ${expected.code}${expected.reason === null ? '' : ` '${expected.reason}'`}`);
            }
            await expectAnswered(url, request, clients);
            checked.push(`${backend.name} ${describeRequest(request)}`);
          } catch (e) {
            failures.push(`${backend.name} ${describeRequest(request)}: ${e.message}`);
          }
        }
      } finally {
        for (const client of clients) {
          try { client.close(); } catch { /* already closed */ }
        }
        if (binding) await binding.unbind().catch(() => {});
        await system.terminate();
      }
      if (!bound) break;
    }
  }
  console.log(`  checked ${checked.length}: ${checked.join(', ')}`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} on ${runtime} — ${failures.join('; ')}`);
  }
}
