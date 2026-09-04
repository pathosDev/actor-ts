/**
 * `actor-ts.backoff-supervisor.*` — the config front-end to
 * `BackoffSupervisor` (#865).
 *
 * **Why this file exists rather than leaning on `NoDeadConfigKeys`.**  That
 * guard is textual: a leaf passes when *some* file under `src/` contains
 * `ConfigKeys.<group>` and the substring `.<leafProperty>`.  Every one of
 * `.minBackoff`, `.maxBackoff`, `.randomFactor`, `.maxStashSize` and
 * `.resetCounter` already appeared in `BackoffSupervisor.ts` as an ordinary
 * option-field read before this block existed, so binding
 * `ConfigKeys.backoffSupervisor` anywhere in that file would have satisfied it
 * for all five without one `config.get*` call.  The round-trip below is the
 * check that cannot be satisfied by a mention.
 *
 * Every case uses `Config.parseString(...)`, never
 * `Config.fromObject({'actor-ts.x.y': …})`: a dotted string stays a literal
 * top-level key there, `hasPath` then resolves the nested reference.conf value
 * instead, and the test silently asserts nothing.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { LocalActorRef } from '../../../src/internal/LocalActorRef.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { stoppingStrategy } from '../../../src/Supervision.js';
import { BackoffSupervisor } from '../../../src/pattern/BackoffSupervisor.js';
import {
  BackoffSupervisorOptions,
  BackoffSupervisorOptionsValidator,
  DEFAULT_BACKOFF_FORWARD,
  DEFAULT_BACKOFF_MAX_MS,
  DEFAULT_BACKOFF_MAX_STASH_SIZE,
  DEFAULT_BACKOFF_MIN_MS,
  DEFAULT_BACKOFF_RANDOM_FACTOR,
  DEFAULT_BACKOFF_RESET_COUNTER,
  DEFAULT_BACKOFF_TRIGGER_ON,
  readBackoffSupervisorOptionsFromConfig,
  withBackoffSupervisorConfigDefaults,
} from '../../../src/pattern/BackoffSupervisorOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/** A config carrying only the given `actor-ts.backoff-supervisor` body. */
function blockConfig(body: string): Config {
  return Config.parseString(`actor-ts { backoff-supervisor { ${body} } }`);
}

describe('readBackoffSupervisorOptionsFromConfig', () => {
  test('reads every leaf the block publishes', () => {
    const config = blockConfig(`
      min-backoff    = 1s
      max-backoff    = 45s
      random-factor  = 0.5
      max-stash-size = 7
      reset-counter  = "never"
      forward        = "drop"
      trigger-on     = "failure"
    `);

    expect(readBackoffSupervisorOptionsFromConfig(config)).toEqual({
      minBackoff: 1_000,
      maxBackoff: 45_000,
      randomFactor: 0.5,
      maxStashSize: 7,
      resetCounter: 'never',
      forward: 'drop',
      triggerOn: 'failure',
    });
  });

  test('reset-counter is one leaf with three readings', () => {
    // The raw value decides which reader applies, not the key — the shape
    // `worker-cluster.workers` uses for `"auto"` versus a count.
    expect(readBackoffSupervisorOptionsFromConfig(blockConfig('reset-counter = "never"')).resetCounter)
      .toBe('never');
    expect(readBackoffSupervisorOptionsFromConfig(blockConfig('reset-counter = "after-min-stable"')).resetCounter)
      .toBe('after-min-stable');
    expect(readBackoffSupervisorOptionsFromConfig(blockConfig('reset-counter = 90s')).resetCounter)
      .toEqual({ kind: 'after-time', ms: 90_000 });
  });

  test('an absent leaf stays absent instead of being filled with its default', () => {
    // This is what lets `mergeOptions` layer the three sources per field
    // rather than per block: a reader that punched in its own defaults would
    // shadow the built-in layer with a copy of itself and, worse, shadow an
    // explicit option with a value nobody wrote.
    const read = readBackoffSupervisorOptionsFromConfig(blockConfig('min-backoff = 1s'));

    expect(Object.keys(read)).toEqual(['minBackoff']);
    expect(readBackoffSupervisorOptionsFromConfig(Config.empty())).toEqual({});
  });

  test('the published defaults round-trip to the constants they are published from', () => {
    // `DocumentedDefaults` compares the literals in `REFERENCE_CONF` to the
    // same constants, but through its own accessor table.  This reads them the
    // way the framework does — a `reset-counter` typed as a duration or a
    // `random-factor` read with `getInt` fails here and nowhere else.
    expect(readBackoffSupervisorOptionsFromConfig(Config.parseString(REFERENCE_CONF))).toEqual({
      minBackoff: DEFAULT_BACKOFF_MIN_MS,
      maxBackoff: DEFAULT_BACKOFF_MAX_MS,
      randomFactor: DEFAULT_BACKOFF_RANDOM_FACTOR,
      maxStashSize: DEFAULT_BACKOFF_MAX_STASH_SIZE,
      resetCounter: DEFAULT_BACKOFF_RESET_COUNTER,
      forward: DEFAULT_BACKOFF_FORWARD,
      triggerOn: DEFAULT_BACKOFF_TRIGGER_ON,
    });
  });
});

class Idle extends Actor<unknown> {
  override onReceive(): void { /* nothing to do */ }
}

describe('withBackoffSupervisorConfigDefaults', () => {
  test('falls back to the built-in defaults with nothing configured', () => {
    const merged = withBackoffSupervisorConfigDefaults({ child: Idle }, Config.empty());

    expect(merged.minBackoff).toBe(DEFAULT_BACKOFF_MIN_MS);
    expect(merged.maxBackoff).toBe(DEFAULT_BACKOFF_MAX_MS);
    expect(merged.randomFactor).toBe(DEFAULT_BACKOFF_RANDOM_FACTOR);
    expect(merged.maxStashSize).toBe(DEFAULT_BACKOFF_MAX_STASH_SIZE);
    expect(merged.resetCounter).toBe(DEFAULT_BACKOFF_RESET_COUNTER);
    expect(merged.forward).toBe(DEFAULT_BACKOFF_FORWARD);
    expect(merged.triggerOn).toBe(DEFAULT_BACKOFF_TRIGGER_ON);
  });

  test('the config file outranks the built-in defaults', () => {
    const merged = withBackoffSupervisorConfigDefaults(
      { child: Idle },
      blockConfig('min-backoff = 3s\nforward = "drop"'),
    );

    expect(merged.minBackoff).toBe(3_000);
    expect(merged.forward).toBe('drop');
    // …and only those two: the rest still comes from the built-in layer.
    expect(merged.maxBackoff).toBe(DEFAULT_BACKOFF_MAX_MS);
    expect(merged.triggerOn).toBe(DEFAULT_BACKOFF_TRIGGER_ON);
  });

  test('explicit options outrank the config file, per field', () => {
    const merged = withBackoffSupervisorConfigDefaults(
      { child: Idle, minBackoff: 25, triggerOn: 'stop' },
      blockConfig('min-backoff = 3s\nmax-backoff = 9s\ntrigger-on = "failure"'),
    );

    expect(merged.minBackoff).toBe(25);
    expect(merged.triggerOn).toBe('stop');
    // Per field, not per block: `max-backoff` was not set in code, so the
    // config value survives beside the two that were overridden.
    expect(merged.maxBackoff).toBe(9_000);
  });

  test('an option left undefined does not shadow the config file', () => {
    // `undefined` on a higher layer means "not set", never "explicitly
    // clear" — a destructured default or a spread partial would otherwise
    // blank out the config underneath it.
    const merged = withBackoffSupervisorConfigDefaults(
      { child: Idle, minBackoff: undefined },
      blockConfig('min-backoff = 3s'),
    );

    expect(merged.minBackoff).toBe(3_000);
  });
});

describe('BackoffSupervisorOptions (the builder)', () => {
  test('records only the fields it was given, so it never competes with config', () => {
    const supervisorOptions = BackoffSupervisorOptions.create<unknown>()
      .withChild(Idle)
      .withMinBackoff(25);

    // A builder *is* its options: `set` writes own enumerable properties and
    // the `withX` methods stay on the prototype, so a spread sees the two
    // fields and nothing else.  That is what makes the unset ones fall
    // through to HOCON rather than shadowing it with `undefined`.
    expect(Object.keys({ ...supervisorOptions })).toEqual(['child', 'minBackoff']);

    const merged = withBackoffSupervisorConfigDefaults(
      { ...supervisorOptions },
      blockConfig('min-backoff = 3s\nmax-backoff = 9s'),
    );
    expect(merged.minBackoff).toBe(25);
    expect(merged.maxBackoff).toBe(9_000);
  });

  test('a full chain reaches every field the plain object has', () => {
    const clock = (): number => 7;
    const policy = { delayFor: (): number => 1 };
    const supervisorOptions = BackoffSupervisorOptions.create<unknown>()
      .withChild(Idle)
      .withChildOptions({ displayName: 'inner' })
      .withChildName('worker')
      .withMinBackoff(5)
      .withMaxBackoff(50)
      .withRandomFactor(0.5)
      .withPolicy(policy)
      .withResetCounter('never')
      .withForward('drop')
      .withTriggerOn('failure')
      .withMaxStashSize(3)
      .withDrainGraceMs(0)
      .withForwardDuringGrace(false)
      .withClock(clock);

    expect({ ...supervisorOptions }).toEqual({
      child: Idle,
      childOptions: { displayName: 'inner' },
      childName: 'worker',
      minBackoff: 5,
      maxBackoff: 50,
      randomFactor: 0.5,
      policy,
      resetCounter: 'never',
      forward: 'drop',
      triggerOn: 'failure',
      maxStashSize: 3,
      drainGraceMs: 0,
      forwardDuringGrace: false,
      clock,
    });
    expect(() => new BackoffSupervisorOptionsValidator().validate({ ...supervisorOptions })).not.toThrow();
  });
});

function systemWith(config: ConfigObject, name: string): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(config);
  return ActorSystem.create(name, options);
}

/** Stops itself cleanly on the first message, so `trigger-on` decides the rest. */
let selfStops = 0;
let selfStopSpawns = 0;

class SelfStopping extends Actor<{ kind: 'stop' }> {
  constructor() { super(); selfStopSpawns += 1; }
  override onReceive(): void {
    selfStops += 1;
    this.context.stop(this.self);
  }
}

/**
 * The half a reader test cannot reach: that the merged value is what the
 * message loop actually runs on.  `trigger-on` is the leaf chosen for it
 * because its two outcomes are structural — a live supervisor or a stopped
 * one — so nothing here depends on a timer firing inside a margin.
 */
describe('a configured supervisor behaves as configured', () => {
  test('trigger-on = "failure" from config stops the supervisor on a clean child stop', async () => {
    selfStops = 0; selfStopSpawns = 0;
    const system = systemWith(
      { 'actor-ts': { 'backoff-supervisor': { 'trigger-on': 'failure' } } },
      'backoff-config-trigger-on',
    );
    const supervisor = system.spawn(
      BackoffSupervisor.factory({ child: SelfStopping }),
      'from-config',
    );

    supervisor.tell({ kind: 'stop' });
    await awaitCondition(() => selfStops === 1, { label: 'the child stopped itself' });
    await awaitCondition(
      () => (supervisor as unknown as LocalActorRef).getCell().isTerminated(),
      { timeoutMs: 4_000, label: 'the supervisor stopped rather than respawning' },
    );
    expect(selfStopSpawns).toBe(1);
    await system.terminate();
  }, 5_000);

  test('an explicit triggerOn wins over the same key in the config file', async () => {
    // Same config as above, opposite outcome — which is the assertion: the
    // explicit layer reaches the message loop, not just the merge function.
    selfStops = 0; selfStopSpawns = 0;
    const system = systemWith(
      { 'actor-ts': { 'backoff-supervisor': { 'trigger-on': 'failure', 'min-backoff': '10ms' } } },
      'backoff-config-trigger-on-override',
    );
    const supervisor = system.spawn(
      BackoffSupervisor.factory({ child: SelfStopping, triggerOn: 'any' }),
      'explicit-wins',
    );

    supervisor.tell({ kind: 'stop' });
    await awaitCondition(() => selfStopSpawns === 2, {
      timeoutMs: 4_000,
      label: 'the supervisor respawned the child despite the configured trigger-on',
    });
    expect((supervisor as unknown as LocalActorRef).getCell().isTerminated()).toBe(false);
    await system.terminate();
  }, 5_000);

  test('an out-of-range value from the config file fails the supervisor at start', async () => {
    // The point of validating the *merged* settings: a bad number in
    // application.conf is refused by the same rule as a bad one in code, and
    // it is refused before a child exists to run under it.
    selfStopSpawns = 0;
    const system = systemWith(
      { 'actor-ts': { 'backoff-supervisor': { 'random-factor': 4 } } },
      'backoff-config-invalid',
    );
    const supervisor = system.spawn(
      BackoffSupervisor.factory({ child: SelfStopping }),
      'invalid-from-config',
      { supervisorStrategy: stoppingStrategy },
    );

    await awaitCondition(
      () => (supervisor as unknown as LocalActorRef).getCell().isTerminated(),
      { timeoutMs: 4_000, label: 'the supervisor failed to start' },
    );
    expect(selfStopSpawns).toBe(0);
    await system.terminate();
  }, 5_000);
});

describe('a bogus value from config is rejected exactly like a bogus one in code', () => {
  test.each([
    ['forward', 'forward = "sometimes"'],
    ['triggerOn', 'trigger-on = "whenever"'],
    ['randomFactor', 'random-factor = 4'],
    ['maxStashSize', 'max-stash-size = 0'],
    ['minBackoff', 'min-backoff = 0ms'],
    ['maxBackoff', 'min-backoff = 5s\nmax-backoff = 1s'],
    ['resetCounter.ms', 'reset-counter = -3ms'],
  ])('%s', (field, body) => {
    // The merge is deliberately permissive; the supervisor validates what it
    // returns.  Assert through the same two steps, so a rule that only ever
    // ran on the code path would show up as a config value sailing through.
    const merged = withBackoffSupervisorConfigDefaults({ child: Idle }, blockConfig(body));
    let thrown: unknown;
    try {
      new BackoffSupervisorOptionsValidator().validate(merged);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OptionsError);
    expect((thrown as OptionsError).field).toBe(field);
  });
});
