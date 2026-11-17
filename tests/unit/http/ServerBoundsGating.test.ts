/**
 * Which bounds `applyServerOptions` arms, and on which listener — and the drain
 * window `unbind(gracePeriodMs)` reads.
 *
 * `0` is "no bound" on every listener, so `request-timeout = 0` arms no HTTP/2
 * stream deadline: a zero-length one would answer every stream still
 * receiving its body with `408` at once.  The HTTP/1.1-on-HTTP/2 bounds
 * (#1756) belong to Bun's HTTP/2 listener only; a plain TLS listener takes
 * `keepAliveTimeout` and `requestTimeout` itself and gets none of them.
 */
import { describe, expect, test } from 'bun:test';
import { applyServerOptions, drainWindowOf, type NodeHttpServerLike } from '../../../src/http/backend/HttpServerBackend.js';
import type { HostTimers } from '../../../src/Scheduler.js';

/** A stand-in server recording which events something subscribed to. */
function fakeServer(http2: boolean) {
  const handlers = new Map<string, Array<(...eventArguments: ReadonlyArray<unknown>) => void>>();
  const server = {
    on: ((event: string, handler: (...eventArguments: ReadonlyArray<unknown>) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return server;
    }) as NodeHttpServerLike['on'],
    ...(http2 ? { updateSettings: () => { /* an HTTP/2 listener's marker */ } } : {}),
  } as NodeHttpServerLike;
  const pending = new Map<number, () => void>();
  let nextHandle = 0;
  const hostTimers: HostTimers = {
    setTimeout: (callback) => { nextHandle++; pending.set(nextHandle, callback); return nextHandle; },
    clearTimeout: (handle) => { pending.delete(handle as number); },
    setInterval: () => { throw new Error('no bound here arms an interval'); },
    clearInterval: () => { /* nothing to clear */ },
  };
  return {
    server,
    hostTimers,
    subscribed: (event: string): number => handlers.get(event)?.length ?? 0,
    emit: (event: string, ...eventArguments: ReadonlyArray<unknown>): void => {
      for (const handler of handlers.get(event) ?? []) handler(...eventArguments);
    },
    /** Fire every timer armed so far, whatever its delay. */
    fireAll: (): void => {
      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback();
    },
  };
}

/** An HTTP/2 stream whose client has not finished sending its body. */
function streamStillReceiving() {
  const responses: Array<Record<string, unknown>> = [];
  let closes = 0;
  const stream = {
    state: { remoteClose: 0 },
    respond: (headers: Record<string, unknown>) => { responses.push(headers); },
    close: () => { closes++; },
    once: () => stream,
  };
  return { stream, responses, get closes() { return closes; } };
}

describe('request-timeout on HTTP/2 streams', () => {
  test('request-timeout = 0 arms no stream deadline', () => {
    const fake = fakeServer(true);
    applyServerOptions(fake.server, { requestTimeoutMs: 0 }, fake.hostTimers);
    const incoming = streamStillReceiving();
    fake.emit('stream', incoming.stream);
    fake.fireAll();
    expect(incoming.responses).toEqual([]);
    expect(incoming.closes).toBe(0);
  });

  test('a positive request-timeout arms one, which answers a stalled stream 408', () => {
    const fake = fakeServer(true);
    applyServerOptions(fake.server, { requestTimeoutMs: 1_000 }, fake.hostTimers);
    const incoming = streamStillReceiving();
    fake.emit('stream', incoming.stream);
    fake.fireAll();
    expect(incoming.responses).toEqual([{ ':status': 408 }]);
  });
});

describe('the HTTP/1.1 bounds of an HTTP/2 listener', () => {
  test('are installed on Bun\'s HTTP/2 listener', () => {
    const fake = fakeServer(true);
    applyServerOptions(fake.server, { idleTimeoutMs: 800, requestTimeoutMs: 1_000 }, fake.hostTimers);
    expect(fake.subscribed('secureConnection')).toBe(1);
  });

  test('are not installed on a listener without HTTP/2', () => {
    const fake = fakeServer(false);
    applyServerOptions(fake.server, { idleTimeoutMs: 800, requestTimeoutMs: 1_000 }, fake.hostTimers);
    expect(fake.subscribed('secureConnection')).toBe(0);
  });
});

describe('drainWindowOf', () => {
  test.each([
    [undefined, 0],
    [0, 0],
    [-1, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 0],
    [250, 250],
  ])('drainWindowOf(%p) is %p', (gracePeriodMs, expected) => {
    expect(drainWindowOf(gracePeriodMs)).toBe(expected);
  });
});
