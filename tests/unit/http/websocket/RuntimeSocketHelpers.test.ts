/**
 * The two helpers through which a backend adapter reaches the runtime's own
 * socket for the server heartbeat (#651): `runtimeSocketPingOf` hands on its
 * `ping()`, `subscribeRuntimeSocketPong` hears its pongs.
 *
 * Hono hands each runtime's socket over as `WSContext.raw`, and only
 * `@hono/node-ws`'s `ws` `WebSocket` reports a pong as an event, so under
 * `bun test` (Hono on Bun) no backend reaches the subscription with a socket
 * that has an `on` method.  These cases hold the helpers to a stand-in of that
 * socket; `HonoOnNodePong.test.ts` drives the backend path through the Node
 * runner, and smoke case `62-websocket-server-heartbeat.mjs` the real one on
 * Node.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import { runtimeSocketPingOf, subscribeRuntimeSocketPong } from '../../../../src/http/websocket/SocketAdapter.js';

/** A stand-in for `ws`'s `WebSocket`: an emitter with a `ping()` that counts. */
class EmittingSocket extends EventEmitter {
  pings = 0;
  ping(): void {
    this.pings += 1;
  }
}

describe('subscribeRuntimeSocketPong', () => {
  test('registers a pong listener on a socket that reports pongs as events, and the callback runs on each', () => {
    const socket = new EmittingSocket();
    let pongs = 0;
    subscribeRuntimeSocketPong(socket, () => { pongs += 1; });

    expect(socket.listenerCount('pong')).toBe(1);
    socket.emit('pong');
    socket.emit('pong');
    expect(pongs).toBe(2);
  });

  test('leaves a socket without an `on` method, and anything that is not an object, alone', () => {
    const onPong = (): void => { throw new Error('nothing should subscribe'); };
    expect(() => subscribeRuntimeSocketPong({ ping: () => {} }, onPong)).not.toThrow();
    expect(() => subscribeRuntimeSocketPong('a socket', onPong)).not.toThrow();
    expect(() => subscribeRuntimeSocketPong(undefined, onPong)).not.toThrow();
  });

  test('tolerates null, the one non-socket a property access would throw on', () => {
    expect(() => subscribeRuntimeSocketPong(null, () => {})).not.toThrow();
  });
});

describe('runtimeSocketPingOf', () => {
  test('hands on the socket\'s own ping(), bound to it', () => {
    const socket = new EmittingSocket();
    const ping = runtimeSocketPingOf(socket);
    expect(ping).toBeDefined();
    ping!();
    expect(socket.pings).toBe(1);
  });

  test('is undefined for a socket without ping(), and for anything that is not an object', () => {
    expect(runtimeSocketPingOf({ send: () => {} })).toBeUndefined();
    expect(runtimeSocketPingOf('a socket')).toBeUndefined();
    expect(runtimeSocketPingOf(undefined)).toBeUndefined();
  });

  test('tolerates null, the one non-socket a property access would throw on', () => {
    expect(runtimeSocketPingOf(null)).toBeUndefined();
  });
});
