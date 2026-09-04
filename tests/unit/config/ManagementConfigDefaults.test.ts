import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import {
  DEFAULT_AUTH_PROTECT_HEALTH,
  DEFAULT_ENABLE_DOWN_ENDPOINT,
  DEFAULT_ENABLE_LEAVE_ENDPOINT,
  DEFAULT_ENABLE_METRICS_ENDPOINT,
  DEFAULT_LIVENESS_PATH,
  DEFAULT_READINESS_PATH,
  ManagementRoutesOptionsValidator,
  readManagementRoutesOptionsFromConfig,
} from '../../../src/management/ManagementRoutesOptions.js';
import {
  DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  HealthCheckRegistryOptionsValidator,
  readHealthCheckRegistryOptionsFromConfig,
} from '../../../src/management/HealthCheckRegistryOptions.js';

/**
 * #882 — before this, everything `managementRoutes` accepts was
 * constructor-only, so flipping an endpoint or moving a probe in a container
 * meant a rebuild.  There was no `actor-ts.management` block at all.
 *
 * Three properties, and the second is the one that is easy to get wrong:
 *
 *   1. the mapping — kebab HOCON leaf to camelCase option field, across two
 *      readers that share one block because their consumers have different
 *      lifetimes (the registry exists from the first `healthChecksOf(system)`,
 *      the route tree from a much later call);
 *   2. "absent means absent" — a key nobody set stays out of the returned
 *      object entirely, or it lands as an explicit `undefined` and shadows the
 *      built-in default underneath it in `mergeOptions`;
 *   3. a configured value faces the same validator a code-set one does, which
 *      matters here because the slash rule is the difference between a probe
 *      that moved and a probe that silently stopped existing.
 *
 * `Config.parseString` throughout, never `Config.fromObject({'actor-ts.x': …})`:
 * the latter keeps the dotted string as a literal top-level key, so `hasPath`
 * would resolve the nested reference.conf value instead and these assertions
 * would be about the shipped defaults rather than about the block under test.
 */

describe('readManagementRoutesOptionsFromConfig', () => {
  test('reads every leaf of the management block', () => {
    const config = Config.parseString(`
      actor-ts.management {
        enable-leave-endpoint   = true
        enable-down-endpoint    = true
        enable-metrics-endpoint = true
        auth-protect-health     = true
        liveness-path  = "alive"
        readiness-path = "serving"
      }
    `);

    expect(readManagementRoutesOptionsFromConfig(config)).toStrictEqual({
      enableLeaveEndpoint: true,
      enableDownEndpoint: true,
      enableMetricsEndpoint: true,
      authProtectHealth: true,
      livenessPath: 'alive',
      readinessPath: 'serving',
    });
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    // `toStrictEqual`, not `toEqual`: the latter ignores properties whose value
    // is `undefined`, so it cannot tell "absent" from "present and undefined" —
    // which is the only thing this test is about.
    expect(readManagementRoutesOptionsFromConfig(Config.parseString('actor-ts.system.name = x')))
      .toStrictEqual({});
  });

  test('a block naming one leaf returns exactly that leaf', () => {
    expect(readManagementRoutesOptionsFromConfig(
      Config.parseString('actor-ts.management.enable-metrics-endpoint = true'),
    )).toStrictEqual({ enableMetricsEndpoint: true });
  });

  test('the two middleware fields are deliberately unreadable from a file', () => {
    // `auth` and `ipAllowlist` are `Middleware` functions, so HOCON cannot
    // express them and a file naming them changes nothing.  That is what makes
    // the block unable to weaken the security wiring rather than merely
    // unlikely to.
    const config = Config.parseString(`
      actor-ts.management {
        auth         = "bearer"
        ip-allowlist = ["10.0.0.0/8"]
      }
    `);
    expect(readManagementRoutesOptionsFromConfig(config)).toStrictEqual({});
  });

  test('the shipped reference.conf resolves to the documented defaults', () => {
    // Locks the published values to the reader: a rename on either side turns
    // into a failure here rather than into a key that quietly stops applying.
    expect(readManagementRoutesOptionsFromConfig(Config.parseString(REFERENCE_CONF))).toStrictEqual({
      enableLeaveEndpoint: DEFAULT_ENABLE_LEAVE_ENDPOINT,
      enableDownEndpoint: DEFAULT_ENABLE_DOWN_ENDPOINT,
      enableMetricsEndpoint: DEFAULT_ENABLE_METRICS_ENDPOINT,
      authProtectHealth: DEFAULT_AUTH_PROTECT_HEALTH,
      livenessPath: DEFAULT_LIVENESS_PATH,
      readinessPath: DEFAULT_READINESS_PATH,
    });
  });
});

describe('readHealthCheckRegistryOptionsFromConfig', () => {
  test('reads the deadline and drops the unit suffix the field keeps', () => {
    expect(readHealthCheckRegistryOptionsFromConfig(
      Config.parseString('actor-ts.management.health-checks.check-timeout = 250ms'),
    )).toStrictEqual({ checkTimeoutMs: 250 });
  });

  test('an absent key stays absent rather than shadowing the built-in default', () => {
    expect(readHealthCheckRegistryOptionsFromConfig(Config.parseString('actor-ts.system.name = x')))
      .toStrictEqual({});
  });

  test('the shipped reference.conf resolves to the documented default', () => {
    expect(readHealthCheckRegistryOptionsFromConfig(Config.parseString(REFERENCE_CONF)))
      .toStrictEqual({ checkTimeoutMs: DEFAULT_HEALTH_CHECK_TIMEOUT_MS });
  });
});

describe('the management block goes through the same rules as code', () => {
  test('a probe path containing a slash is refused, naming the field', () => {
    // `path(segment, child)` normalises with `stripSurrounding(segment, '/')`,
    // which strips SURROUNDING slashes only.  So "k8s/ready" would be stored
    // as one segment holding a slash, match no URL segment ever, and take the
    // endpoint out of existence without an error anywhere.
    const settings = {
      ...readManagementRoutesOptionsFromConfig(
        Config.parseString('actor-ts.management.readiness-path = "k8s/ready"'),
      ),
    };
    let thrown: OptionsError | undefined;
    try {
      new ManagementRoutesOptionsValidator().validate(settings);
    } catch (error) {
      thrown = error as OptionsError;
    }
    expect(thrown).toBeInstanceOf(OptionsError);
    expect(thrown?.field).toBe('readinessPath');
    expect(thrown?.message).toContain('single path segment');
  });

  test('an empty probe path is refused too', () => {
    expect(() => new ManagementRoutesOptionsValidator().validate({ livenessPath: '' }))
      .toThrow(OptionsError);
  });

  test('a segment without a slash passes, and so does an unset one', () => {
    expect(() => new ManagementRoutesOptionsValidator().validate({ livenessPath: 'alive' }))
      .not.toThrow();
    expect(() => new ManagementRoutesOptionsValidator().validate({})).not.toThrow();
  });

  test('a non-positive check timeout is refused', () => {
    // `0` would expire before any check could answer, so every probe would
    // report every check as timed out; there is no "disabled" reading of it.
    expect(() => new HealthCheckRegistryOptionsValidator().validate({ checkTimeoutMs: 0 }))
      .toThrow(OptionsError);
    expect(() => new HealthCheckRegistryOptionsValidator().validate({ checkTimeoutMs: 1 }))
      .not.toThrow();
    expect(() => new HealthCheckRegistryOptionsValidator().validate({})).not.toThrow();
  });
});

describe('ConfigKeys.management', () => {
  test('every leaf is spelled out, not covered by a block root', () => {
    // An exact pin rather than a spot check.  `NoDeadConfigKeys`'
    // `coveringAccessor` falls back to "a config root above it", so a bare
    // `management: 'actor-ts.management'` would satisfy the reachability guard
    // for every leaf beneath it whether or not any reader read it — a whole
    // block could ship inert with the suite green.  The full dotted paths are
    // what make that guard check the leaves, so their shape is asserted here.
    expect(ConfigKeys.management).toEqual({
      enableLeaveEndpoint: 'actor-ts.management.enable-leave-endpoint',
      enableDownEndpoint: 'actor-ts.management.enable-down-endpoint',
      enableMetricsEndpoint: 'actor-ts.management.enable-metrics-endpoint',
      authProtectHealth: 'actor-ts.management.auth-protect-health',
      livenessPath: 'actor-ts.management.liveness-path',
      readinessPath: 'actor-ts.management.readiness-path',
      healthChecks: {
        checkTimeout: 'actor-ts.management.health-checks.check-timeout',
      },
    });
  });

  test('auth and ipAllowlist have no path at all', () => {
    // Structural, not conventional: there is no leaf for either, so a config
    // file cannot name the two knobs that decide who reaches the endpoints.
    expect(Object.keys(ConfigKeys.management)).not.toContain('auth');
    expect(Object.keys(ConfigKeys.management)).not.toContain('ipAllowlist');
  });
});
