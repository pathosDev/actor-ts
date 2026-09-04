/**
 * `actor-ts.projection.*` — the HOCON layer under a projection's options (#875).
 *
 * The handler-failure strategy itself shipped with #650 and is covered by
 * `ProjectionFailureStrategy.test.ts`; what is under test here is the *layer*:
 * five keys that reach a projection which never mentioned them, without
 * outranking one that did.
 *
 * Two halves, deliberately:
 *
 *   - the reader in isolation, where "absent stays absent" is the property
 *     that matters — a key the operator did not write must not land as an
 *     explicit `undefined`, because `undefined` on a higher layer is what
 *     falls *through* in this project rather than shadowing;
 *   - the merge as a running projection sees it, on a {@link ManualScheduler}
 *     so the poll cadence is an assertion rather than a wall-clock race.
 *     A returned object proves the reader; only a projection that actually
 *     skipped, or actually waited 250 ms, proves the wiring.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel } from '../../../src/Logger.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { Config } from '../../../src/config/Config.js';
import { MetricsExtensionId, metricsOf } from '../../../src/metrics/MetricsExtension.js';
import { DEFAULT_LIVE_QUERY_POLL_INTERVAL_MS } from '../../../src/persistence/Constants.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { InMemoryOffsetStore } from '../../../src/persistence/projection/OffsetStore.js';
import { ProjectionActor } from '../../../src/persistence/projection/ProjectionActor.js';
import {
  ByPersistenceIdProjectionOptions,
  DEFAULT_PROJECTION_MAX_RETRIES,
  DEFAULT_PROJECTION_MAX_RETRY_BACKOFF_MS,
  DEFAULT_PROJECTION_RECOVERY_STRATEGY,
  DEFAULT_PROJECTION_RETRY_BACKOFF_MS,
  readProjectionOptionsFromConfig,
} from '../../../src/persistence/projection/ProjectionOptions.js';
import { InMemoryQuery } from '../../../src/persistence/query/InMemoryQuery.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

type CountedEvent = { n: number };

/* ----------------------------- the reader ------------------------------ */

/**
 * `Config.parseString` and not `Config.fromObject({'actor-ts.projection.x': 1})`
 * — the latter keeps the dotted string as one literal top-level key, so
 * `hasPath` would resolve the *nested* reference.conf value instead and every
 * assertion below would be about the shipped default.
 */
function hocon(source: string): Config {
  return Config.parseString(source);
}

describe('readProjectionOptionsFromConfig', () => {
  test('returns nothing at all for a config that carries no projection block', () => {
    // Not `{ recoveryStrategy: undefined, ... }`: an explicit undefined would
    // still be an own property, and the merge chain reads `??` on the value,
    // so the distinction only shows up as a *missing* HOCON layer here.
    expect(readProjectionOptionsFromConfig(Config.empty())).toEqual({});
    expect(Object.keys(readProjectionOptionsFromConfig(hocon('actor-ts { }')))).toEqual([]);
  });

  test('reads each leaf on its own, leaving the other four absent', () => {
    expect(readProjectionOptionsFromConfig(
      hocon('actor-ts.projection { recovery-strategy = "retry-and-skip" }'),
    )).toEqual({ recoveryStrategy: 'retry-and-skip' });

    expect(readProjectionOptionsFromConfig(
      hocon('actor-ts.projection { max-retries = 7 }'),
    )).toEqual({ maxRetries: 7 });

    expect(readProjectionOptionsFromConfig(
      hocon('actor-ts.projection { retry-backoff = 250ms }'),
    )).toEqual({ retryBackoffMs: 250 });

    expect(readProjectionOptionsFromConfig(
      hocon('actor-ts.projection { max-retry-backoff = 2m }'),
    )).toEqual({ maxRetryBackoffMs: 120_000 });

    expect(readProjectionOptionsFromConfig(
      hocon('actor-ts.projection { poll-interval = 1500ms }'),
    )).toEqual({ pollIntervalMs: 1_500 });
  });

  test('an unquoted strategy resolves too — a hyphenated bare word is a HOCON string', () => {
    // reference.conf quotes it, but nothing forces an operator to, and the
    // hyphens make `retry-and-skip` look like arithmetic until you know the
    // parser treats an unquoted value as text to end-of-line.
    expect(readProjectionOptionsFromConfig(
      hocon('actor-ts.projection { recovery-strategy = retry-and-skip }'),
    )).toEqual({ recoveryStrategy: 'retry-and-skip' });
  });

  test('the shipped reference block reads back as the built-in defaults', () => {
    // The middle layer must be a no-op out of the box: reference.conf is
    // always present, so every one of these five is *always* supplied by
    // HOCON, and a value that disagreed with its constant would silently
    // become the real default for the whole framework.
    expect(readProjectionOptionsFromConfig(Config.load())).toEqual({
      recoveryStrategy: DEFAULT_PROJECTION_RECOVERY_STRATEGY,
      maxRetries: DEFAULT_PROJECTION_MAX_RETRIES,
      retryBackoffMs: DEFAULT_PROJECTION_RETRY_BACKOFF_MS,
      maxRetryBackoffMs: DEFAULT_PROJECTION_MAX_RETRY_BACKOFF_MS,
      pollIntervalMs: DEFAULT_LIVE_QUERY_POLL_INTERVAL_MS,
    });
  });
});

/* ------------------------------- harness ------------------------------- */

/** Collects dead letters, so a `skip` that HOCON asked for is observable. */
class DeadLetterCollector extends Actor<unknown> {
  constructor(private readonly sink: DeadLetter[]) { super(); }
  override onReceive(message: unknown): void {
    if (message instanceof DeadLetter) this.sink.push(message);
  }
}

type Fixture = {
  readonly system: ActorSystem;
  readonly scheduler: ManualScheduler;
  readonly journal: InMemoryJournal;
  readonly query: InMemoryQuery;
  readonly offsetStore: InMemoryOffsetStore;
  readonly deadLetters: DeadLetter[];
  /**
   * Timers the *system* had already scheduled before any projection existed —
   * measured, not assumed to be zero, because enabling metrics leaves one
   * behind.  A test that wants "the projection has armed its next tick" asks
   * for one more than this.
   */
  readonly pendingBaseline: number;
};

/**
 * A system whose config layer is `source`, merged the way a real deployment
 * merges an `application.conf`: over `reference.conf`, not instead of it.
 */
function newFixture(name: string, source: string): Fixture {
  const scheduler = new ManualScheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogLevel(LogLevel.Off)
    .withScheduler(scheduler)
    .withConfig(Config.parseString(source));
  const system = ActorSystem.create(name, systemOptions);
  system.extension(MetricsExtensionId).enable();

  const deadLetters: DeadLetter[] = [];
  system.eventStream.subscribe(
    system.spawnAnonymous(() => new DeadLetterCollector(deadLetters)),
    DeadLetter,
  );

  const journal = new InMemoryJournal();
  return {
    system,
    scheduler,
    journal,
    query: new InMemoryQuery(journal),
    offsetStore: new InMemoryOffsetStore(),
    deadLetters,
    pendingBaseline: scheduler.pendingCount,
  };
}

/** True once the projection has armed the timer for its next tick. */
function nextTickArmed(fixture: Fixture): boolean {
  return fixture.scheduler.pendingCount > fixture.pendingBaseline;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  await awaitCondition(predicate, {
    timeoutMs,
    intervalMs: 2,
    label: 'the projection reached the awaited state',
  });
}

/** Give queued work a generous chance to run before asserting it did not. */
async function settle(): Promise<void> {
  // Fifteen turns of 2 ms, and deliberately not `awaitCondition`: every caller
  // asserts that the projection made NO further progress, and an absence has
  // no state to poll — it is already true the moment the window opens, so the
  // only thing a wait can buy here is the chance for it to become false.
  for (let i = 0; i < 15; i++) await Bun.sleep(2);
}

function skippedCount(system: ActorSystem, projection: string): number {
  return metricsOf(system)
    .counter('persistence_projection_events_skipped_total', { projection })
    .value;
}

/* ------------------------------ precedence ----------------------------- */

describe('actor-ts.projection is the layer between explicit options and the defaults', () => {
  test('HOCON alone turns a handler failure into a skip the built-in default would retry', async () => {
    const fixture = newFixture(
      'proj-config-skip',
      'actor-ts.projection { recovery-strategy = "skip" }',
    );
    await fixture.journal.append('poison', [{ event: { n: 1 } }, { event: { n: 2 } }], 0);

    const seen: number[] = [];
    let poisonAttempts = 0;
    // Note what this projection does NOT say: no strategy, no retry budget.
    // Under the built-in `retry-and-fail` it would try event 1 four times and
    // then stop, and `seen` would stay empty forever.
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('config-skip-proj')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('poison')
      .withHandle((ev) => {
        if (ev.event.n === 1) { poisonAttempts++; throw new Error('poison'); }
        seen.push(ev.event.n);
      });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => seen.length === 1);
    expect(poisonAttempts).toBe(1);
    expect(seen).toEqual([2]);
    expect(skippedCount(fixture.system, 'config-skip-proj')).toBe(1);
    expect(fixture.deadLetters).toHaveLength(1);

    ref.stop();
    await fixture.system.terminate();
  });

  test('an explicit strategy outranks HOCON, field by field', async () => {
    const fixture = newFixture(
      'proj-config-outranked',
      // Both set; the projection overrides only the strategy, so `max-retries`
      // must still arrive from here.  That is the half a whole-object merge
      // would get wrong.
      'actor-ts.projection { recovery-strategy = "skip", max-retries = 1, retry-backoff = 40ms }',
    );
    await fixture.journal.append('poison', [{ event: { n: 1 } }, { event: { n: 2 } }], 0);

    const seen: number[] = [];
    let poisonAttempts = 0;
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('outranked-proj')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('retry-and-skip')
      .withHandle((ev) => {
        if (ev.event.n === 1) { poisonAttempts++; throw new Error('poison'); }
        seen.push(ev.event.n);
      });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    // The explicit `retry-and-skip` won: the first failure retries rather
    // than skipping outright.  Wait for the retry timer too — see
    // `assertPollCadence` for why advancing before it exists is a coin flip.
    await waitFor(() => poisonAttempts === 1 && nextTickArmed(fixture));
    await settle();
    expect(seen).toEqual([]);

    // And HOCON's budget of 1 retry — not the built-in 3 — decided when the
    // retrying stopped.  Its 40 ms backoff is what the clock is advanced by.
    fixture.scheduler.advance(39);
    await settle();
    expect(poisonAttempts).toBe(1);

    fixture.scheduler.advance(1);
    await waitFor(() => seen.length === 1);
    expect(poisonAttempts).toBe(2);
    expect(seen).toEqual([2]);
    expect(skippedCount(fixture.system, 'outranked-proj')).toBe(1);

    ref.stop();
    await fixture.system.terminate();
  });
});

/* ----------------------------- poll-interval --------------------------- */

/**
 * Drives the cadence assertion: handle event 1, then append event 2 and prove
 * the projection does not see it until exactly `expectedMs` of virtual time
 * has passed.
 */
async function assertPollCadence(fixture: Fixture, seen: number[], expectedMs: number) {
  // Wait on the timer, not only on the handler: the next tick is scheduled in
  // the tick's `finally`, a turn *after* `handle` returned, and advancing the
  // clock before it exists would restart the interval from the advanced now
  // and make the assertion below a coin flip.
  await waitFor(() => seen.length === 1 && nextTickArmed(fixture));

  await fixture.journal.append('stream', [{ event: { n: 2 } }], 1);
  fixture.scheduler.advance(expectedMs - 1);
  await settle();
  expect(seen).toEqual([1]);

  fixture.scheduler.advance(1);
  await waitFor(() => seen.length === 2);
  expect(seen).toEqual([1, 2]);
}

describe('actor-ts.projection.poll-interval drives the tick', () => {
  test('a projection that names no cadence polls on the configured one', async () => {
    const fixture = newFixture('proj-config-poll', 'actor-ts.projection { poll-interval = 250ms }');
    await fixture.journal.append('stream', [{ event: { n: 1 } }], 0);

    const seen: number[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('poll-proj')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('stream')
      .withHandle((ev) => { seen.push(ev.event.n); });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await assertPollCadence(fixture, seen, 250);

    ref.stop();
    await fixture.system.terminate();
  });

  test('an empty liveOptions does not erase it — the object is not the unit of merge', async () => {
    // `withLiveOptions({})` is what a `given.liveOptions ?? fromConfig` merge
    // gets wrong: the object is present and truthy, so it wins whole and puts
    // the cadence back to the built-in 1 s while saying nothing about it.
    const fixture = newFixture('proj-config-poll-empty', 'actor-ts.projection { poll-interval = 250ms }');
    await fixture.journal.append('stream', [{ event: { n: 1 } }], 0);

    const seen: number[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('poll-empty-proj')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('stream')
      .withLiveOptions({})
      .withHandle((ev) => { seen.push(ev.event.n); });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await assertPollCadence(fixture, seen, 250);

    ref.stop();
    await fixture.system.terminate();
  });

  test('an explicit undefined falls through to it rather than shadowing it', async () => {
    // The stricter half of the same rule, and the one `{}` cannot catch: an
    // own property whose value is `undefined` survives an object spread, so
    // `{ ...fromConfigLive, ...given.liveOptions }` would overwrite 250 with
    // `undefined` here.  Project-wide, `undefined` on a higher layer means
    // "not set" and must fall through — which only a per-field `??` gives.
    const fixture = newFixture('proj-config-poll-undef', 'actor-ts.projection { poll-interval = 250ms }');
    await fixture.journal.append('stream', [{ event: { n: 1 } }], 0);

    const seen: number[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('poll-undefined-proj')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('stream')
      .withLiveOptions({ pollIntervalMs: undefined })
      .withHandle((ev) => { seen.push(ev.event.n); });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await assertPollCadence(fixture, seen, 250);

    ref.stop();
    await fixture.system.terminate();
  });

  test('an explicit pollIntervalMs still outranks the configured one', async () => {
    const fixture = newFixture('proj-config-poll-explicit', 'actor-ts.projection { poll-interval = 250ms }');
    await fixture.journal.append('stream', [{ event: { n: 1 } }], 0);

    const seen: number[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('poll-explicit-proj')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('stream')
      .withLiveOptions({ pollIntervalMs: 60 })
      .withHandle((ev) => { seen.push(ev.event.n); });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await assertPollCadence(fixture, seen, 60);

    ref.stop();
    await fixture.system.terminate();
  });
});

/* ------------------------------ validation ----------------------------- */

describe('a bad HOCON value is rejected like a bad explicit option', () => {
  function spawnWith(fixture: Fixture, name: string): void {
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName(name)
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('stream')
      .withHandle(() => {});
    ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);
  }

  test('an unknown recovery-strategy throws OptionsError out of the static factory', async () => {
    const fixture = newFixture(
      'proj-config-bad-strategy',
      'actor-ts.projection { recovery-strategy = "nonsense" }',
    );

    // Out of the *factory*, synchronously — not as a supervised actor failure
    // that would hand the caller a ref which never works.
    expect(() => spawnWith(fixture, 'bad-strategy-proj')).toThrow(OptionsError);
    expect(() => spawnWith(fixture, 'bad-strategy-proj')).toThrow(/recoveryStrategy must be one of/);

    await fixture.system.terminate();
  });

  test('a retry-backoff above the shipped cap trips the cross-field rule', async () => {
    // The whole reason `max-retry-backoff` had to ship alongside
    // `retry-backoff`: the cap is checked on the MERGED settings, so raising
    // only the delay puts 90 s against reference.conf's 60 s and stops every
    // projection in the process — from a config file, with no code change.
    const fixture = newFixture(
      'proj-config-uncapped',
      'actor-ts.projection { retry-backoff = 90s }',
    );

    expect(() => spawnWith(fixture, 'uncapped-proj')).toThrow(OptionsError);
    expect(() => spawnWith(fixture, 'uncapped-proj'))
      .toThrow(/maxRetryBackoffMs must be >= retryBackoffMs \(90000\)/);

    // And raising the cap with it is all the operator has to do.
    const capped = newFixture(
      'proj-config-capped',
      'actor-ts.projection { retry-backoff = 90s, max-retry-backoff = 120s }',
    );
    expect(() => spawnWith(capped, 'capped-proj')).not.toThrow();

    await fixture.system.terminate();
    await capped.system.terminate();
  });
});
