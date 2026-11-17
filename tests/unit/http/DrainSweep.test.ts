/**
 * #997 — the drain sweep of the `node:http` backends, and the bound on a
 * graceful unbind.
 *
 * `server.close()` closes the keep-alive connections idle at that moment and
 * no others, so `closeIdleConnectionsWhileDraining` sweeps every 50 ms while a
 * server drains: a connection whose request was in flight closes as soon as
 * it is answered, not when the grace window forces it.  The helper is shared
 * by `NodeHonoRunner`, `FastifyBackend` and `ExpressBackend`.  Two things are
 * pinned here, against stand-in servers whose `close()` the test controls:
 *
 *  - the sweep is armed at all — a graceful stop whose last connection only
 *    closes once swept resolves well inside the window;
 *  - it stops — once an unbind resolved, nothing calls `closeIdleConnections`
 *    on the closed server again, and an Express `close()` that never calls
 *    back still resolves `unbind` at the forced deadline.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { NodeHonoRunner } from '../../../src/runtime/http/NodeHonoRunner.js';
import { sleep } from '../../util/AwaitCondition.js';

type ServerModuleLoader = NonNullable<ConstructorParameters<typeof NodeHonoRunner>[0]>;
type ServerModule = Awaited<ReturnType<ServerModuleLoader>>;

/** Several sweep periods (50 ms each): a sweep still running has ticked by then. */
const SEVERAL_SWEEPS_MS = 300;
/** Far inside any grace window a test here sets, and far past one sweep. */
const WELL_INSIDE_THE_WINDOW_MS = 2_000;
const GRACE_PERIOD_MS = 10_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Whether `promise` settles within `withinMs`. */
async function settlesWithin(promise: Promise<unknown>, withinMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => { timer = setTimeout(() => { resolve(false); }, withinMs); });
  try {
    return await Promise.race([promise.then(() => true), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A server draining one keep-alive connection that is idle only once its
 * response went out: its `close()` calls back when `closeIdleConnections`
 * closes that connection, and counts every sweep.
 */
function serverWithAnsweredKeepAliveConnection() {
  let closeCallback: (() => void) | undefined;
  let sweeps = 0;
  const server = {
    close: (callback?: () => void) => { closeCallback = callback; },
    closeIdleConnections: () => {
      sweeps++;
      const callback = closeCallback;
      closeCallback = undefined;
      callback?.();
    },
    closeAllConnections: () => { /* not the graceful path */ },
    address: () => ({ address: '127.0.0.1', port: 4321 }),
  };
  return { server, get sweeps() { return sweeps; } };
}

describe('NodeHonoRunner — a graceful stop sweeps idle connections, then stops sweeping', () => {
  async function servedOn(server: ReturnType<typeof serverWithAnsweredKeepAliveConnection>['server']) {
    const module: ServerModule = {
      serve(_options, onReady) {
        queueMicrotask(() => onReady?.({ address: '127.0.0.1', port: 4321 }));
        return server;
      },
    };
    return new NodeHonoRunner(async () => module).serve({ host: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
  }

  test('the connection answered during the drain closes on the next sweep, not at the window', async () => {
    const fake = serverWithAnsweredKeepAliveConnection();
    const handle = await servedOn(fake.server);
    expect(await settlesWithin(handle.stop(true), WELL_INSIDE_THE_WINDOW_MS)).toBe(true);
    expect(fake.sweeps).toBeGreaterThan(0);
  });

  test('no sweep runs once the stop resolved', async () => {
    const fake = serverWithAnsweredKeepAliveConnection();
    const handle = await servedOn(fake.server);
    await handle.stop(true);
    const sweepsAtStop = fake.sweeps;
    await sleep(SEVERAL_SWEEPS_MS); // an absence: a sweep left running would tick several times in this window
    expect(fake.sweeps).toBe(sweepsAtStop);
  });
});

describe('FastifyBackend — a graceful unbind stops its sweep', () => {
  test('no closeIdleConnections call once unbind resolved', async () => {
    const backend = new FastifyBackend({ logger: false });
    const binding = await backend.listen('127.0.0.1', 0);
    cleanups.push(() => binding.unbind(0));
    const server = (backend as unknown as { app: { server: { closeIdleConnections?: () => void } } }).app.server;
    let sweeps = 0;
    server.closeIdleConnections = () => { sweeps++; };
    await binding.unbind(GRACE_PERIOD_MS);
    const sweepsAtUnbind = sweeps;
    await sleep(SEVERAL_SWEEPS_MS); // an absence: a sweep left running would tick several times in this window
    expect(sweeps).toBe(sweepsAtUnbind);
  });
});

describe('ExpressBackend — a close() that never calls back', () => {
  /** An Express binding whose server is swapped for one whose `close()` hangs; the real one is closed by the test. */
  async function hangingExpressBinding() {
    const backend = new ExpressBackend();
    const binding = await backend.listen('127.0.0.1', 0);
    const holder = backend as unknown as { server: { close: (callback?: () => void) => void } | null };
    const real = holder.server!;
    cleanups.push(() => new Promise<void>((resolve) => { real.close(() => { resolve(); }); }));
    let sweeps = 0;
    holder.server = {
      close: () => { /* never calls back, as Bun's can after a WebSocket upgrade */ },
      closeIdleConnections: () => { sweeps++; },
      closeAllConnections: () => { /* nothing left to force */ },
    } as typeof real;
    return { binding, get sweeps() { return sweeps; } };
  }

  test('unbind resolves at the forced deadline', async () => {
    const hanging = await hangingExpressBinding();
    expect(await settlesWithin(hanging.binding.unbind(200), WELL_INSIDE_THE_WINDOW_MS)).toBe(true);
  });

  test('the sweep stops at the forced deadline', async () => {
    const hanging = await hangingExpressBinding();
    await hanging.binding.unbind(200);
    const sweepsAtUnbind = hanging.sweeps;
    await sleep(SEVERAL_SWEEPS_MS); // an absence: a sweep left running would tick several times in this window
    expect(hanging.sweeps).toBe(sweepsAtUnbind);
  });
});
