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
import { healthChecksOf, SHUTDOWN_READINESS_CHECK_NAME } from '../../../src/management/index.js';

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

describe('a health-check registry first built while a shutdown runs (#997)', () => {
  test('starts out red: the shutdown check is already failing', async () => {
    // The registry is built on first use.  One first asked for once the run
    // is under way missed the before-service-unbind task that would have
    // turned it red, and must not answer ready for the rest of the drain.
    const options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('shutdown-drain-late-registry', options);
    systems.push(system);
    const shutdown = system.extension(CoordinatedShutdownId);
    let readiness: ReadonlyArray<{ name: string; status: boolean }> | undefined;
    // The first access to the registry anywhere in this system, made from
    // inside the run.
    shutdown.addTask(Phases.BeforeServiceUnbind, 'test-late-registry', async () => {
      readiness = await healthChecksOf(system).checkReadiness();
    });

    await shutdown.run();

    expect(readiness).toBeDefined();
    const draining = readiness!.find((result) => result.name === SHUTDOWN_READINESS_CHECK_NAME);
    expect(draining, `readiness carried no shutdown check: ${JSON.stringify(readiness)}`).toBeDefined();
    expect(draining!.status).toBe(false);
  });

  test('built in a phase ahead of before-service-unbind, it carries the shutdown check once', async () => {
    // Red from the moment it is built — and not also registered for the
    // before-service-unbind task, which has not run yet and would add the
    // same check a second time.
    const options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('shutdown-drain-early-registry', options);
    systems.push(system);
    const shutdown = system.extension(CoordinatedShutdownId);
    // Phases with no dependencies run in name order, so this one runs first.
    const earlyPhase = 'a-phase-ahead-of-unbind';
    shutdown.addPhase({ name: earlyPhase, timeoutMs: 5_000, dependsOn: [], recover: true });
    shutdown.addTask(earlyPhase, 'test-early-registry', () => { healthChecksOf(system); });
    let readiness: ReadonlyArray<{ name: string; status: boolean }> | undefined;
    shutdown.addTask(Phases.ServiceUnbind, 'test-read-readiness', async () => {
      readiness = await healthChecksOf(system).checkReadiness();
    });

    await shutdown.run();

    expect(readiness).toBeDefined();
    const shutdownChecks = readiness!.filter((result) => result.name === SHUTDOWN_READINESS_CHECK_NAME);
    expect(shutdownChecks).toEqual([expect.objectContaining({ status: false })]);
  });
});
