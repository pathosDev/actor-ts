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
 * What each backend does with a request in flight — a grace period that lets
 * it finish, `0` that cuts it, the shutdown pipeline that drains it while
 * readiness reports 503 — is part of the shared HTTP backend contract suite
 * (`tests/integration/in-process/http/HttpBackendSuite.ts`, #990).  What is
 * left here is the shipped default itself.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { CoordinatedShutdownId, Phases } from '../../../src/CoordinatedShutdown.js';
import { DEFAULT_HTTP_SHUTDOWN_GRACE_PERIOD_MS } from '../../../src/http/Constants.js';
import { readHttpShutdownGracePeriodFromConfig } from '../../../src/http/HttpExtension.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

const systems: ActorSystem[] = [];
afterEach(async () => {
  while (systems.length) await systems.pop()!.terminate();
});

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
