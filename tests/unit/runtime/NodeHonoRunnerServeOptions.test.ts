/**
 * #1486 — what `NodeHonoRunner.serve` hands `@hono/node-server`.
 *
 * The runner is reached through the loader it was constructed with, so a case
 * can stand in a module that records the option bag `serve()` receives — the
 * only place the bag is visible, since the real module consumes it.  A
 * `mock.module('@hono/node-server')` would not do: `mock.restore()` does not
 * undo it (`tests/unit/ci/ModuleMockDiscipline.test.ts`), and the runner's
 * default loader caches the first module it resolves for the whole process.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { HonoServerHandle } from '../../../src/runtime/http/HonoServerRunner.js';
import { NodeHonoRunner } from '../../../src/runtime/http/NodeHonoRunner.js';

type ServerModuleLoader = NonNullable<ConstructorParameters<typeof NodeHonoRunner>[0]>;
type ServerModule = Awaited<ReturnType<ServerModuleLoader>>;
type ServeBag = Parameters<ServerModule['serve']>[0];

/** The port the stand-in reports as bound, so a case can tell its handle from a real one. */
const STAND_IN_PORT = 4321;

/** A stand-in for `@hono/node-server` that records every bag `serve()` is handed and binds nothing. */
function capturingModule(): { readonly load: ServerModuleLoader; readonly bags: ServeBag[] } {
  const bags: ServeBag[] = [];
  const module: ServerModule = {
    serve(options, onReady) {
      bags.push(options);
      // The real module reports from `listen()`'s callback, after `serve()` has
      // returned — and the runner reads `serve()`'s return value inside it.
      queueMicrotask(() => onReady?.({ address: '127.0.0.1', port: STAND_IN_PORT }));
      return {
        close: (callback?: () => void) => { callback?.(); },
        address: () => ({ address: '127.0.0.1', port: STAND_IN_PORT }),
      };
    },
  };
  return { load: async () => module, bags };
}

const hello = (): Response => new Response('hello');

const handles: HonoServerHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop(false).catch(() => {});
});

describe('NodeHonoRunner — the @hono/node-server loader (#1486)', () => {
  test('serve() reaches @hono/node-server through the loader it was constructed with', async () => {
    const stub = capturingModule();

    const handle = await new NodeHonoRunner(stub.load).serve({ host: '127.0.0.1', port: 0, fetch: hello });
    handles.push(handle);

    expect(stub.bags).toHaveLength(1);
    expect(handle.port).toBe(STAND_IN_PORT);
  });
});
