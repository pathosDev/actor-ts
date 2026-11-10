import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ManagementRoutesOptions, managementRoutes } from '../../../src/management/index.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * The `actor-ts.management` block reaching the route tree (#882).
 *
 * `managementRoutes` already had the `ActorSystem` in hand, so nothing new is
 * threaded to make this work — but the layering is what has to be checked, not
 * the reading: the reader is covered in
 * `tests/unit/config/ManagementConfigDefaults.test.ts`, and what is left is
 * whether a file's value actually moves an endpoint, whether an explicit
 * option still outranks it, and whether the validator runs on the *merged*
 * settings rather than on whichever layer supplied them.
 *
 * The probe paths are driven end to end over a bound server rather than by
 * inspecting the returned `Route`: a segment holding a slash is a perfectly
 * well-formed `Route` node, and the whole defect it causes is that no request
 * ever matches it.  Only a request can tell the two apart.
 */

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
});

/** A system whose config layer is the given HOCON, over `reference.conf`. */
function systemWith(hocon: string, name = 'probe-paths'): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon));
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  return system;
}

describe('probe paths come from the management block', () => {
  test('a configured readiness path moves the endpoint, and the old one stops answering', async () => {
    const system = systemWith('actor-ts.management.readiness-path = "serving"');
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(managementRoutes(system, null));

    const moved = await fetch(`http://127.0.0.1:${binding.port}/serving`);
    expect(moved.status).toBe(200);
    expect((await moved.json() as { status: string }).status).toBe('UP');

    // The point of the assertion: the endpoint MOVED rather than being added.
    // A reader that merged instead of replacing would leave both answering and
    // nothing here would notice.
    expect((await fetch(`http://127.0.0.1:${binding.port}/ready`)).status).toBe(404);
    // …and the liveness probe the file said nothing about is untouched.
    expect((await fetch(`http://127.0.0.1:${binding.port}/health`)).status).toBe(200);

    await binding.unbind();
  });

  test('an explicit option outranks the configured path', async () => {
    const system = systemWith('actor-ts.management.liveness-path = "from-config"', 'probe-explicit');
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(managementRoutes(system, null, { livenessPath: 'from-code' }));

    expect((await fetch(`http://127.0.0.1:${binding.port}/from-code`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${binding.port}/from-config`)).status).toBe(404);

    await binding.unbind();
  });

  test('an option object that names other fields does not blank the configured path', async () => {
    // The `mergeOptions` rule, at the seam that would break it: a caller who
    // sets a toggle must not drag an `undefined` livenessPath along and shadow
    // the file underneath.
    const system = systemWith('actor-ts.management.liveness-path = "alive"', 'probe-fallthrough');
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(managementRoutes(system, null, { enableMetricsEndpoint: false }));

    expect((await fetch(`http://127.0.0.1:${binding.port}/alive`)).status).toBe(200);

    await binding.unbind();
  });

  test('a configured path containing a slash is refused before anything binds', () => {
    // Refused rather than accepted-and-inert.  `path()` strips surrounding
    // slashes only, so this would otherwise become one segment holding a slash
    // that matches no URL — the endpoint would vanish with no error at all,
    // and the first thing to notice would be a load balancer draining the pod.
    const system = systemWith('actor-ts.management.readiness-path = "k8s/ready"', 'probe-slash');
    expect(() => managementRoutes(system, null)).toThrow(OptionsError);
  });
});

describe('endpoint toggles come from the management block', () => {
  test('a configured metrics endpoint is served without a line of code', async () => {
    const system = systemWith(`
      actor-ts.management.enable-metrics-endpoint = true
    `, 'probe-metrics');
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(managementRoutes(system, null));

    const response = await fetch(`http://127.0.0.1:${binding.port}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');

    await binding.unbind();
  });

  test('an explicit false outranks a configured true', async () => {
    const system = systemWith(`
      actor-ts.management.enable-metrics-endpoint = true
    `, 'probe-metrics-off');
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(managementRoutes(system, null, { enableMetricsEndpoint: false }));

    expect((await fetch(`http://127.0.0.1:${binding.port}/metrics`)).status).toBe(404);

    await binding.unbind();
  });

  test('the builder is interchangeable with a plain object, and still outranks the file', async () => {
    // A builder IS its options — `set` writes own enumerable properties — so
    // it reaches `mergeOptions` as the explicit layer exactly as a plain
    // object does.  Worth one assertion because the builder is the documented
    // primary style, and because a `Partial<T>` cast that dropped the
    // prototype's fields would look identical to this from the outside.
    const system = systemWith(`
      actor-ts.management {
        enable-metrics-endpoint = false
        liveness-path = "from-config"
      }
    `, 'probe-builder');
    const managementOptions = ManagementRoutesOptions.create()
      .withMetricsEndpoint(true)
      .withLivenessPath('from-builder')
      .withReadinessPath('ready');
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(managementRoutes(system, null, managementOptions));

    expect((await fetch(`http://127.0.0.1:${binding.port}/from-builder`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${binding.port}/from-config`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${binding.port}/metrics`)).status).toBe(200);

    await binding.unbind();
  });

  test('the shipped defaults leave every mutating endpoint off', async () => {
    // The block ships `false` for all four; a system that configures nothing
    // must behave exactly as it did before the block existed.
    const system = systemWith('actor-ts.system.name = untouched', 'probe-defaults');
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(managementRoutes(system, null));

    expect((await fetch(`http://127.0.0.1:${binding.port}/metrics`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${binding.port}/health`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${binding.port}/ready`)).status).toBe(200);

    await binding.unbind();
  });
});
