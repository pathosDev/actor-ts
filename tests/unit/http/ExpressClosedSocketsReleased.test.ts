/**
 * #997 — the Express backend keeps the sockets it may have to force at
 * `unbind()` in a set, and lets each one go when it closes.
 *
 * `unbind(0)` destroys the sockets itself, because `closeAllConnections()` on
 * bun 1.4.2 left a connection with a request in flight open.  The set that
 * makes that possible must not outlive the connections in it: kept until
 * unbind, a long-lived server retained every socket it ever accepted.  The
 * set is private to the listen closure, so what this observes is the effect —
 * closed sockets become collectable, which a set still holding them forbids.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const CONNECTIONS = 20;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** One TCP connection that the client opens and closes again at once. */
function openAndClose(port: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const client = connect({ host: '127.0.0.1', port });
    client.on('connect', () => { client.end(); });
    client.on('close', () => { resolve(); });
    client.on('error', () => { /* observed as the 'close' that follows */ });
  });
}

describe('ExpressBackend — its forced-close set', () => {
  test('drops a socket once it closed, so the server does not retain every connection it accepted', async () => {
    const backend = new ExpressBackend();
    const binding = await backend.listen('127.0.0.1', 0);
    cleanups.push(() => binding.unbind(0));
    const server = (backend as unknown as { server: { on: (event: 'connection', listener: (socket: object) => void) => void } }).server;
    const accepted: WeakRef<object>[] = [];
    server.on('connection', (socket) => { accepted.push(new WeakRef(socket)); });
    for (let i = 0; i < CONNECTIONS; i++) await openAndClose(binding.port);

    const released = (): number => accepted.filter((socket) => socket.deref() === undefined).length;
    // Collection is the runtime's to schedule: forced on every poll, and half
    // the sockets is the bar, not all — a set that kept them releases none.
    await awaitCondition(() => { Bun.gc(true); return released() >= CONNECTIONS / 2; }, {
      timeoutMs: 3_000,
      label: 'the closed sockets were collected',
    });
    expect(accepted).toHaveLength(CONNECTIONS);
  });
});
