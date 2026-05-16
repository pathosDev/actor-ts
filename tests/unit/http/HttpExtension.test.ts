import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { CoordinatedShutdownId, Phases } from '../../../src/CoordinatedShutdown.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { complete, get } from '../../../src/http/Route.js';
import { Status } from '../../../src/http/types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

const newSystem = (name = 'http-ext-unit'): ActorSystem =>
  ActorSystem.create(name, { logger: new NoopLogger(), logLevel: LogLevel.Off });

async function bindOk(system: ActorSystem): Promise<ServerBinding> {
  return system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .useBackend(new FastifyBackend({ logger: false }))
    .bind(get(() => complete(Status.OK, 'ok')));
}

describe('HttpExtension — CoordinatedShutdown auto-registration', () => {
  test('CoordinatedShutdown.run() closes a bound HTTP server', async () => {
    const system = newSystem();
    const binding = await bindOk(system);

    // Sanity: server is reachable before shutdown.
    const before = await fetch(`http://${binding.host}:${binding.port}/`);
    expect(before.status).toBe(200);

    // Triggering the pipeline runs ServiceUnbind, which closes the server,
    // then ActorSystemTerminate, which stops the system.
    await system.extension(CoordinatedShutdownId).run();

    // Now connections should be refused.  Different runtimes word the
    // error differently, so just assert that fetch rejects.
    await expect(fetch(`http://${binding.host}:${binding.port}/`)).rejects.toThrow();
    expect(system.isTerminated).toBe(true);
  });

  test('a manual unbind() before shutdown is safe — the auto-task is idempotent', async () => {
    const system = newSystem();
    const binding = await bindOk(system);

    // User-initiated unbind happens first…
    await binding.unbind();
    await expect(fetch(`http://${binding.host}:${binding.port}/`)).rejects.toThrow();

    // …and the auto-registered shutdown task must not throw or re-close.
    await system.extension(CoordinatedShutdownId).run();
    expect(system.isTerminated).toBe(true);
  });

  test('the ServiceUnbind task is registered under a port-scoped name', async () => {
    const system = newSystem();
    const binding = await bindOk(system);

    const cs = system.extension(CoordinatedShutdownId);
    // Registering the SAME name again must throw — proves the auto-task is there.
    expect(() => cs.addTask(
      Phases.ServiceUnbind,
      `http-unbind-${binding.host}:${binding.port}`,
      () => {},
    )).toThrow(/already registered/);

    await binding.unbind();
    await system.terminate();
  });

  test('two servers on different ports get distinct task names', async () => {
    const system = newSystem();
    const ext = system.extension(HttpExtensionId);
    const b1 = await ext.newServerAt('127.0.0.1', 0).useBackend(new FastifyBackend({ logger: false })).bind(
      get(() => complete(Status.OK, 'a')),
    );
    const b2 = await ext.newServerAt('127.0.0.1', 0).useBackend(new FastifyBackend({ logger: false })).bind(
      get(() => complete(Status.OK, 'b')),
    );
    expect(b1.port).not.toBe(b2.port);

    // Both should close when shutdown fires.
    await system.extension(CoordinatedShutdownId).run();
    await expect(fetch(`http://${b1.host}:${b1.port}/`)).rejects.toThrow();
    await expect(fetch(`http://${b2.host}:${b2.port}/`)).rejects.toThrow();
  });
});
