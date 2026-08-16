/**
 * #1197 — the fetch handler the Hono backend serves through must declare its
 * `request` parameter, because `Deno.serve` dispatches on the handler's
 * `Function.prototype.length`.
 *
 * Since Deno 2.9 (`ext/http/00_serve.ts`, absent in 2.6.8 and 2.8.0) an
 * arity-0 handler is read as one that does not want the request, and Deno
 * skips building the `Request` and invokes it with no arguments at all:
 *
 * ```js
 * const rawNoRequest = handler.length === 0 && nativeFastPath;
 * const zeroArgCallback = callback.length === 0 && !otelState.TRACING_ENABLED;
 * if (zeroArgCallback && op_http_is_raw_request(req)) response = await callback();
 * ```
 *
 * `HonoBackend` used to hand the runner `(...args) => appFetch(...args)`, a
 * forwarder written that way on purpose so Bun's second `server` argument
 * survives.  A rest parameter contributes 0 to that length, so on Deno 2.9.5
 * Hono's `app.fetch` was called with nothing and threw on `undefined.method`;
 * every request through the backend answered 500.
 *
 * The cross-runtime matrix caught it, but only on push, only on ubuntu, and
 * only after the fact — so the invariant is asserted here, under `bun test`,
 * by replaying Deno's own dispatch rule against the real handler.  Bun and
 * Node pass `options.fetch` straight through, so the arity assertion on
 * {@link honoFetchHandler} covers those two runners as well.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { honoFetchHandler } from '../../../src/http/backend/HonoBackend.js';
import type { HonoAppLike } from '../../../src/http/backend/HonoBackend.js';
import { DenoHonoRunner } from '../../../src/runtime/http/DenoHonoRunner.js';
import type { FetchHandler } from '../../../src/runtime/http/HonoServerRunner.js';

/** Stands in for whatever a runtime passes second — Bun's `server`, Deno's `info`. */
const RUNTIME_EXTRA = { marker: 'second-argument' } as const;

/**
 * What Deno ≥ 2.9 does with a handler, reduced to the one branch that matters.
 *
 * Deliberately a re-implementation of Deno's rule rather than a call into it:
 * `bun test` has no Deno to ask, and the rule — not Deno's plumbing — is what
 * this suite is defending.  Keep it reading like the source it mirrors.
 */
async function denoDispatch(handler: FetchHandler, request: Request): Promise<Response> {
  const rawNoRequest = handler.length === 0;
  return rawNoRequest
    ? await (handler as unknown as () => Promise<Response> | Response)()
    : await handler(request, RUNTIME_EXTRA);
}

/** A Hono app with one route that echoes back what its `Env` was set to. */
function appEchoingEnvironment(): HonoAppLike {
  const app = new Hono<{ Bindings: typeof RUNTIME_EXTRA }>();
  app.get('/ping', (c) => c.json({ marker: c.env?.marker ?? null }));
  return app as unknown as HonoAppLike;
}

describe('honoFetchHandler — the handler HonoBackend serves an app through', () => {
  test('declares its request parameter, so Deno never classifies it as arity-0', () => {
    // The whole defect in one number: `(...args) => …` reports 0 here, and 0
    // is what makes Deno drop the request.  Asserted directly as well as
    // through the dispatch below, so a refactor back to a rest-only forwarder
    // fails with a message that says what it broke.
    expect(honoFetchHandler(new Hono() as unknown as HonoAppLike).length).toBeGreaterThan(0);
  });

  test('survives a Deno 2.9 dispatch — the request reaches the app', async () => {
    const handler = honoFetchHandler(appEchoingEnvironment());

    const response = await denoDispatch(handler, new Request('http://127.0.0.1/ping'));

    // Before the fix this rejected with `TypeError: Cannot read properties of
    // undefined (reading 'method')` out of hono-base.js, which the backend's
    // onError turned into the 500 the smoke run saw.
    expect(response.status).toBe(200);
  });

  test('still forwards the runtime extra Hono turns into the app Env', async () => {
    // The reason the broken forwarder was variadic in the first place: Bun
    // invokes `fetch(request, server)` and Hono's WebSocket upgrade calls
    // `server.upgrade()` on that second argument.  Fixing the arity must not
    // cost the argument — a one-parameter handler would pass every assertion
    // above and still break every upgrade.
    const handler = honoFetchHandler(appEchoingEnvironment());

    const response = await denoDispatch(handler, new Request('http://127.0.0.1/ping'));

    expect(await response.json()).toEqual({ marker: RUNTIME_EXTRA.marker });
  });

  test('forwards a third argument too — Hono reads it as the ExecutionContext', async () => {
    const seen: unknown[][] = [];
    const app = { fetch: (...args: unknown[]) => { seen.push(args); return new Response('ok'); } } as unknown as HonoAppLike;

    const request = new Request('http://127.0.0.1/ping');
    await honoFetchHandler(app)(request, RUNTIME_EXTRA, 'execution-context');

    expect(seen).toEqual([[request, RUNTIME_EXTRA, 'execution-context']]);
  });

  test('calls fetch as a method, so a prototype-bound app keeps its `this`', async () => {
    // Hono's own `fetch` is a class field arrow and would survive being
    // lifted to a local, but `HonoBackendOptions.app` accepts any app.
    class PrototypeApp {
      readonly reply = 'from the instance';
      fetch(): Response { return new Response(this.reply); }
    }

    const response = await honoFetchHandler(new PrototypeApp() as unknown as HonoAppLike)(
      new Request('http://127.0.0.1/ping'),
    );

    expect(await response.text()).toBe('from the instance');
  });
});

describe('DenoHonoRunner — normalises arity at the runtime seam', () => {
  const realDeno = (globalThis as { Deno?: unknown }).Deno;
  const setDeno = (value: unknown): void => {
    Object.defineProperty(globalThis, 'Deno', { value, configurable: true, writable: true });
  };
  afterEach(() => { setDeno(realDeno); });

  /**
   * Serve through a fake `Deno.serve` and hand back the handler it installed.
   *
   * The `fetch` under test is deliberately the shape that broke — rest-only,
   * arity 0 — because the runner is the backstop: whatever a caller writes,
   * what reaches `Deno.serve` has to declare its parameters.
   */
  async function installedHandler(fetch: FetchHandler): Promise<FetchHandler> {
    let captured: FetchHandler | null = null;
    setDeno({
      serve: (_options: unknown, handler: FetchHandler) => {
        captured = handler;
        return { finished: Promise.resolve(), shutdown: async (): Promise<void> => {} };
      },
    });
    await new DenoHonoRunner().serve({ host: '127.0.0.1', port: 0, fetch });
    return captured!;
  }

  test('installs a handler Deno cannot mistake for one that wants no request', async () => {
    const variadic = ((...args: unknown[]) => new Response(String(args.length))) as unknown as FetchHandler;
    expect(variadic.length).toBe(0); // the premise — this is what Deno drops

    expect((await installedHandler(variadic)).length).toBeGreaterThan(0);
  });

  test('a Deno 2.9 dispatch through it still delivers request and info', async () => {
    const seen: unknown[][] = [];
    const variadic = ((...args: unknown[]) => { seen.push(args); return new Response('ok'); }) as unknown as FetchHandler;

    const request = new Request('http://127.0.0.1/ping');
    const response = await denoDispatch(await installedHandler(variadic), request);

    expect(response.status).toBe(200);
    expect(seen).toEqual([[request, RUNTIME_EXTRA]]);
  });
});
