/**
 * #1756 — the HTTP/1.1 bounds on Bun's HTTP/2 listener, timer by timer.
 *
 * `Http1OnHttp2Listener.test.ts` holds the bounds end to end over TLS, always
 * with both set to positive values.  What it cannot show on demand is the
 * bookkeeping between them: that `0` arms nothing, that one bound set keeps
 * the other, that a second request in flight holds the connection open, that a
 * new request disarms the idle timer and the last one re-arms it, and that a
 * request's receive timer goes with it — so no late `408` lands on a reused
 * connection.  Here a stand-in server, socket and response carry the events,
 * and the timers run on a virtual clock the test advances itself.
 */
import { describe, expect, test } from 'bun:test';
import { enforceHttp1BoundsOnHttp2Listener, type NodeHttpServerLike } from '../../../src/http/backend/HttpServerBackend.js';
import type { HostTimers } from '../../../src/Scheduler.js';

const IDLE_TIMEOUT_MS = 800;
const REQUEST_TIMEOUT_MS = 1_500;
/** Far past every bound the tests set: a timer that was armed has fired by then. */
const LONG_AFTER_MS = 60_000;

/** Host timers on a clock that moves only when the test advances it. */
function virtualHostTimers() {
  let now = 0;
  let nextHandle = 0;
  const pending = new Map<number, { dueAtMs: number; callback: () => void }>();
  const hostTimers: HostTimers = {
    setTimeout: (callback, milliseconds) => {
      nextHandle++;
      const delayMs = milliseconds !== undefined && Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
      pending.set(nextHandle, { dueAtMs: now + delayMs, callback });
      return nextHandle;
    },
    clearTimeout: (handle) => { pending.delete(handle as number); },
    setInterval: () => { throw new Error('the HTTP/1.1 bounds arm no interval'); },
    clearInterval: () => { /* nothing to clear */ },
  };
  return {
    hostTimers,
    advance: (milliseconds: number): void => {
      const until = now + milliseconds;
      for (;;) {
        let next: [number, { dueAtMs: number; callback: () => void }] | undefined;
        for (const entry of pending) if (entry[1].dueAtMs <= until && (next === undefined || entry[1].dueAtMs < next[1].dueAtMs)) next = entry;
        if (next === undefined) break;
        pending.delete(next[0]);
        now = next[1].dueAtMs;
        next[1].callback();
      }
      now = until;
    },
  };
}

type FakeSocket = {
  readonly alpnProtocol: string;
  destroyed: boolean;
  readonly written: string[];
  destroy: () => void;
  end: (data?: string) => void;
  once: (event: 'close', listener: () => void) => FakeSocket;
};

/** One request on a connection, answered or abandoned by the test. */
type FakeExchange = {
  /** The body arrived in full. */
  receive: () => void;
  /** The handler wrote its headers. */
  startResponse: () => void;
  /** The response finished; the runtime then emits `'finish'` and `'close'`, as `ServerResponse` does. */
  finish: () => void;
};

/** A stand-in for Bun's HTTP/2 listener under the bounds, with a virtual clock. */
function listener(idleTimeoutMs: number | undefined, requestTimeoutMs: number | undefined) {
  const handlers = new Map<string, Array<(...eventArguments: ReadonlyArray<unknown>) => void>>();
  const server = {
    on: ((event: string, handler: (...eventArguments: ReadonlyArray<unknown>) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return server;
    }) as NodeHttpServerLike['on'],
  } as NodeHttpServerLike;
  const clock = virtualHostTimers();
  enforceHttp1BoundsOnHttp2Listener(server, idleTimeoutMs, requestTimeoutMs, clock.hostTimers);
  const emit = (event: string, ...eventArguments: ReadonlyArray<unknown>): void => {
    for (const handler of handlers.get(event) ?? []) handler(...eventArguments);
  };
  return {
    advance: clock.advance,
    /** A TLS connection that negotiated HTTP/1.1. */
    connect: () => {
      const closeListeners: Array<() => void> = [];
      const socket: FakeSocket = {
        alpnProtocol: 'http/1.1',
        destroyed: false,
        written: [],
        destroy: () => {
          if (socket.destroyed) return;
          socket.destroyed = true;
          for (const closeListener of closeListeners) closeListener();
        },
        end: (data) => { if (data !== undefined) socket.written.push(data); },
        once: (_event, closeListener) => { closeListeners.push(closeListener); return socket; },
      };
      emit('secureConnection', socket);
      return {
        socket,
        /** A request arriving on this connection, its body still to come unless `complete`. */
        request: (complete: boolean): FakeExchange => {
          const request = { socket, complete };
          const responseListeners = new Map<string, Array<() => void>>();
          const response = {
            headersSent: false,
            once: (event: string, responseListener: () => void) => {
              responseListeners.set(event, [...(responseListeners.get(event) ?? []), responseListener]);
              return response;
            },
          };
          emit('request', request, response);
          const fire = (event: string): void => {
            const due = responseListeners.get(event) ?? [];
            responseListeners.delete(event);
            for (const responseListener of due) responseListener();
          };
          return {
            receive: () => { request.complete = true; },
            startResponse: () => { response.headersSent = true; },
            finish: () => {
              response.headersSent = true;
              fire('finish');
              fire('close');
            },
          };
        },
      };
    },
  };
}

describe('a bound set to 0 arms nothing', () => {
  test('idle-timeout = 0 leaves a keep-alive connection open after its response', () => {
    const server = listener(0, REQUEST_TIMEOUT_MS);
    const connection = server.connect();
    connection.request(true).finish();
    server.advance(LONG_AFTER_MS);
    expect(connection.socket.destroyed).toBe(false);
  });

  test('request-timeout = 0 answers no stalled body with 408', () => {
    const server = listener(IDLE_TIMEOUT_MS, 0);
    const connection = server.connect();
    connection.request(false);
    server.advance(LONG_AFTER_MS);
    expect(connection.socket.written).toEqual([]);
    expect(connection.socket.destroyed).toBe(false);
  });
});

describe('one bound set keeps the other', () => {
  test('only idle-timeout: a slow body is not cut, and the idle bound still fires', () => {
    const server = listener(IDLE_TIMEOUT_MS, undefined);
    const connection = server.connect();
    const exchange = connection.request(false);
    server.advance(LONG_AFTER_MS);
    expect(connection.socket.written).toEqual([]);
    expect(connection.socket.destroyed).toBe(false);
    exchange.receive();
    exchange.finish();
    server.advance(IDLE_TIMEOUT_MS - 1);
    expect(connection.socket.destroyed).toBe(false);
    server.advance(1);
    expect(connection.socket.destroyed).toBe(true);
  });

  test('only request-timeout: a stalled body is answered 408 at the deadline', () => {
    const server = listener(undefined, REQUEST_TIMEOUT_MS);
    const connection = server.connect();
    connection.request(false);
    server.advance(REQUEST_TIMEOUT_MS - 1);
    expect(connection.socket.destroyed).toBe(false);
    server.advance(1);
    expect(connection.socket.written.join('')).toContain('408');
    expect(connection.socket.destroyed).toBe(true);
  });

  test('only request-timeout: a connection is not destroyed after its response', () => {
    const server = listener(undefined, REQUEST_TIMEOUT_MS);
    const connection = server.connect();
    connection.request(true).finish();
    server.advance(LONG_AFTER_MS);
    expect(connection.socket.destroyed).toBe(false);
  });
});

describe('the idle bound counts the requests in flight', () => {
  test('a connection is not idled out while a second request is still in flight', () => {
    const server = listener(IDLE_TIMEOUT_MS, REQUEST_TIMEOUT_MS);
    const connection = server.connect();
    const first = connection.request(true);
    const second = connection.request(true);
    first.finish();
    server.advance(IDLE_TIMEOUT_MS * 5);
    expect(connection.socket.destroyed).toBe(false);
    second.finish();
    server.advance(IDLE_TIMEOUT_MS);
    expect(connection.socket.destroyed).toBe(true);
  });

  test('a new request disarms the idle timer, and the last response re-arms it', () => {
    const server = listener(IDLE_TIMEOUT_MS, REQUEST_TIMEOUT_MS);
    const connection = server.connect();
    connection.request(true).finish();
    server.advance(IDLE_TIMEOUT_MS / 2);
    const second = connection.request(true);
    // The handler outlasts what was left of the first idle window.
    server.advance(IDLE_TIMEOUT_MS);
    expect(connection.socket.destroyed).toBe(false);
    second.finish();
    server.advance(IDLE_TIMEOUT_MS - 1);
    expect(connection.socket.destroyed).toBe(false);
    server.advance(1);
    expect(connection.socket.destroyed).toBe(true);
  });

  test('a third request after two on one connection is still bounded', () => {
    const server = listener(IDLE_TIMEOUT_MS, REQUEST_TIMEOUT_MS);
    const connection = server.connect();
    for (let i = 0; i < 3; i++) {
      connection.request(true).finish();
      server.advance(IDLE_TIMEOUT_MS / 2);
      expect(connection.socket.destroyed).toBe(false);
    }
    server.advance(IDLE_TIMEOUT_MS / 2);
    expect(connection.socket.destroyed).toBe(true);
  });
});

describe('a request\'s receive timer goes with it', () => {
  test('a handler that answered before reading its body leaves no late 408 on the reused connection', () => {
    const server = listener(REQUEST_TIMEOUT_MS * 4, REQUEST_TIMEOUT_MS);
    const connection = server.connect();
    connection.request(false).finish();
    const second = connection.request(true);
    server.advance(REQUEST_TIMEOUT_MS * 2);
    expect(connection.socket.written).toEqual([]);
    expect(connection.socket.destroyed).toBe(false);
    second.finish();
  });

  test('a request whose response already started is still cut at request-timeout, without a 408', () => {
    const server = listener(IDLE_TIMEOUT_MS, REQUEST_TIMEOUT_MS);
    const connection = server.connect();
    connection.request(false).startResponse();
    server.advance(REQUEST_TIMEOUT_MS - 1);
    expect(connection.socket.destroyed).toBe(false);
    server.advance(1);
    expect(connection.socket.written).toEqual([]);
    expect(connection.socket.destroyed).toBe(true);
  });
});
