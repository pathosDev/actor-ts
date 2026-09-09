import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { DEFAULT_HTTP_BIND_HOST } from '../../../src/http/Constants.js';
import { complete, get, type Route } from '../../../src/http/Route.js';
import { Status } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

/**
 * `ActorSystem.http(port)` binds loopback when the caller names no host
 * (#1408).
 *
 * It bound the IPv4 wildcard until this change, which made the shortest and
 * most-copied form of the shortcut the one that published the server on every
 * interface.  Nothing at the call site recorded that decision, and the guard
 * over `examples/` explicitly exempted the form on the stated grounds that a
 * host-less call is "configuration" — which it was not: the address was a
 * hard-coded default one function call away.
 *
 * The behaviour is asserted here and the constant is pinned as non-wildcard by
 * `tests/unit/ci/ExampleBindAddresses.test.ts`, which is what replaced that
 * exemption.  Two assertions, deliberately: the constant could be changed to
 * another loopback spelling without breaking this file, and this file would
 * still fail if the shortcut stopped reading it.
 */
describe('ActorSystem.http bind host (#1408)', () => {
  const routes: Route = get(() => complete(Status.OK, 'ok'));
  const live: Array<{ binding: ServerBinding; system: ActorSystem }> = [];

  afterEach(async () => {
    while (live.length) {
      const { binding, system } = live.shift()!;
      await binding.unbind();
      await system.terminate();
    }
  });

  async function bind(options?: { readonly host?: string }): Promise<ServerBinding> {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('http-shortcut-bind-host', systemOptions);
    // Port 0 rather than a number: this repository's Windows machines carry
    // excluded port ranges that turn a fixed port into an EACCES nobody
    // connects to the test.
    const binding = await system.http(0, options).bind(routes);
    live.push({ binding, system });
    return binding;
  }

  test('a call with no host binds loopback, not every interface', async () => {
    const binding = await bind();

    expect(binding.host).toBe(DEFAULT_HTTP_BIND_HOST);
    expect(binding.host).not.toBe('0.0.0.0');
  });

  test('an explicit host still wins, including the wildcard', async () => {
    // The migration path has to work, or the change would be a removal rather
    // than a default: a deployment that wants every interface says so.
    const binding = await bind({ host: '0.0.0.0' });

    expect(binding.host).toBe('0.0.0.0');
  });

  test('the shortcut reads the constant rather than repeating it', async () => {
    // Pins the coupling the guard depends on.  A shortcut that spelled the
    // address inline would satisfy the first case today and drift silently
    // the next time the constant moves.
    const binding = await bind();

    expect(DEFAULT_HTTP_BIND_HOST).toBe('127.0.0.1');
    expect(binding.host).toBe(DEFAULT_HTTP_BIND_HOST);
  });
});
