import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  enforceMaxConnections,
  type ConnectionCapReport,
} from '../../../src/http/backend/HttpServerBackend.js';

/**
 * #1505 — the connection cap against a **real** `node:http` server.
 *
 * The counting itself is already covered, and well: five cases in
 * `ServerTuningParity.test.ts` drive `applyServerOptions` against a fake server
 * that ignores `maxConnections`, and they pin the boundary, the slot released
 * on close, the two ways of spelling "no cap", and a handle that cannot host
 * the guard at all.  Nothing here repeats them — a fake is the right tool for
 * the arithmetic, because it cannot be right for the wrong reason.
 *
 * What a fake cannot show is the one thing that made three tests red on Linux
 * and green on Windows for weeks: **whether the runtime hands the guard a
 * connection to count**.  `enforceMaxConnections` subscribes to `'connection'`,
 * and that event is not the same event on every platform.  Measured on bun
 * 1.4.0, an `http.Server`:
 *
 * | | Windows / node | Linux |
 * | --- | --- | --- |
 * | client connects, sends nothing | `'connection'` fires, `getConnections` 1 | **nothing**, `getConnections` 0 |
 * | client sends a request | fires | fires |
 * | `server.maxConnections` honoured | yes, socket closed | **no** |
 *
 * So on Linux an accepted-but-silent socket is invisible to the server object,
 * and neither enforcement can act on it: the property is ignored, and the guard
 * is never told.  The three suites that were red opened silent sockets, which
 * is why they were red — they asked the Linux server about a connection it did
 * not have.
 *
 * Every connection below therefore **speaks**, and the property is deliberately
 * left unset so the only thing that can hold the cap is the code in this
 * repository.  Both halves matter: that is the Linux condition on any machine,
 * and it is also the connection a cap is actually about.
 *
 * The gap this leaves is real and belongs in the record rather than in a
 * comment nobody reads: on a runtime that defers `'connection'`, a client that
 * connects and stays silent is bounded by nothing actor-ts can see.
 * `docs/…/http/security.mdx` says so.
 */

const sockets: Socket[] = [];
const servers: Server[] = [];

afterEach(async () => {
  while (sockets.length) sockets.shift()!.destroy();
  while (servers.length) {
    const server = servers.shift()!;
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
});

/**
 * A listening server whose cap is held only by {@link enforceMaxConnections}.
 *
 * `maxConnections` is never assigned — that is the point. Setting it would
 * hand the job to the runtime, and this file would be measuring the runtime.
 */
async function guardedServer(
  cap: number,
): Promise<{ port: number; report: () => ConnectionCapReport }> {
  const server = createServer((_request, response) => response.end('ok'));
  servers.push(server);
  const report = enforceMaxConnections(server, cap);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { port: address.port, report };
}

/** What became of one connection that connected and sent a request. */
type Attempt = { readonly socket: Socket; readonly closed: boolean; readonly served: boolean };

/** Long enough to see a close made on accept, short enough to fail fast. */
const VERDICT_MS = 1_000;

/**
 * Connect, send a request, and report whether the server served it or hung up.
 *
 * A refused connection reaches the client as `ECONNRESET` rather than a clean
 * FIN, so the `'error'` listener is part of observing the close and not an
 * accident — without it the rejection is an unhandled error that fails the run
 * somewhere else entirely.
 */
function speak(port: number): Promise<Attempt> {
  return new Promise((resolve) => {
    let body = '';
    let settled = false;
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    });
    sockets.push(socket);
    const settle = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ socket, closed, served: body.length > 0 });
    };
    socket.on('data', (chunk) => { body += chunk.toString('utf8'); });
    socket.on('error', () => settle(true));
    socket.once('close', () => settle(true));
    const timer = setTimeout(() => settle(false), VERDICT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
}

describe('the cap holds on a real server, with no help from the runtime', () => {
  test('a connection past the cap is refused and the one under it is served', async () => {
    const { port, report } = await guardedServer(1);
    expect(report().installed).toBe(true);

    const first = await speak(port);
    expect(first.served, 'the connection under the cap was not served').toBe(true);
    expect(first.closed).toBe(false);

    const second = await speak(port);
    expect(second.closed, 'the connection past the cap was not refused').toBe(true);
    expect(second.served).toBe(false);

    // The counters say which half happened, which is what the report is for:
    // a cap that never saw the connection and a cap that saw and refused it
    // fail a boolean assertion identically.
    expect(report()).toMatchObject({ installed: true, seen: 2, refused: 1, held: 1 });
  });

  test('the boundary is the cap itself, not one past it', async () => {
    const { port } = await guardedServer(2);

    const first = await speak(port);
    const second = await speak(port);
    const third = await speak(port);

    expect(first.closed).toBe(false);
    expect(second.closed).toBe(false);
    expect(third.closed, 'the third connection through a cap of two was admitted').toBe(true);
  }, 15_000);

  test('a slot freed by a close is reused, against a server that really closes', async () => {
    // The fake-server sibling of this asserts the bookkeeping; this asserts
    // that a *real* socket's close reaches the listener the bookkeeping hangs
    // on, which is a different claim and the one a runtime can break.
    const { port } = await guardedServer(1);

    const first = await speak(port);
    expect(first.closed).toBe(false);
    first.socket.destroy();
    // The server learns of the close on its own socket, not on ours.
    await new Promise((resolve) => { setTimeout(resolve, 150); });

    const second = await speak(port);
    expect(second.closed, 'the slot freed by a close was not reused').toBe(false);
    expect(second.served).toBe(true);
  }, 15_000);

  test('a cap of zero refuses everything rather than meaning unlimited', async () => {
    // `0` reaches the guard only from an explicit setting — `applyServerOptions`
    // spells unlimited as `Infinity` and declines to write it — so the honest
    // reading of an explicit zero is zero.
    const { port } = await guardedServer(0);
    expect((await speak(port)).closed).toBe(true);
  });
});

describe('a connection the guard cannot account for degrades towards refusing', () => {
  test('a socket that cannot report its close still fills the cap', () => {
    // **This case asserted the opposite until `d57f0aee`, and that commit is
    // right.**  The guard used to decrement on the spot when `once` was
    // missing, so `held` never grew and the cap never fired at all — open,
    // silently, while reporting itself installed (#1409).  Counting anyway
    // turns the bound into a lifetime budget rather than a concurrency one,
    // which is stricter than asked for; a security control that degrades has
    // to degrade towards refusing.
    const listeners: Array<(socket: unknown) => void> = [];
    const server = {
      on: (event: string, listener: (socket: unknown) => void) => {
        if (event === 'connection') listeners.push(listener);
      },
    } as unknown as Parameters<typeof enforceMaxConnections>[0];

    const report = enforceMaxConnections(server, 1);
    expect(report().installed).toBe(true);

    let destroyed = 0;
    const uncloseable = { destroy: () => { destroyed++; } };
    // Three connections through a cap of one.  The first fills it; the next
    // two are refused, because none of them can ever give the slot back.
    for (let index = 0; index < 3; index++) for (const listener of listeners) listener(uncloseable);
    expect(destroyed).toBe(2);
    expect(report()).toMatchObject({ seen: 3, refused: 2, held: 1 });
  });
});
