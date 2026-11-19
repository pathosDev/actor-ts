import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { HttpServerBackend, RouteRegistration, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { complete, get } from '../../../src/http/Route.js';
import { Status } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

/*
 * NOT covered here: the Express backend's WebSocket upgrade-reject, which
 * writes HTTP straight onto the raw socket.  It does get the same defaults
 * merged in, but an end-to-end assertion is impossible under `bun test`:
 * measured on Bun 1.3.1, *nothing* written to a `node:http` `'upgrade'`
 * socket ever reaches the peer — write, end, destroy, delayed destroy all
 * deliver zero bytes, while the identical probe under Node 26 delivers the
 * full response.  So a test here would fail for a reason that has nothing
 * to do with the header, and a passing one would have proved nothing.  The
 * swallowed upgrade-reject is a defect of its own (an `authorize` guard's
 * 401 never reaching a Bun-hosted client) and is filed separately.
 */

/** A third-party backend that predates the hook — the DSL must say so, not ignore it. */
class HookLessBackend implements HttpServerBackend {
  readonly name = 'hookless';
  registerRoute(_route: RouteRegistration): void { /* never reached in this test */ }
  listen(): Promise<ServerBinding> {
    throw new Error('listen() must not be reached — bind() rejects before it');
  }
}

describe('withSecurityHeaders on a backend without the hook', () => {
  test('bind() fails with a message naming the backend', async () => {
    const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('http-response-headers-hookless', sysOptions);
    try {
      const builder = system.extension(HttpExtensionId)
        .newServerAt('127.0.0.1', 0)
        .useBackend(new HookLessBackend())
        .withSecurityHeaders(false);
      await expect(builder.bind(get(() => complete(Status.OK, 'x')))).rejects.toThrow(/hookless.*setDefaultResponseHeaders/s);
    } finally {
      await system.terminate();
    }
  });
});
