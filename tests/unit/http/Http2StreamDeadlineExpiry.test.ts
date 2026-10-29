import { describe, expect, test } from 'bun:test';
import { enforceStreamRequestTimeout, type NodeHttpServerLike } from '../../../src/http/backend/HttpServerBackend.js';
import type { HostTimers } from '../../../src/Scheduler.js';

/**
 * #870 — the HTTP/2 stream receive deadline at the moment it fires.
 *
 * `Http2StreamRequestTimeout.test.ts` proves the deadline against this runtime's
 * own HTTP/2 server; this file pins the decision it takes when it fires, for
 * the shapes a live server cannot be made to produce on demand.
 */
/**
 * What the deadline does when it fires, against stand-ins for a server-side
 * stream: the cases a live server cannot be made to produce on demand.  The
 * deadline runs on host timers the test fires itself, so "nothing happened"
 * is asserted after the deadline did fire, never after a guess at how long to
 * wait for it.
 */
describe('the deadline, at expiry', () => {
  const DEADLINE_MS = 30_000;

  type FakeStream = {
    endAfterHeaders: boolean;
    state: { remoteClose: number };
    headersSent: boolean;
    writableEnded: boolean;
    closed: boolean;
    destroyed: boolean;
    readonly responded: Array<Record<string, string | number>>;
    readonly closedWith: number[];
    respond: (headers: Record<string, string | number>, options?: { endStream?: boolean }) => void;
    close: (code?: number) => void;
    once: (event: 'close', listener: () => void) => FakeStream;
    /** What the server does when the stream ends some other way. */
    end: () => void;
  };

  function fakeStream(overrides: Partial<Pick<FakeStream, 'endAfterHeaders' | 'headersSent' | 'writableEnded'>> = {}): FakeStream {
    const closeListeners: Array<() => void> = [];
    const stream: FakeStream = {
      endAfterHeaders: false,
      state: { remoteClose: 0 },
      headersSent: false,
      writableEnded: false,
      closed: false,
      destroyed: false,
      ...overrides,
      responded: [],
      closedWith: [],
      respond: (headers) => { stream.responded.push(headers); stream.headersSent = true; stream.writableEnded = true; },
      close: (code) => { stream.closedWith.push(code ?? 0); stream.closed = true; },
      once: (_event, listener) => { closeListeners.push(listener); return stream; },
      end: () => { stream.closed = true; for (const listener of closeListeners) listener(); },
    };
    return stream;
  }

  /**
   * A server that hands each stream to its `'stream'` listeners, with the
   * guard installed over host timers the test fires: `fire()` runs every
   * deadline armed so far, and `armed` says how many are pending.
   */
  function guardedServer() {
    const listeners: Array<(...args: ReadonlyArray<unknown>) => void> = [];
    const server = {
      on: ((event: string, listener: (...args: ReadonlyArray<unknown>) => void) => {
        if (event === 'stream') listeners.push(listener);
        return server;
      }) as NodeHttpServerLike['on'],
    } as NodeHttpServerLike;
    const pending = new Map<number, () => void>();
    let nextHandle = 0;
    const hostTimers: HostTimers = {
      setTimeout: (callback) => { nextHandle++; pending.set(nextHandle, callback); return nextHandle; },
      clearTimeout: (handle) => { pending.delete(handle as number); },
      setInterval: () => { throw new Error('the stream deadline arms no interval'); },
      clearInterval: () => { /* nothing to clear */ },
    };
    enforceStreamRequestTimeout(server, DEADLINE_MS, hostTimers);
    return {
      open: (stream: FakeStream): void => { for (const listener of listeners) listener(stream, {}, 0); },
      fire: (): void => {
        const due = [...pending];
        pending.clear();
        for (const [, callback] of due) callback();
      },
      get armed(): number { return pending.size; },
    };
  }

  test('a request still arriving is answered 408, then reset without error', () => {
    const server = guardedServer();
    const stream = fakeStream();
    server.open(stream);
    expect(server.armed).toBe(1);
    server.fire();

    expect(stream.responded).toEqual([{ ':status': 408 }]);
    expect(stream.closedWith, 'a complete 408 asks the client to stop sending with NO_ERROR (RFC 9113 §8.1)').toEqual([0]);
  });

  test('a request whose client finished sending is left alone', () => {
    const server = guardedServer();
    const stream = fakeStream();
    server.open(stream);
    stream.state.remoteClose = 1;
    server.fire();

    expect(stream.responded).toEqual([]);
    expect(stream.closedWith).toEqual([]);
  });

  test('a request that carried no body is never armed', () => {
    const server = guardedServer();
    server.open(fakeStream({ endAfterHeaders: true }));

    expect(server.armed).toBe(0);
  });

  test('a stream that ends before its deadline takes the deadline with it', () => {
    const server = guardedServer();
    const stream = fakeStream();
    server.open(stream);
    stream.end();

    expect(server.armed, 'a closed stream left its deadline armed').toBe(0);
    server.fire();
    expect(stream.responded).toEqual([]);
    expect(stream.closedWith).toEqual([]);
  });

  test('an answer the handler already finished stands, and the rest of the upload is refused without error', () => {
    const server = guardedServer();
    const stream = fakeStream({ headersSent: true, writableEnded: true });
    server.open(stream);
    server.fire();

    expect(stream.responded, 'a second answer was written over a complete one').toEqual([]);
    expect(stream.closedWith).toEqual([0]);
  });

  test('an answer still being written when the request runs out of time is cut, not passed off as complete', () => {
    const server = guardedServer();
    const stream = fakeStream({ headersSent: true, writableEnded: false });
    server.open(stream);
    server.fire();

    expect(stream.responded).toEqual([]);
    expect(stream.closedWith, 'a half-written answer was reset with NO_ERROR, which reads as complete').toEqual([8]);
  });

  test('a deadline past what one host timer holds is chained, not fired early', () => {
    // request-timeout may be as long as 2^32 - 1 ms, and a host timer armed
    // with more than 2^31 - 1 fires after 1 ms on Bun and Node.  The guard
    // arms through the chain the scheduler uses for long delays, so the
    // first link is held at the ceiling and firing it only arms the next.
    const listeners: Array<(...args: ReadonlyArray<unknown>) => void> = [];
    const server = {
      on: ((event: string, listener: (...args: ReadonlyArray<unknown>) => void) => {
        if (event === 'stream') listeners.push(listener);
        return server;
      }) as NodeHttpServerLike['on'],
    } as NodeHttpServerLike;
    const delays: number[] = [];
    const callbacks: Array<() => void> = [];
    const hostTimers: HostTimers = {
      setTimeout: (callback, delayMs) => { delays.push(delayMs); callbacks.push(callback); return callbacks.length; },
      clearTimeout: () => { /* nothing to clear */ },
      setInterval: () => { throw new Error('the stream deadline arms no interval'); },
      clearInterval: () => { /* nothing to clear */ },
    };
    enforceStreamRequestTimeout(server, 4_294_967_295, hostTimers);
    const stream = fakeStream();
    for (const listener of listeners) listener(stream, {}, 0);
    callbacks.shift()!();

    expect(delays, 'a link was armed past the host timer ceiling').toEqual([2_147_483_647, 2_147_483_647]);
    expect(stream.responded, 'the deadline fired at the end of its first link').toEqual([]);
  });
});
