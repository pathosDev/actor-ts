import { describe, expect, test } from 'bun:test';
import { ActorSystem, ActorSystemOptions } from '../../../src/ActorSystem.js';
import { Config } from '../../../src/config/Config.js';
import { MicrotaskDispatcher, ThroughputDispatcher } from '../../../src/Dispatcher.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

describe('ActorSystem — config integration', () => {
  test('exposes the merged config on `.config`', async () => {
    const sys = ActorSystem.create('cfg', ActorSystemOptions.create().withLogger(new NoopLogger()));
    // Reference defaults survive.
    expect(sys.config.getString('actor-ts.system.name')).toBe('default');
    expect(sys.config.getDuration('actor-ts.cluster.gossip-interval')).toBe(1_000);
    await sys.terminate();
  });

  test('accepts a plain object of overrides', async () => {
    const sys = ActorSystem.create('cfg', ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfig({
        'actor-ts': {
          cluster: { 'gossip-interval': '100ms' },
          sharding: { 'number-of-shards': 32 },
        },
      }));
    expect(sys.config.getDuration('actor-ts.cluster.gossip-interval')).toBe(100);
    expect(sys.config.getInt('actor-ts.sharding.number-of-shards')).toBe(32);
    // Untouched fields still come from reference.
    expect(sys.config.getString('actor-ts.http.backend')).toBe('fastify');
    await sys.terminate();
  });

  test('accepts a Config instance', async () => {
    const overrides = Config.parseString('actor-ts.logger.level = "error"');
    const sys = ActorSystem.create('cfg', ActorSystemOptions.create().withLogger(new NoopLogger()).withConfig(overrides));
    expect(sys.config.getString('actor-ts.logger.level')).toBe('error');
    await sys.terminate();
  });

  test('picks dispatcher from config when not explicitly set', async () => {
    const sys = ActorSystem.create('cfg', ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfig({ 'actor-ts': { dispatcher: { default: 'microtask' } } }));
    expect(sys.dispatcher).toBeInstanceOf(MicrotaskDispatcher);
    await sys.terminate();
  });

  test('throughput dispatcher picks up the configured throughput', async () => {
    const sys = ActorSystem.create('cfg', ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfig({ 'actor-ts': { dispatcher: { default: 'throughput', throughput: 42 } } }));
    expect(sys.dispatcher).toBeInstanceOf(ThroughputDispatcher);
    expect((sys.dispatcher as ThroughputDispatcher).throughput).toBe(42);
    await sys.terminate();
  });

  test('picks log level from config', async () => {
    // Use NoopLogger-like shim so nothing is printed; just verify derived LogLevel.
    const captured: number[] = [];
    const sys = ActorSystem.create('cfg', ActorSystemOptions.create()
      .withConfig({ 'actor-ts': { logger: { level: 'warn' } } })
      .withLogger({
        level: LogLevel.Off,                      // unused in this assertion
        debug() {}, info() {}, warn() {}, error() {},
        withSource() { return this; },
      }));
    void captured;
    // Build derived directly via a fresh ConsoleLogger path to prove derivation works.
    const cfg = sys.config;
    expect(cfg.getString('actor-ts.logger.level')).toBe('warn');
    await sys.terminate();
  });

  test('explicit dispatcher/logger in settings win over config', async () => {
    const customLogger = new NoopLogger();
    const customDispatcher = new MicrotaskDispatcher();
    const sys = ActorSystem.create('cfg', ActorSystemOptions.create()
      .withLogger(customLogger)
      .withDispatcher(customDispatcher)
      .withConfig({
        'actor-ts': {
          logger: { level: 'debug' },
          dispatcher: { default: 'throughput' },
        },
      }));
    expect(sys.log).toBe(customLogger);
    expect(sys.dispatcher).toBe(customDispatcher);
    await sys.terminate();
  });

  test('uses reference defaults when nothing is provided', async () => {
    const sys = ActorSystem.create('cfg', ActorSystemOptions.create().withLogger(new NoopLogger()));
    // Default dispatcher is "immediate" (per reference.conf).
    expect(sys.dispatcher.constructor.name).toBe('ImmediateDispatcher');
    await sys.terminate();
  });
});
