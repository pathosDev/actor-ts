/**
 * #1466 — a value in `actor-ts.metrics` the registry refuses is refused naming
 * the key it came from, and reported once per system.
 *
 * The registry's validator names the field, `maxSeriesPerFamily`: the right
 * word for a value written in code, and no help to an operator looking at a
 * config file.  And two framework callers switch metrics on with a bare
 * `enable()` and never see what it throws — DevTools, and the worker-mesh
 * relay inside every worker, whose transport drops the frame with a warning
 * that names neither the key nor the error.  So a cap the validator refuses
 * used to switch every worker's metrics off with nothing in any log saying
 * why.  The relay asks on every tick, which is why the report is once.
 *
 * What does not change is pinned beside it: the refusal is still thrown, still
 * an `OptionsError` exactly as the same value in code is, and a value passed
 * in code is still reported under its field and logs nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { LogLevel } from '../../../src/Logger.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { MetricsRegistryOptions } from '../../../src/metrics/MetricsRegistryOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

const CAP_KEY = 'actor-ts.metrics.max-series-per-family';

const systems: ActorSystem[] = [];
afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

function systemWith(hocon: string, logger: RecordingLogger): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Info)
    .withConfig(Config.parseString(hocon));
  const system = ActorSystem.create(`metrics-refusal-${systems.length}`, systemOptions);
  systems.push(system);
  return system;
}

/** What `attempt` threw; fails the case when it threw nothing. */
function refusalOf(attempt: () => unknown): Error {
  let caught: unknown = null;
  try { attempt(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

function errorsLogged(logger: RecordingLogger): ReadonlyArray<string> {
  return logger.records.filter((record) => record.level === 'error').map((record) => record.message);
}

describe('a refused actor-ts.metrics value (#1466)', () => {
  test('a cap the validator refuses names its key on every enable(), and is logged once', () => {
    const logger = new RecordingLogger();
    const system = systemWith(`${CAP_KEY} = -1`, logger);
    const metrics = system.extension(MetricsExtensionId);

    // What the relay does inside a worker: a bare enable() on every request.
    for (let request = 0; request < 3; request++) {
      const refusal = refusalOf(() => metrics.enable());
      expect(refusal).toBeInstanceOf(OptionsError);
      expect(refusal.message).toStartWith(`${CAP_KEY}: `);
      expect(refusal.message).toContain('(got -1)');
    }

    expect(metrics.isEnabled()).toBe(false);
    const errors = errorsLogged(logger);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${CAP_KEY}: `);
  });

  test('a cap the reader refuses is logged once too', () => {
    const logger = new RecordingLogger();
    const system = systemWith(`${CAP_KEY} = 2.5`, logger);
    const metrics = system.extension(MetricsExtensionId);

    for (let request = 0; request < 3; request++) {
      expect(refusalOf(() => metrics.enable())).toBeInstanceOf(ConfigError);
    }

    const errors = errorsLogged(logger);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(CAP_KEY);
  });

  test('enablePromClient refuses the same cap the same way, and installs nothing', () => {
    const logger = new RecordingLogger();
    const system = systemWith(`${CAP_KEY} = -1`, logger);
    const metrics = system.extension(MetricsExtensionId);
    // Never touched: the cap is refused before the bridge reaches prom-client.
    const untouchedClient = {} as never;
    const untouchedRegistry = {} as never;

    const refusal = refusalOf(() => metrics.enablePromClient({ client: untouchedClient, registry: untouchedRegistry }));

    expect(refusal).toBeInstanceOf(OptionsError);
    expect(refusal.message).toStartWith(`${CAP_KEY}: `);
    expect(metrics.isEnabled()).toBe(false);
    expect(errorsLogged(logger)).toHaveLength(1);
  });

  test('a bad cap passed in code is refused under its field, as before, and logs nothing', () => {
    const logger = new RecordingLogger();
    const system = systemWith('', logger);
    const metricsOptions = MetricsRegistryOptions.create().withMaxSeriesPerFamily(-1);

    const refusal = refusalOf(() => system.extension(MetricsExtensionId).enable(metricsOptions));

    expect(refusal).toBeInstanceOf(OptionsError);
    expect(refusal.message).toStartWith('MetricsRegistryOptions: maxSeriesPerFamily ');
    expect(errorsLogged(logger)).toEqual([]);
  });

  test('an explicit cap still outranks a refused HOCON one: nothing is refused, nothing logged', () => {
    // Validation runs on the merged settings, as everywhere else: the file's
    // value is not in them when code sets the field.
    const logger = new RecordingLogger();
    const system = systemWith(`${CAP_KEY} = -1`, logger);
    const metricsOptions = MetricsRegistryOptions.create().withMaxSeriesPerFamily(50);

    system.extension(MetricsExtensionId).enable(metricsOptions);

    expect(system.extension(MetricsExtensionId).isEnabled()).toBe(true);
    expect(errorsLogged(logger)).toEqual([]);
  });
});
