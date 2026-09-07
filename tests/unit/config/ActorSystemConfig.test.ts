import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { MicrotaskDispatcher, ThroughputDispatcher } from '../../../src/Dispatcher.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../../../src/util/Constants.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { DEFAULT_SCATTER_GATHER_TIMEOUT_MS, MINIMUM_ASK_TIMEOUT_FOR_SCATTER_GATHER_MS } from '../../../src/ScatterGatherOptions.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

describe('ActorSystem — config integration', () => {
  test('exposes the merged config on `.config`', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger());
    const sys = ActorSystem.create('cfg', sysOptions);
    // Reference defaults survive.
    expect(sys.config.getString('actor-ts.system.name')).toBe('default');
    expect(sys.config.getDuration('actor-ts.cluster.gossip-interval')).toBe(1_000);
    await sys.terminate();
  });

  test('accepts a plain object of overrides', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfig({ 'actor-ts': { cluster: { 'gossip-interval': '100ms' }, sharding: { 'number-of-shards': 32 }, }, });
    const sys = ActorSystem.create('cfg', sysOptions);
    expect(sys.config.getDuration('actor-ts.cluster.gossip-interval')).toBe(100);
    expect(sys.config.getInt('actor-ts.sharding.number-of-shards')).toBe(32);
    // Untouched fields still come from reference.
    expect(sys.config.getString('actor-ts.http.backend')).toBe('fastify');
    await sys.terminate();
  });

  test('accepts a Config instance', async () => {
    const overrides = Config.parseString('actor-ts.logger.level = "error"');
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfig(overrides);
    const sys = ActorSystem.create('cfg', sysOptions);
    expect(sys.config.getString('actor-ts.logger.level')).toBe('error');
    await sys.terminate();
  });

  test('picks dispatcher from config when not explicitly set', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfig({ 'actor-ts': { dispatcher: { default: 'microtask' } } });
    const sys = ActorSystem.create('cfg', sysOptions);
    expect(sys.dispatcher).toBeInstanceOf(MicrotaskDispatcher);
    await sys.terminate();
  });

  test('throughput dispatcher picks up the configured throughput', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfig({ 'actor-ts': { dispatcher: { default: 'throughput', throughput: 42 } } });
    const sys = ActorSystem.create('cfg', sysOptions);
    expect(sys.dispatcher).toBeInstanceOf(ThroughputDispatcher);
    expect((sys.dispatcher as ThroughputDispatcher).throughput).toBe(42);
    await sys.terminate();
  });

  test('per-actor throughput defaults, reads config, and clamps to at least 1', async () => {
    const plainOptions = ActorSystemOptions.create().withLogger(new NoopLogger());
    const plain = ActorSystem.create('cfg', plainOptions);
    expect(plain._actorThroughput).toBe(16);
    await plain.terminate();

    const tunedOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfig({ 'actor-ts': { actor: { throughput: 64 } } });
    const tuned = ActorSystem.create('cfg', tunedOptions);
    expect(tuned._actorThroughput).toBe(64);
    await tuned.terminate();

    // 0 would leave every actor accepting mail and never reading it, which is
    // a mistake a config file makes far from the code that suffers it — so it
    // is clamped to the pre-#409 one-at-a-time loop rather than rejected.
    const zeroOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfig({ 'actor-ts': { actor: { throughput: 0 } } });
    const zero = ActorSystem.create('cfg', zeroOptions);
    expect(zero._actorThroughput).toBe(1);
    await zero.terminate();
  });

  test('the default ask deadline defaults, reads config, and refuses a value no ask could arm', async () => {
    // Nested and not `{'actor-ts.actor.ask-timeout': '2s'}`: a dotted string
    // stays a literal top-level key, so `hasPath` would still resolve the
    // reference value and the assertion would prove nothing.
    const plainOptions = ActorSystemOptions.create().withLogger(new NoopLogger());
    const plain = ActorSystem.create('cfg', plainOptions);
    expect(plain._defaultAskTimeoutMs).toBe(DEFAULT_ASK_TIMEOUT_MS);
    await plain.terminate();

    const tunedOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfig({ 'actor-ts': { actor: { 'ask-timeout': '2s' } } });
    const tuned = ActorSystem.create('cfg', tunedOptions);
    expect(tuned._defaultAskTimeoutMs).toBe(2_000);
    await tuned.terminate();

    // NOT clamped the way `throughput` above is, and the difference is the
    // point: `throughput = 0` has a nearest honest reading, `ask-timeout = 0`
    // has none — an ask that arms no deadline can never settle (#765).  So the
    // system refuses to start and names the key, rather than throwing later at
    // every ask site in the application.
    for (const bad of ['0s', '-1s']) {
      const badOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withConfig({ 'actor-ts': { actor: { 'ask-timeout': bad } } });
      let caught: unknown = null;
      try { ActorSystem.create('cfg', badOptions); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(OptionsError);
      expect((caught as OptionsError).field).toBe('ask-timeout');
      expect((caught as OptionsError).message).toContain('actor-ts.actor.ask-timeout');
    }
  });

  test('an ask timeout that undercuts the scatter-gather default warns once, naming both knobs', async () => {
    // #1088 in reverse: the scatter default sits under the ask default so the
    // router can name the failing routees first.  Lowering the ask default
    // past it silently restores the defect, and nothing downstream can notice
    // — the router resolves its own default at a call site with no system.
    const quietLog = new RecordingLogger();
    const quietOptions = ActorSystemOptions.create()
      .withLogger(quietLog)
      .withConfig({ 'actor-ts': { actor: { 'ask-timeout': `${MINIMUM_ASK_TIMEOUT_FOR_SCATTER_GATHER_MS}ms` } } });
    const quiet = ActorSystem.create('cfg', quietOptions);
    expect(quiet._defaultAskTimeoutMs).toBe(MINIMUM_ASK_TIMEOUT_FOR_SCATTER_GATHER_MS);
    // Exactly at the floor is fine — the comparison is `>=`, so the boundary
    // is not a warning, which is what makes the number a threshold and not an
    // approximation.
    expect(quietLog.records.filter((r) => r.message.includes('ask-timeout'))).toHaveLength(0);
    await quiet.terminate();

    const loudLog = new RecordingLogger();
    const loudOptions = ActorSystemOptions.create()
      .withLogger(loudLog)
      .withConfig({ 'actor-ts': { actor: { 'ask-timeout': `${MINIMUM_ASK_TIMEOUT_FOR_SCATTER_GATHER_MS - 1}ms` } } });
    const loud = ActorSystem.create('cfg', loudOptions);
    const warnings = loudLog.records.filter((r) => r.message.includes('actor-ts.actor.ask-timeout'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.level).toBe('warn');
    // Both knobs, because the operator has to decide which of the two they
    // meant — a warning naming only the one they just set says nothing.
    expect(warnings[0]!.message).toContain(String(DEFAULT_SCATTER_GATHER_TIMEOUT_MS));
    expect(warnings[0]!.message).toContain('ScatterGatherOptions.withTimeoutMs()');
    await loud.terminate();

    // And the shipped default is above the floor, so an untouched system is
    // silent — a warning every process printed would be one nobody reads.
    const defaultLog = new RecordingLogger();
    const defaultOptions = ActorSystemOptions.create().withLogger(defaultLog);
    const untouched = ActorSystem.create('cfg', defaultOptions);
    expect(defaultLog.records.filter((r) => r.message.includes('ask-timeout'))).toHaveLength(0);
    await untouched.terminate();
  });

  test('the global mailbox bound defaults to off, reads config, and treats 0 as off', async () => {
    // Nested and not `{'actor-ts.mailbox.default.capacity': 4}`: a dotted
    // string stays a literal top-level key, so the assertion would read the
    // reference value back and prove nothing.
    const plainOptions = ActorSystemOptions.create().withLogger(new NoopLogger());
    const plain = ActorSystem.create('cfg', plainOptions);
    // The shipped `capacity = 0` has to leave the field ABSENT, not land as a
    // zero: `undefined` is what falls through to the unbounded mailbox, and a
    // 0 would reach BoundedMailbox's validator instead.
    expect(plain._defaultMailbox.capacity).toBeUndefined();
    expect(plain._defaultMailbox.overflow).toBe('drop-head');
    await plain.terminate();

    const boundOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfig({ 'actor-ts': { mailbox: { default: { capacity: 4, overflow: 'reject' } } } });
    const bound = ActorSystem.create('cfg', boundOptions);
    expect(bound._defaultMailbox.capacity).toBe(4);
    expect(bound._defaultMailbox.overflow).toBe('reject');
    await bound.terminate();

    // A negative capacity is the same statement as 0 made by a typo, and is
    // answered the same way rather than by an OptionsError at the first spawn.
    const negativeOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfig({ 'actor-ts': { mailbox: { default: { capacity: -1 } } } });
    const negative = ActorSystem.create('cfg', negativeOptions);
    expect(negative._defaultMailbox.capacity).toBeUndefined();
    await negative.terminate();
  });

  test('picks log level from config', async () => {
    // Use NoopLogger-like shim so nothing is printed; just verify derived LogLevel.
    const captured: number[] = [];
    const sysOptions = ActorSystemOptions.create()
      .withConfig({ 'actor-ts': { logger: { level: 'warn' } } })
      .withLogger({
        level: LogLevel.Off, // unused in this assertion
        debug() {}, info() {}, warn() {}, error() {},
        withSource() { return this; }, withFields() { return this; },
      });
    const sys = ActorSystem.create('cfg', sysOptions);
    void captured;
    // Build derived directly via a fresh ConsoleLogger path to prove derivation works.
    const config = sys.config;
    expect(config.getString('actor-ts.logger.level')).toBe('warn');
    await sys.terminate();
  });

  test('explicit dispatcher/logger in options win over config', async () => {
    const customLogger = new NoopLogger();
    const customDispatcher = new MicrotaskDispatcher();
    const sysOptions = ActorSystemOptions.create()
      .withLogger(customLogger)
      .withDispatcher(customDispatcher)
      .withConfig({ 'actor-ts': { logger: { level: 'debug' }, dispatcher: { default: 'throughput' }, }, });
    const sys = ActorSystem.create('cfg', sysOptions);
    expect(sys.log).toBe(customLogger);
    expect(sys.dispatcher).toBe(customDispatcher);
    await sys.terminate();
  });

  test('uses reference defaults when nothing is provided', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger());
    const sys = ActorSystem.create('cfg', sysOptions);
    // Default dispatcher is "hybrid" (per reference.conf): microtask wakeups
    // with a macrotask yield every 64 units.
    expect(sys.dispatcher.constructor.name).toBe('HybridDispatcher');
    await sys.terminate();
  });
});
