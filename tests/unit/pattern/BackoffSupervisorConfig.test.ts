/**
 * `actor-ts.backoff-supervisor.*` — the config front-end to
 * `BackoffSupervisor` (#865).
 *
 * **What this file binds that `NoDeadConfigKeys` does not.**  That gate
 * perturbs each leaf against `readBackoffSupervisorOptionsFromConfig` — this
 * is the suite its registry entry names — and fails one the answer does not
 * move with, so a leaf the reader drops goes red there (#1425).  It never asks
 * which field the leaf lands in or what the supervisor does with it: a
 * `max-stash-size` read into the wrong field still moves the answer.  The
 * round-trip below is the check that pins each leaf to its field and value.
 *
 * Every case uses `Config.parseString(...)`, never
 * `Config.fromObject({'actor-ts.x.y': …})`: a dotted string stays a literal
 * top-level key there, `hasPath` then resolves the nested reference.conf value
 * instead, and the test silently asserts nothing.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { LocalActorRef } from '../../../src/internal/LocalActorRef.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ActorInitializationError, Directive, OneForOneStrategy, stoppingStrategy } from '../../../src/Supervision.js';
import type { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { BackoffSupervisor } from '../../../src/pattern/BackoffSupervisor.js';
import {
  BackoffSupervisorOptions,
  BackoffSupervisorOptionsValidator,
  DEFAULT_BACKOFF_DRAIN_GRACE_MS,
  DEFAULT_BACKOFF_FORWARD,
  DEFAULT_BACKOFF_FORWARD_DURING_GRACE,
  DEFAULT_BACKOFF_MAX_MS,
  DEFAULT_BACKOFF_MAX_STASH_SIZE,
  DEFAULT_BACKOFF_MIN_MS,
  DEFAULT_BACKOFF_RANDOM_FACTOR,
  DEFAULT_BACKOFF_RESET_COUNTER,
  DEFAULT_BACKOFF_TRIGGER_ON,
  readBackoffSupervisorOptionsFromConfig,
  withBackoffSupervisorConfigDefaults,
} from '../../../src/pattern/BackoffSupervisorOptions.js';
import type { BackoffSupervisorOptionsType } from '../../../src/pattern/BackoffSupervisorOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { expectExactOptions } from '../../util/ExactOptions.js';

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
      drain-grace    = 5ms
      forward-during-grace = false
    `);

    expectExactOptions(readBackoffSupervisorOptionsFromConfig(config), {
      minBackoff: 1_000,
      maxBackoff: 45_000,
      randomFactor: 0.5,
      maxStashSize: 7,
      resetCounter: 'never',
      forward: 'drop',
      triggerOn: 'failure',
      drainGraceMs: 5,
      forwardDuringGrace: false,
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

  test('drain-grace is one leaf with three readings', () => {
    // The reset-counter shape again: the word passes through as the sentinel
    // the supervisor resolves against its merged minBackoff, and anything else
    // is a duration — 0 included, the grace that drains at once.
    expectExactOptions(readBackoffSupervisorOptionsFromConfig(blockConfig('drain-grace = "auto"')), {
      drainGraceMs: 'auto',
    });
    expectExactOptions(readBackoffSupervisorOptionsFromConfig(blockConfig('drain-grace = 5ms')), { drainGraceMs: 5 });
    expectExactOptions(readBackoffSupervisorOptionsFromConfig(blockConfig('drain-grace = 0')), { drainGraceMs: 0 });
  });

  test('a drain-grace that is no duration, or a forward-during-grace that is no boolean, is refused', () => {
    // Any word but `auto` goes to the duration reader, which is what makes a
    // misspelt sentinel fail the supervisor's start instead of being ignored.
    expect(() => readBackoffSupervisorOptionsFromConfig(blockConfig('drain-grace = "soon"')))
      .toThrow(/Invalid duration/);
    expect(() => readBackoffSupervisorOptionsFromConfig(blockConfig('forward-during-grace = "maybe"')))
      .toThrow(ConfigError);
  });

  test('an absent leaf stays absent instead of being filled with its default', () => {
    // This is what lets `mergeOptions` layer the three sources per field
    // rather than per block: a reader that punched in its own defaults would
    // shadow the built-in layer with a copy of itself and, worse, shadow an
    // explicit option with a value nobody wrote.
    expectExactOptions(readBackoffSupervisorOptionsFromConfig(blockConfig('min-backoff = 1s')), { minBackoff: 1_000 });
    expectExactOptions(readBackoffSupervisorOptionsFromConfig(Config.empty()), {});
  });

  test('the published defaults round-trip to the constants they are published from', () => {
    // `DocumentedDefaults` compares the literals in `REFERENCE_CONF` to the
    // same constants, but through its own accessor table.  This reads them the
    // way the framework does, so a `reset-counter` typed as a duration or a
    // `random-factor` read with `getInt` fails here, as it fails the dead-key
    // gate and DocumentedDefaults' kind check, which set the leaf through this
    // reader; this case is the one that also pins each leaf to its field.  Own
    // keys are compared as well as values.
    expectExactOptions(readBackoffSupervisorOptionsFromConfig(Config.parseString(REFERENCE_CONF)), {
      minBackoff: DEFAULT_BACKOFF_MIN_MS,
      maxBackoff: DEFAULT_BACKOFF_MAX_MS,
      randomFactor: DEFAULT_BACKOFF_RANDOM_FACTOR,
      maxStashSize: DEFAULT_BACKOFF_MAX_STASH_SIZE,
      resetCounter: DEFAULT_BACKOFF_RESET_COUNTER,
      forward: DEFAULT_BACKOFF_FORWARD,
      triggerOn: DEFAULT_BACKOFF_TRIGGER_ON,
      drainGraceMs: DEFAULT_BACKOFF_DRAIN_GRACE_MS,
      forwardDuringGrace: DEFAULT_BACKOFF_FORWARD_DURING_GRACE,
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
    expect(merged.drainGraceMs).toBe(DEFAULT_BACKOFF_DRAIN_GRACE_MS);
    expect(merged.forwardDuringGrace).toBe(DEFAULT_BACKOFF_FORWARD_DURING_GRACE);
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

  test('explicit grace options outrank the config file, per field', () => {
    const config = blockConfig('drain-grace = 30ms\nforward-during-grace = false');

    const explicitGrace = withBackoffSupervisorConfigDefaults({ child: Idle, drainGraceMs: 5 }, config);
    expect(explicitGrace.drainGraceMs).toBe(5);
    expect(explicitGrace.forwardDuringGrace).toBe(false);

    const explicitForward = withBackoffSupervisorConfigDefaults({ child: Idle, forwardDuringGrace: true }, config);
    expect(explicitForward.forwardDuringGrace).toBe(true);
    expect(explicitForward.drainGraceMs).toBe(30);

    // `'auto'` written in code is a value, not an absence: it outranks the
    // file's duration, and the supervisor derives the grace again.
    expect(withBackoffSupervisorConfigDefaults({ child: Idle, drainGraceMs: 'auto' }, config).drainGraceMs)
      .toBe('auto');
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

  test('withDrainGraceMs takes the auto sentinel as well as a number', () => {
    const supervisorOptions = BackoffSupervisorOptions.create<unknown>().withDrainGraceMs('auto');

    expect({ ...supervisorOptions }).toEqual({ drainGraceMs: 'auto' });
    expect(() => new BackoffSupervisorOptionsValidator().validate({ ...supervisorOptions })).not.toThrow();
  });
});

describe('BackoffSupervisorOptionsValidator on drainGraceMs', () => {
  // The field is `number | 'auto'`, which no typed field helper can address,
  // so the rule is written out — and these are the values it has to tell apart.
  test.each([['auto'], [0], [5]])('accepts %p', (drainGraceMs) => {
    expect(() => new BackoffSupervisorOptionsValidator().validate({ drainGraceMs: drainGraceMs as number | 'auto' }))
      .not.toThrow();
  });

  test.each([[-5], [Number.NaN], [Number.POSITIVE_INFINITY], ['soon']])('refuses %p', (drainGraceMs) => {
    let thrown: unknown;
    try {
      new BackoffSupervisorOptionsValidator().validate({ drainGraceMs: drainGraceMs as number | 'auto' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OptionsError);
    expect((thrown as OptionsError).field).toBe('drainGraceMs');
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

  test.each([
    ['a negative drain-grace', { 'drain-grace': '-5ms' }, OptionsError, /^BackoffSupervisorOptions: drainGraceMs /],
    ['a drain-grace that is no duration', { 'drain-grace': 'soon' }, Error, /^Invalid duration: soon$/],
    ['a forward-during-grace that is no boolean', { 'forward-during-grace': 'maybe' }, ConfigError,
      /"actor-ts\.backoff-supervisor\.forward-during-grace" is not a boolean/],
  ] as const)('%s fails the supervisor at start', async (_case, block, errorClass, message) => {
    // Refused inside `preStart` — by the validator or by the reader — so the
    // value fails the start before a child exists to run under it, instead of
    // being ignored, which is what a leaf nobody reads would do with it.  The
    // decider is what sees the error, wrapped as the start failure it is.
    selfStopSpawns = 0;
    let failure: unknown;
    const system = systemWith({ 'actor-ts': { 'backoff-supervisor': block } }, 'backoff-config-grace-invalid');
    const supervisor = system.spawn(
      BackoffSupervisor.factory({ child: SelfStopping }),
      'invalid-grace-from-config',
      {
        supervisorStrategy: new OneForOneStrategy((error) => {
          failure = error;
          return Directive.Stop;
        }),
      },
    );

    await awaitCondition(
      () => (supervisor as unknown as LocalActorRef).getCell().isTerminated(),
      { timeoutMs: 4_000, label: 'the supervisor failed to start' },
    );
    expect(failure).toBeInstanceOf(ActorInitializationError);
    const cause = (failure as ActorInitializationError).cause;
    expect(cause).toBeInstanceOf(errorClass);
    expect((cause as Error).message).toMatch(message);
    expect(selfStopSpawns).toBe(0);
    await system.terminate();
  }, 5_000);
});

/** What the child after the respawn has been sent, in arrival order. */
const graceInbox: unknown[] = [];
let graceSpawns = 0;

/**
 * Dies in its constructor on the first incarnation and records everything the
 * second one is sent, so the message a test sends lands on a *respawned*
 * child — the one the grace exists for.
 */
class CrashesOnceThenRecords extends Actor<unknown> {
  constructor() {
    super();
    graceSpawns += 1;
    if (graceSpawns === 1) throw new Error('the first incarnation dies before it can take a message');
  }

  override onReceive(message: unknown): void {
    graceInbox.push(message);
  }
}

type RespawnedSupervisor = {
  readonly kit: TestKit;
  readonly scheduler: ManualScheduler;
  readonly supervisor: ActorRef<unknown>;
};

/**
 * A supervisor over {@link CrashesOnceThenRecords} under virtual time, taken
 * through exactly one respawn: the first incarnation is gone, the respawn timer
 * is the only task pending, and firing it starts the second incarnation —
 * whose grace, if it has one, has just opened and has not run a single tick.
 *
 * Virtual time is what lets a 5 ms grace be asserted to the millisecond: an
 * actor's timers run on `system.scheduler`, so the drain fires on
 * `advance` and nowhere else, and `kit.advance` settles the `/user` tree after
 * each step, so "not delivered yet" is read once every armed turn has run
 * rather than after a guessed wait.
 */
async function respawnedUnderVirtualTime(
  name: string,
  config: ConfigObject,
  options: Partial<BackoffSupervisorOptionsType<unknown>> = {},
): Promise<RespawnedSupervisor> {
  graceInbox.length = 0;
  graceSpawns = 0;
  const { kit, scheduler } = TestKit.withManualScheduler(name, { config });
  const supervisor = kit.system.spawn(
    BackoffSupervisor.factory<unknown>({ ...options, child: CrashesOnceThenRecords }),
    'grace',
  );
  await kit.settle();
  expect(graceSpawns).toBe(1);
  expect(scheduler.pendingCount, 'the respawn timer is the only task pending').toBe(1);
  scheduler.advanceToNext();
  await kit.settle();
  expect(graceSpawns).toBe(2);
  return { kit, scheduler, supervisor };
}

/**
 * Send one message to the freshly respawned child and step virtual time a
 * millisecond at a time until it arrives.  The offset it arrives at is the
 * grace the supervisor actually ran; `0` means it went straight through.
 * Bounded, so a grace that never ends fails here instead of hanging the file.
 */
async function deliveryOffsetMs(respawned: RespawnedSupervisor, boundMs = 100): Promise<number> {
  respawned.supervisor.tell('payload');
  await respawned.kit.settle();
  for (let offsetMs = 0; offsetMs < boundMs; offsetMs++) {
    if (graceInbox.includes('payload')) return offsetMs;
    await respawned.kit.advance(1);
  }
  throw new Error(`the payload was still held ${boundMs} ms of virtual time after the respawn`);
}

describe('the grace a respawned child runs, measured in virtual time', () => {
  test.each([
    // `'auto'` is resolved against the *merged* minBackoff, so each of the
    // three layers that can supply that field moves the grace with it.
    ['auto under a minBackoff set in code', {}, { minBackoff: 10, forwardDuringGrace: false }, 10],
    ['auto written out in code', {}, { drainGraceMs: 'auto', minBackoff: 10, forwardDuringGrace: false }, 10],
    ['auto under a configured min-backoff', { 'actor-ts': { 'backoff-supervisor': { 'min-backoff': '20ms' } } },
      { forwardDuringGrace: false }, 20],
    ['auto capped at 50 ms under the built-in min-backoff', {}, { forwardDuringGrace: false }, 50],
    ['a number in code', {}, { drainGraceMs: 7, forwardDuringGrace: false }, 7],
    ['nothing set at all: forwarded at once', {}, {}, 0],
  ] as const)('%s', async (_case, config, options, expectedMs) => {
    const respawned = await respawnedUnderVirtualTime('backoff-grace-code', config, options);
    try {
      expect(await deliveryOffsetMs(respawned)).toBe(expectedMs);
    } finally {
      await respawned.kit.shutdown();
    }
  });
});

describe('drain-grace and forward-during-grace reach a live supervisor', () => {
  test('configured only through the file, they hold a message for exactly 5 ms of virtual time', async () => {
    const respawned = await respawnedUnderVirtualTime('backoff-grace-config-only', {
      'actor-ts': { 'backoff-supervisor': { 'drain-grace': '5ms', 'forward-during-grace': false } },
    });
    try {
      respawned.supervisor.tell('payload');
      await respawned.kit.settle();
      expect(graceInbox, 'stashed: the child has not survived its grace yet').toEqual([]);
      await respawned.kit.advance(4);
      expect(graceInbox, 'still held a millisecond before the grace ends').toEqual([]);
      await respawned.kit.advance(1);
      expect(graceInbox).toEqual(['payload']);
    } finally {
      await respawned.kit.shutdown();
    }
  });

  test('under the reference block alone, the same message goes straight through inside the grace', async () => {
    const respawned = await respawnedUnderVirtualTime('backoff-grace-reference', {});
    try {
      const respawnedAt = respawned.scheduler.now();
      respawned.supervisor.tell('payload');
      await respawned.kit.settle();
      expect(graceInbox).toEqual(['payload']);
      expect(respawned.scheduler.now(), 'no virtual time passed').toBe(respawnedAt);
      // The grace is still open — its drain is the one task pending — so the
      // message went through `forward-during-grace = true`, not a drain.
      expect(respawned.scheduler.pendingCount).toBe(1);
    } finally {
      await respawned.kit.shutdown();
    }
  });

  test.each([
    ['an explicit drainGraceMs outranks a configured drain-grace',
      { 'drain-grace': '30ms', 'forward-during-grace': false }, { drainGraceMs: 5 }, 5],
    ['an explicit auto restores the derived grace over a configured duration',
      { 'min-backoff': '10ms', 'drain-grace': '30ms', 'forward-during-grace': false }, { drainGraceMs: 'auto' }, 10],
    ['an explicit forwardDuringGrace outranks a configured forward-during-grace',
      { 'drain-grace': '5ms', 'forward-during-grace': false }, { forwardDuringGrace: true }, 0],
    ['a configured drain-grace = 0 drains at once', { 'drain-grace': 0, 'forward-during-grace': false }, {}, 0],
  ] as const)('%s', async (_case, block, options, expectedMs) => {
    const respawned = await respawnedUnderVirtualTime(
      'backoff-grace-layers',
      { 'actor-ts': { 'backoff-supervisor': block } },
      options,
    );
    try {
      expect(await deliveryOffsetMs(respawned)).toBe(expectedMs);
    } finally {
      await respawned.kit.shutdown();
    }
  });
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
    ['drainGraceMs', 'drain-grace = -5ms'],
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
