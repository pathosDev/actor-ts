/**
 * #997 — one drain semantics on every backend, a non-zero default, and a
 * readiness probe that says "draining" while the shutdown pipeline runs.
 *
 * Before the fix the same `shutdown-grace-period` meant three things: Fastify
 * and Hono killed live sockets at `0`, Express waited a hidden second, and Hono
 * under Bun never waited at all — its graceful stop returned before the
 * requests it was meant to wait for had finished.  The shipped default was
 * `0`, so a rolling deploy severed every request in flight.
 *
 * A request "in flight" here is one whose handler has been entered and is
 * still working: the handler signals as it starts, so the shutdown begins at a
 * known point rather than after a guessed delay.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { CoordinatedShutdownId, Phases } from '../../../src/CoordinatedShutdown.js';
import { DEFAULT_HTTP_SHUTDOWN_GRACE_PERIOD_MS } from '../../../src/http/Constants.js';
import { HttpExtensionId, readHttpShutdownGracePeriodFromConfig } from '../../../src/http/HttpExtension.js';
import { complete, concat, get, path, type Route } from '../../../src/http/Route.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { Status } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { healthChecksOf, managementRoutes } from '../../../src/management/index.js';

const BACKENDS = ['fastify', 'express', 'hono'] as const;
type BackendName = typeof BACKENDS[number];

/** How long the slow handler works once entered — long enough to start a shutdown inside it. */
const HANDLER_WORK_MS = 600;

const systems: ActorSystem[] = [];
afterEach(async () => {
  while (systems.length) await systems.pop()!.terminate();
});

function systemOn(backend: BackendName, hocon = ''): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(`actor-ts.http.backend = ${backend}\n${hocon}`));
  const system = ActorSystem.create(`shutdown-drain-${backend}`, options);
  systems.push(system);
  return system;
}

/** A route that signals when its handler is entered, then answers after {@link HANDLER_WORK_MS}. */
function slowRoute(): { route: Route; entered: Promise<void> } {
  let signal!: () => void;
  const entered = new Promise<void>((resolve) => { signal = resolve; });
  const route = path('slow', get(async () => {
    signal();
    await new Promise<void>((resolve) => setTimeout(resolve, HANDLER_WORK_MS)); // the handler's own work, inside which the shutdown starts
    return complete(Status.OK, 'done');
  }));
  return { route, entered };
}

/** What the client of the in-flight request saw: the status and body, or that the connection was cut. */
async function outcomeOf(response: Promise<Response>): Promise<{ status: number; body: string } | 'severed'> {
  try {
    const answered = await response;
    return { status: answered.status, body: await answered.text() };
  } catch {
    return 'severed';
  }
}

/** Whether a fresh TCP connection to `port` is refused (or reset before it can be used). */
function connectionRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1_000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    socket.once('error', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
  });
}

describe('the shipped default drains rather than severs (#997)', () => {
  test('reference.conf ships a non-zero shutdown-grace-period, the built-in default', () => {
    expect(DEFAULT_HTTP_SHUTDOWN_GRACE_PERIOD_MS).toBeGreaterThan(0);
    expect(readHttpShutdownGracePeriodFromConfig(Config.parseString(REFERENCE_CONF))).toBe(DEFAULT_HTTP_SHUTDOWN_GRACE_PERIOD_MS);
  });

  test('it fits inside service-requests-done\'s default budget, with room for the forced close', () => {
    // The drain is a service-requests-done task: a window as long as the phase
    // budget would time the phase out on every shutdown that had to force.
    const system = ActorSystem.create('shutdown-drain-budget', ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off));
    systems.push(system);
    const budget = system.extension(CoordinatedShutdownId).phaseDefinition(Phases.ServiceRequestsDone)!.timeoutMs;
    expect(DEFAULT_HTTP_SHUTDOWN_GRACE_PERIOD_MS).toBeLessThan(budget);
  });
});

describe.each([...BACKENDS])('one drain semantics on the %s backend (#997)', (backend) => {
  async function bindSlow(): Promise<{ binding: ServerBinding; entered: Promise<void> }> {
    const system = systemOn(backend);
    const { route, entered } = slowRoute();
    const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(route);
    return { binding, entered };
  }

  test('a grace period lets a request in flight finish and receive its response', async () => {
    const { binding, entered } = await bindSlow();
    const response = fetch(`http://127.0.0.1:${binding.port}/slow`);
    await entered;

    await binding.unbind(5_000);

    expect(await outcomeOf(response)).toEqual({ status: 200, body: 'done' });
  });

  test('0 forces at once: the request in flight is cut and unbind does not wait for it', async () => {
    const { binding, entered } = await bindSlow();
    const response = fetch(`http://127.0.0.1:${binding.port}/slow`);
    await entered;

    const startedAt = performance.now();
    await binding.unbind(0);
    const unbindMs = performance.now() - startedAt;

    expect(await outcomeOf(response)).toBe('severed');
    expect(unbindMs).toBeLessThan(HANDLER_WORK_MS / 2);
  });

  test('the shutdown pipeline drains on the shipped default: readiness goes 503, new connections are refused, the request in flight completes', async () => {
    const system = systemOn(backend);
    const { route, entered } = slowRoute();
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(concat(route, managementRoutes(system, null)));
    const ready = await fetch(`http://127.0.0.1:${binding.port}/ready`);
    expect(ready.status).toBe(200);
    await ready.text();

    const events: string[] = [];
    const shutdown = system.extension(CoordinatedShutdownId);
    // Runs once before-service-unbind is over, beside the server's own unbind.
    shutdown.addTask(Phases.ServiceUnbind, 'test-readiness-probe', async () => {
      const readiness = await healthChecksOf(system).checkReadiness();
      if (readiness.some((r) => !r.status)) events.push('readiness-503');
    });

    const response = fetch(`http://127.0.0.1:${binding.port}/slow`);
    await entered;
    const run = shutdown.run();

    const deadline = performance.now() + HANDLER_WORK_MS;
    while (performance.now() < deadline) {
      if (await connectionRefused(binding.port)) { events.push('new-connections-refused'); break; }
    }
    const outcome = await outcomeOf(response);
    events.push('in-flight-completed');
    await run;
    events.push('listener-closed');

    expect(outcome).toEqual({ status: 200, body: 'done' });
    expect(events).toEqual(['readiness-503', 'new-connections-refused', 'in-flight-completed', 'listener-closed']);
  });
});
