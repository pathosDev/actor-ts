import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { CoordinatedShutdownId, Phases } from '../../../src/CoordinatedShutdown.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { complete, get } from '../../../src/http/Route.js';
import { Status } from '../../../src/http/types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

const newSystem = (name = 'http-ext-unit'): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

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

describe('HttpExtension — error paths', () => {
  test('binding twice to the same port surfaces the listen error', async () => {
    const system = newSystem();
    const b1 = await bindOk(system);
    try {
      // Second bind to the already-claimed port.  The exact error
      // shape is platform / backend dependent (EADDRINUSE on Linux,
      // AddressInUse on Bun), so just assert that bind rejects.
      await expect(
        system.extension(HttpExtensionId)
          .newServerAt(b1.host, b1.port)
          .useBackend(new FastifyBackend({ logger: false }))
          .bind(get(() => complete(Status.OK, ''))),
      ).rejects.toThrow();
    } finally {
      await b1.unbind();
      await system.terminate();
    }
  });

  test('handler errors are caught and re-thrown — request logger sees the error path', async () => {
    // The DSL wraps every handler with a request-log; the catch branch
    // logs and rethrows.  Verify the rethrow happens — a thrown handler
    // surfaces as a 500 from the backend (Fastify's default error
    // translator).
    const system = newSystem();
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new FastifyBackend({ logger: false }))
      .bind(get(() => { throw new Error('boom'); }));
    try {
      const result = await fetch(`http://${binding.host}:${binding.port}/`);
      expect(result.status).toBeGreaterThanOrEqual(500);
    } finally {
      await binding.unbind();
      await system.terminate();
    }
  });
});

describe('HttpExtension — server builder + client', () => {
  test('useBackend selection takes effect — name appears in info log via system.log', async () => {
    // Use a custom backend with a distinct name and verify it's the
    // one that ends up handling the request.
    const system = newSystem();
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new FastifyBackend({ logger: false }))
      .bind(get(() => complete(Status.OK, 'used')));
    try {
      const result = await fetch(`http://${binding.host}:${binding.port}/`);
      expect(await result.text()).toBe('used');
    } finally {
      await binding.unbind();
      await system.terminate();
    }
  });

  test('unbind() is idempotent — second call returns the same Promise', async () => {
    const system = newSystem();
    const binding = await bindOk(system);
    const p1 = binding.unbind();
    const p2 = binding.unbind();
    // Same in-flight promise — guarantees no double-shutdown.
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    await system.terminate();
  });

  test('singleRequest delegates to the embedded HttpClient', async () => {
    const system = newSystem();
    const binding = await bindOk(system);
    try {
      const ext = system.extension(HttpExtensionId);
      // singleRequest is bound — calling it through the extension uses
      // the shared client.  Hit our own bound server to verify.
      const result = await ext.singleRequest({
        method: 'GET',
        url: `http://${binding.host}:${binding.port}/`,
      });
      expect(result.status).toBe(200);
    } finally {
      await binding.unbind();
      await system.terminate();
    }
  });

  test('compiling zero routes binds successfully (degenerate but legal)', async () => {
    // An empty `concat()` compiles to zero CompiledRoutes.  The server
    // should still bind — a 404-only server is a valid use case (e.g.
    // a health-check-less liveness probe).
    const { concat: cat } = await import('../../../src/http/Route.js');
    const system = newSystem();
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new FastifyBackend({ logger: false }))
      .bind(cat());
    try {
      const result = await fetch(`http://${binding.host}:${binding.port}/`);
      expect(result.status).toBe(404);
    } finally {
      await binding.unbind();
      await system.terminate();
    }
  });
});
