import { describe, expect, test } from 'bun:test';
import { applyServerOptions, type NodeHttpServerLike } from '../../../src/http/backend/HttpServerBackend.js';

/**
 * `request-timeout` bounds the header phase as well: the headers are part of
 * the request, so a request deadline shorter than the header deadline *is* the
 * header deadline (#870).
 *
 * Without that rule the pair was incoherent in the one direction the docs'
 * own example took — `request-timeout = 30s` under the 60 s header default.
 * Both runtimes' `http.createServer` refuse such a pair outright
 * (`ERR_OUT_OF_RANGE`), but `applyServerOptions` writes the properties after
 * `listen()`, past that check, and Node's sweep then swaps the two: measured on
 * node v26.10.0, a 2 s `requestTimeout` under a 60 s `headersTimeout` closed a
 * stalled body at 60.0 s.  Bun does not swap, and ignores `headersTimeout`
 * altogether.  So the shorter deadline is written to the property *and* armed
 * by the framework-held guard, which is what makes it hold on both.
 *
 * Refusing the pair at `bind()` was the alternative, and the worse one: an
 * operator who lowers `request-timeout` has said something complete, and
 * making that an error until they also lower a default they never touched
 * turns a coherent request into a puzzle about two keys.
 */
describe('the request deadline bounds the header phase', () => {
  type FakeListener = (...args: ReadonlyArray<unknown>) => void;

  /** Long enough to be unambiguous under load, short enough to stay a unit test. */
  const SHORT_MS = 25;
  /** A deadline the watch window never reaches. */
  const LONG_MS = 60_000;
  /** How long a connection is watched for the guard to act. */
  const WATCH_WINDOW_MS = 400;

  /**
   * A server that records its listeners, plus one connection that never
   * finishes its headers — the slow-loris the guard exists for.
   */
  function slowLorisAgainst(policy: Parameters<typeof applyServerOptions>[1]) {
    const listeners = new Map<string, FakeListener[]>();
    const server: NodeHttpServerLike = {
      on: ((event: string, listener: FakeListener) => {
        const existing = listeners.get(event);
        if (existing) existing.push(listener);
        else listeners.set(event, [listener]);
        return undefined;
      }) as NodeHttpServerLike['on'],
    };
    applyServerOptions(server, policy);

    let wrote = '';
    let destroyed = false;
    const destroyWaiters: Array<() => void> = [];
    const socket = {
      destroy: (): void => {
        if (destroyed) return;
        destroyed = true;
        for (const waiter of destroyWaiters) waiter();
      },
      once: (): unknown => socket,
      end: (data?: string): unknown => { wrote += data ?? ''; return socket; },
    };
    for (const listener of listeners.get('connection') ?? []) listener(socket);
    return {
      server,
      get wrote() { return wrote; },
      /** Resolve `true` as soon as the guard hangs up, `false` if `withinMs` passes first. */
      cutWithin: (withinMs: number): Promise<boolean> => new Promise((resolve) => {
        if (destroyed) { resolve(true); return; }
        destroyWaiters.push(() => resolve(true));
        const timer = setTimeout(() => resolve(false), withinMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    };
  }

  test('a request-timeout below header-timeout is written as the header timeout too', () => {
    const { server } = slowLorisAgainst({ headerTimeoutMs: LONG_MS, requestTimeoutMs: 2_000 });

    // Written in order, so no runtime has a pair to swap.
    expect(server.headersTimeout).toBe(2_000);
    expect(server.requestTimeout).toBe(2_000);
  });

  test('…and the guard is armed at it, so the bound holds where the property does nothing', async () => {
    const connection = slowLorisAgainst({ headerTimeoutMs: LONG_MS, requestTimeoutMs: SHORT_MS });

    expect(await connection.cutWithin(WATCH_WINDOW_MS), 'the slow-loris outlived the request deadline').toBe(true);
    expect(connection.wrote).toContain('408 Request Timeout');
  });

  test('a request-timeout above header-timeout leaves header-timeout the bound', async () => {
    const connection = slowLorisAgainst({ headerTimeoutMs: SHORT_MS, requestTimeoutMs: LONG_MS });

    expect(connection.server.headersTimeout).toBe(SHORT_MS);
    expect(connection.server.requestTimeout).toBe(LONG_MS);
    expect(await connection.cutWithin(WATCH_WINDOW_MS)).toBe(true);
  });

  test('request-timeout = 0 is no bound at all, so header-timeout stands', async () => {
    // `0` is the runtime's own "no request deadline".  Taking it as the smaller
    // number would switch the header guard off — the inversion of what was
    // asked for.
    const connection = slowLorisAgainst({ headerTimeoutMs: SHORT_MS, requestTimeoutMs: 0 });

    expect(connection.server.headersTimeout).toBe(SHORT_MS);
    expect(await connection.cutWithin(WATCH_WINDOW_MS), 'request-timeout = 0 disarmed the header guard').toBe(true);
  });

  test('header-timeout = 0 stays off: a request deadline does not re-arm the guard', async () => {
    // The documented opt-out is the operator's to take.  The request deadline
    // still reaches the property, where a runtime that sweeps it applies it to
    // the header phase on its own; the guard stays switched off as asked.
    const connection = slowLorisAgainst({ headerTimeoutMs: 0, requestTimeoutMs: SHORT_MS });

    expect(connection.server.headersTimeout).toBe(0);
    expect(connection.server.requestTimeout).toBe(SHORT_MS);
    expect(await connection.cutWithin(WATCH_WINDOW_MS), 'an opted-out guard was armed anyway').toBe(false);
  });
});
