/**
 * #1487 — `actor-ts.http.server.idle-timeout` on the Hono backend under Bun,
 * end to end through `HttpExtension`.
 *
 * Under `bun test` the Hono backend serves through `Bun.serve`, whose own
 * `idleTimeout` is a **whole-connection** bound: a connection is closed once it
 * has been silent that long, between requests *and* while a request is in
 * flight and its handler has written nothing.  It counts whole seconds, at
 * most 255, and checks on a 4 s sweep — a value of `X` seconds is held as
 * `ceil(X / 4)` sweeps, so a silent connection goes up to one sweep early.
 *
 * Before #1487 nothing reached it: a configured `idle-timeout` was ignored, and
 * Bun's own 10 s cut any handler slower than about 12 s with no response — a
 * `requestTimeout()` 503 included.  Now a set key is written there, a key past
 * what Bun can hold fails `bind()` by name, and an unset key is derived from
 * the server's longest request deadline so the 503 is written first.
 *
 * Every wait here is an observation of time itself — a connection the server
 * should close inside a window, one it must not close, a handler meant to be
 * slow — so each carries its own budget and its test an explicit timeout.
 */
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId, type ServerBuilder } from '../../../src/http/HttpExtension.js';
import { HttpServerOptions } from '../../../src/http/HttpServerOptions.js';
import { requestTimeout } from '../../../src/http/middleware/Timeout.js';
import { complete, concat, get, path, withMiddleware, type Route } from '../../../src/http/Route.js';
import { Status, type HttpResponse } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/** Bun's idle sweep: the most a silent connection can outlive its timeout, and the earliest it can be cut before it. */
const ONE_SWEEP_MS = 4_000;
/** Scheduling slack on top of a sweep, for a loaded machine. */
const SLACK_MS = 1_000;

const running: Array<{ readonly system: ActorSystem; readonly binding?: ServerBinding }> = [];
const sockets: Socket[] = [];

afterEach(async () => {
  while (sockets.length) sockets.shift()!.destroy();
  while (running.length) {
    const { system, binding } = running.pop()!;
    if (binding) await binding.unbind();
    await system.terminate();
  }
});

const ok: Route = get(() => complete(Status.OK, 'ok'));

/** A system on the Hono backend under `hocon`, its server bound to `routes` with `configure` applied. */
async function bindHono(
  hocon: string,
  routes: Route = ok,
  configure: (builder: ServerBuilder) => ServerBuilder = (builder) => builder,
): Promise<ServerBinding> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(`actor-ts.http.backend = hono\n${hocon}`));
  const system = ActorSystem.create('hono-bun-idle-timeout', systemOptions);
  const entry: { system: ActorSystem; binding?: ServerBinding } = { system };
  running.push(entry);
  const binding = await configure(system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0)).bind(routes);
  entry.binding = binding;
  return binding;
}

/** The refusal `bind()` produced, or `undefined` when it bound. */
async function refusalOf(binding: Promise<ServerBinding>): Promise<unknown> {
  try {
    await binding;
    return undefined;
  } catch (error) {
    return error;
  }
}

/** What happened to one request on a fresh connection: the status line, or that the server closed it first. */
type Exchange = { readonly status: number | 'closed without a byte'; readonly afterMs: number };

/**
 * Send one `GET` on a fresh keep-alive connection and settle on the first
 * thing that happens: the response's status line, or the server closing the
 * connection without having written a byte.  Gives up after `giveUpMs`, which
 * fails the case rather than hanging it.
 */
function exchange(binding: ServerBinding, requestPath: string, giveUpMs: number): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let received = '';
    const settle = (outcome: Exchange | Error): void => {
      clearTimeout(timer);
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const socket = connect({ host: binding.host, port: binding.port }, () => {
      socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n`);
    });
    sockets.push(socket);
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      const statusLine = /^HTTP\/1\.1 (\d{3})/.exec(received);
      if (statusLine) settle({ status: Number(statusLine[1]), afterMs: performance.now() - started });
    });
    socket.on('error', () => { /* observed as the close that follows */ });
    socket.on('close', () => {
      if (received === '') settle({ status: 'closed without a byte', afterMs: performance.now() - started });
    });
    const timer = setTimeout(() => settle(new Error(`GET ${requestPath}: nothing within ${giveUpMs} ms`)), giveUpMs);
  });
}

/**
 * A keep-alive connection that has had its one exchange and is now idle:
 * resolves with how long after the response the server closed it, or `null`
 * when it was still open `withinMs` later.
 */
function idleCloseAfterResponse(binding: ServerBinding, withinMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let received = '';
    let answeredAt: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const socket = connect({ host: binding.host, port: binding.port }, () => {
      socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    });
    sockets.push(socket);
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      // `ok` is the whole body: once it is in, the connection is idle.
      if (answeredAt === undefined && received.endsWith('ok')) {
        answeredAt = performance.now();
        timer = setTimeout(() => resolve(null), withinMs);
      }
    });
    socket.on('error', () => { /* observed as the close that follows */ });
    socket.on('close', () => {
      if (timer) clearTimeout(timer);
      if (answeredAt === undefined) reject(new Error(`closed before the response completed: ${JSON.stringify(received)}`));
      else resolve(performance.now() - answeredAt);
    });
  });
}

describe('Hono under Bun — an idle-timeout Bun.serve cannot hold fails bind(), by name', () => {
  test('withIdleTimeoutMs(256_000) is refused, naming the key and the builder method', async () => {
    const serverOptions = HttpServerOptions.create().withIdleTimeoutMs(256_000);
    const refusal = await refusalOf(bindHono('', ok, (builder) => builder.withServerOptions(serverOptions)));

    expect(refusal).toBeInstanceOf(OptionsError);
    expect((refusal as Error).message).toContain('actor-ts.http.server.idle-timeout');
    expect((refusal as Error).message).toContain('withIdleTimeoutMs');
  });

  test('so is HOCON idle-timeout = 5m', async () => {
    const refusal = await refusalOf(bindHono('actor-ts.http.server.idle-timeout = 5m'));

    expect(refusal).toBeInstanceOf(OptionsError);
    expect((refusal as Error).message).toContain('actor-ts.http.server.idle-timeout');
    expect((refusal as Error).message).toContain('withIdleTimeoutMs');
  });

  test('255s is the most it holds, and binds', async () => {
    const binding = await bindHono('actor-ts.http.server.idle-timeout = 255s');

    expect(binding.serverOptionsReport?.idleTimeoutMs).toBe(true);
  });
});

describe('Hono under Bun — a set idle-timeout is Bun.serve\'s idleTimeout', () => {
  test('idle-timeout = 2s closes an idle keep-alive connection within one sweep', async () => {
    const binding = await bindHono('actor-ts.http.server.idle-timeout = 2s');

    const closedAfterMs = await idleCloseAfterResponse(binding, ONE_SWEEP_MS + SLACK_MS);

    expect(closedAfterMs, 'an idle connection outlived idle-timeout = 2s by more than a sweep').not.toBeNull();
    expect(binding.serverOptionsReport?.idleTimeoutMs).toBe(true);
  }, 15_000);

  test('idle-timeout = 0 leaves it open past 6 s — and past the default it would get if the 0 were lost — and it still serves', async () => {
    // Under a 1 s deadline the derived default is 8 s, so a 0 dropped on the
    // way and read as unset would close the connection inside this window.
    const binding = await bindHono('actor-ts.http.server.idle-timeout = 0\nactor-ts.http.request-timeout.deadline = 1s');

    // An absence cannot be polled for: the window is the observation.
    const closedAfterMs = await idleCloseAfterResponse(binding, 2 * ONE_SWEEP_MS + 2 * SLACK_MS);

    expect(closedAfterMs, `idle-timeout = 0 closed the connection ${closedAfterMs} ms after its response`).toBeNull();
    const second = await exchange(binding, '/', 2_000);
    expect(second.status).toBe(Status.OK);
  }, 20_000);
});

describe('Hono under Bun — unset, the idle timeout is derived from the longest request deadline', () => {
  test('a 1 s deadline derives 8 s: idle connections are closed after more than one sweep and within two', async () => {
    // 4 * (ceil((1 s + 2 s) / 4) + 1) = 8 s, held as two sweeps, so each close
    // lands between 4 s and 8 s after its response, depending on where in the
    // sweep the response fell.  Bun's own 10 s is three sweeps — between 8 s
    // and 12 s — which borders that window, so one connection cannot tell the
    // two apart: four, one second apart, cover the sweep, and under 8 s the
    // earliest of them closes by about 5 s while under Bun's 10 s none closes
    // before 8 s.
    const binding = await bindHono('actor-ts.http.request-timeout.deadline = 1s');

    const closes = await Promise.all([0, 1_000, 2_000, 3_000].map((offsetMs) =>
      new Promise<number | null>((resolve, reject) => {
        // Staggered on purpose: the offsets are what spread the connections over the sweep.
        setTimeout(() => { idleCloseAfterResponse(binding, 2 * ONE_SWEEP_MS + SLACK_MS).then(resolve, reject); }, offsetMs);
      })));

    expect(closes.every((close) => close !== null), `closed after ${JSON.stringify(closes)} ms`).toBe(true);
    const closedAfterMs = closes as number[];
    expect(Math.min(...closedAfterMs), `closed after ${JSON.stringify(closedAfterMs)} ms`).toBeLessThan(2 * ONE_SWEEP_MS - SLACK_MS);
    expect(Math.min(...closedAfterMs), `closed after ${JSON.stringify(closedAfterMs)} ms`).toBeGreaterThan(ONE_SWEEP_MS - SLACK_MS);
  }, 25_000);

  test('a 14 s requestTimeout() answers its 503 and a 14 s handler completes, under a 2 s configured deadline', async () => {
    // The configured deadline is 2 s, but one route holds 14 s: the default
    // has to come from the longer one, or both requests below are cut with no
    // response by about 8 s.  Before #1487 Bun's own 10 s cut them at ~12 s.
    const HANDLER_MS = 14_000;
    const routes = concat(
      path('timed', withMiddleware(requestTimeout(HANDLER_MS), get(() => new Promise<HttpResponse>(() => { /* never answers */ })))),
      // Deliberately slow: the handler's own duration is what is under test.
      path('slow', get(() => new Promise<HttpResponse>((resolve) => setTimeout(() => resolve(complete(Status.OK, 'late')), HANDLER_MS)))),
    );
    const binding = await bindHono('actor-ts.http.request-timeout.deadline = 2s', routes);

    const [timed, slow] = await Promise.all([
      exchange(binding, '/timed', HANDLER_MS + 6_000),
      exchange(binding, '/slow', HANDLER_MS + 6_000),
    ]);

    expect(timed.status, `the requestTimeout() route ended after ${Math.round(timed.afterMs)} ms`).toBe(Status.ServiceUnavailable);
    expect(timed.afterMs).toBeGreaterThanOrEqual(HANDLER_MS - 100);
    expect(timed.afterMs).toBeLessThan(HANDLER_MS + 2_000);
    expect(slow.status, `the slow handler ended after ${Math.round(slow.afterMs)} ms`).toBe(Status.OK);
    expect(slow.afterMs).toBeGreaterThanOrEqual(HANDLER_MS - 100);
    // Unset is not "set": nothing the deployment named was installed, so the
    // report keeps saying so — and there is nothing for bind() to warn about.
    expect(binding.serverOptionsReport?.idleTimeoutMs).toBe(false);
  }, 30_000);
});
