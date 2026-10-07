/**
 * Projection handler-failure recovery strategies (#650).
 *
 * The behaviour under test is what happens *after* the user handler throws.
 * Before this existed there was exactly one answer — retry at the poll
 * interval, forever — so a single poison event blocked every event behind it
 * for the life of the process while re-logging once per second.
 *
 * These tests live in `tests/unit` rather than beside the round-trip suite in
 * `tests/integration` for two reasons the integration suite cannot give:
 *
 *   - a {@link ManualScheduler}, so a retry only happens when the test says
 *     so.  That turns "did it back off?" from a wall-clock race into an
 *     assertion: advance one millisecond short of the expected delay and
 *     nothing may move.
 *   - a capturing `Logger`.  The integration suite runs `NoopLogger` at
 *     `LogLevel.Off`, which is exactly the wrong instrument for the "and the
 *     log is not flooded" half of the issue.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { LogLevel, type Logger } from '../../../src/Logger.js';
import { ActorStopped, DeadLetter } from '../../../src/SystemMessages.js';
import { MetricsExtensionId, metricsOf } from '../../../src/metrics/MetricsExtension.js';
import type { PersistentEvent } from '../../../src/persistence/JournalTypes.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { InMemoryOffsetStore } from '../../../src/persistence/projection/OffsetStore.js';
import { ProjectionActor } from '../../../src/persistence/projection/ProjectionActor.js';
import {
  ByPersistenceIdProjectionOptions,
  ByTagProjectionOptions,
  ProjectionOptionsValidator,
  type ProjectionFailure,
} from '../../../src/persistence/projection/ProjectionOptions.js';
import { InMemoryQuery } from '../../../src/persistence/query/InMemoryQuery.js';
import type { Offset } from '../../../src/persistence/query/PersistenceQuery.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

type CountedEvent = { n: number };

/* ------------------------------- harness ------------------------------- */

type LogRecord = {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
};

/**
 * Records every call instead of writing one.  `level` is `Debug` because the
 * logger itself is what filters in this framework — an explicit `withLogger`
 * wins over `withLogLevel` outright, so anything below this floor would never
 * reach the array.
 */
class CapturingLogger implements Logger {
  readonly level = LogLevel.Debug;
  readonly records: LogRecord[] = [];

  debug(message: string, ..._args: unknown[]): void {
    this.records.push({ level: 'debug', message });
  }
  info(message: string, ..._args: unknown[]): void {
    this.records.push({ level: 'info', message });
  }
  warn(message: string, ..._args: unknown[]): void {
    this.records.push({ level: 'warn', message });
  }
  error(message: string, ..._args: unknown[]): void {
    this.records.push({ level: 'error', message });
  }
  withSource(_source: string): Logger { return this; }
  withFields(_fields: LogContextData): Logger { return this; }

  /** Records this projection produced, at one level. */
  at(level: LogRecord['level'], projection: string): LogRecord[] {
    return this.records.filter((r) => r.level === level && r.message.includes(projection));
  }
}

/** Collects dead letters so a test can assert on what a `skip` published. */
class DeadLetterCollector extends Actor<unknown> {
  constructor(private readonly sink: DeadLetter[]) { super(); }
  override onReceive(message: unknown): void {
    if (message instanceof DeadLetter) this.sink.push(message);
  }
}

/** Collects `ActorStopped` so a test can prove the `fail` arm really stopped. */
class StoppedCollector extends Actor<unknown> {
  constructor(private readonly sink: string[]) { super(); }
  override onReceive(message: unknown): void {
    if (message instanceof ActorStopped) this.sink.push(message.actor.path.toString());
  }
}

type Fixture = {
  readonly system: ActorSystem;
  readonly scheduler: ManualScheduler;
  readonly logger: CapturingLogger;
  readonly journal: InMemoryJournal;
  readonly query: InMemoryQuery;
  readonly offsetStore: InMemoryOffsetStore;
  readonly deadLetters: DeadLetter[];
  readonly stoppedPaths: string[];
};

function newFixture(name: string): Fixture {
  const scheduler = new ManualScheduler();
  const logger = new CapturingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withScheduler(scheduler);
  const system = ActorSystem.create(name, systemOptions);
  system.extension(MetricsExtensionId).enable();

  const deadLetters: DeadLetter[] = [];
  system.eventStream.subscribe(
    system.spawnAnonymous(() => new DeadLetterCollector(deadLetters)),
    DeadLetter,
  );
  const stoppedPaths: string[] = [];
  system.eventStream.subscribe(
    system.spawnAnonymous(() => new StoppedCollector(stoppedPaths)),
    ActorStopped,
  );

  const journal = new InMemoryJournal();
  return {
    system,
    scheduler,
    logger,
    journal,
    query: new InMemoryQuery(journal),
    offsetStore: new InMemoryOffsetStore(),
    deadLetters,
    stoppedPaths,
  };
}

/** Three events on one pid: `n` 1, 2, 3.  Event 2 is the designated poison. */
async function seedThreeEvents(journal: InMemoryJournal): Promise<void> {
  await journal.append(
    'poison',
    [{ event: { n: 1 } }, { event: { n: 2 } }, { event: { n: 3 } }],
    0,
  );
}

/**
 * The mailbox is real even though the clock is not, so a tick that the
 * scheduler released still completes asynchronously.  Poll on wall time for
 * the *expected* outcome, and use {@link settle} only for the negative
 * assertions where there is nothing to wait for.
 *
 * A two-line wrapper over `awaitCondition` (#418) rather than its own deadline
 * loop, which keeps all 26 call sites byte-identical while a timeout starts
 * reporting the elapsed time and the poll count instead of only the budget.
 * The label stays generic on purpose: the second positional argument here is
 * `timeoutMs`, so threading a per-site label through would mean touching every
 * one of those call sites for a message they already imply.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  await awaitCondition(predicate, {
    timeoutMs,
    intervalMs: 2,
    label: 'the projection reached the awaited state',
  });
}

/** Give any queued work a generous chance to run before asserting it did not. */
async function settle(): Promise<void> {
  // Fifteen turns of 2 ms, not a poll: every caller of `settle` asserts that the
  // projection made NO further progress, and an absence has no condition to wait
  // on — it is already true when the window opens.
  for (let i = 0; i < 15; i++) await Bun.sleep(2);
}

function failureCount(system: ActorSystem, projection: string, reason: string): number {
  return metricsOf(system)
    .counter('persistence_projection_failures_total', { projection, reason })
    .value;
}

function skippedCount(system: ActorSystem, projection: string): number {
  return metricsOf(system)
    .counter('persistence_projection_events_skipped_total', { projection })
    .value;
}

function stalledGauge(system: ActorSystem, projection: string): number {
  return metricsOf(system).gauge('persistence_projection_stalled', { projection }).value;
}

/* -------------------------------- fail --------------------------------- */

describe('projection recovery strategy — fail', () => {
  test('stops the projection on the first handler failure instead of retrying', async () => {
    const fixture = newFixture('proj-fail');
    await seedThreeEvents(fixture.journal);

    const seen: number[] = [];
    let attempts = 0;
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('fail-proj')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('fail')
      .withHandle((ev) => {
        attempts++;
        if (ev.event.n === 2) throw new Error('poison');
        seen.push(ev.event.n);
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => fixture.stoppedPaths.includes(ref.path.toString()));

    // Nothing may move afterwards, however far the clock is pushed — the
    // whole point is that the tick loop is gone, not merely slower.
    fixture.scheduler.advance(60_000);
    await settle();

    expect(seen).toEqual([1]);
    expect(attempts).toBe(2);
    expect(stalledGauge(fixture.system, 'fail-proj')).toBe(1);
    expect(fixture.logger.at('error', 'fail-proj').some((r) => r.message.includes('stopped')))
      .toBe(true);

    // The cursor stayed on the last committed event, so a restart resumes at
    // the poison event once the cause is fixed rather than skipping it.
    expect(await fixture.offsetStore.loadSequence('fail-proj', 'poison')).toBe(1);

    await fixture.system.terminate();
  });
});

/* -------------------------------- skip --------------------------------- */

describe('projection recovery strategy — skip', () => {
  test('steps past the poison event and unblocks everything behind it', async () => {
    const fixture = newFixture('proj-skip');
    await seedThreeEvents(fixture.journal);

    const seen: number[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('skip-proj')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('skip')
      .withHandle((ev) => {
        if (ev.event.n === 2) throw new Error('poison');
        seen.push(ev.event.n);
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    // No `advance` anywhere: a skip resumes inside the same tick, which is
    // what "head-of-line unblocking" has to mean to be worth anything.
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([1, 3]);
    expect(await fixture.offsetStore.loadSequence('skip-proj', 'poison')).toBe(3);

    expect(skippedCount(fixture.system, 'skip-proj')).toBe(1);
    expect(failureCount(fixture.system, 'skip-proj', 'handler')).toBe(1);
    // Stepping past the event is progress, so the projection is not stalled.
    expect(stalledGauge(fixture.system, 'skip-proj')).toBe(0);

    ref.stop();
    await fixture.system.terminate();
  });

  test('publishes the skipped event on the dead-letter stream', async () => {
    const fixture = newFixture('proj-skip-deadletter');
    await seedThreeEvents(fixture.journal);

    const seen: number[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('deadletter-proj')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('skip')
      .withHandle((ev) => {
        if (ev.event.n === 2) throw new Error('poison');
        seen.push(ev.event.n);
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => fixture.deadLetters.length === 1);
    const letter = fixture.deadLetters[0]!;
    const skipped = letter.message as { persistenceId: string; event: CountedEvent };
    expect(skipped.persistenceId).toBe('poison');
    expect(skipped.event.n).toBe(2);
    // The projection is the RECIPIENT of what it could not apply — it used to
    // sit in the sender slot, which read as "the projection sent this to the
    // dead-letter office" and left the letter attributed to `/deadLetters`
    // (#433).  Nothing sent the event anywhere; a read model is missing it.
    expect(letter.recipient.path.toString()).toContain('deadletter-proj');
    expect(letter.sender).toBeNull();

    ref.stop();
    await fixture.system.terminate();
  });
});

/* ---------------------------- retry-and-skip --------------------------- */

describe('projection recovery strategy — retry-and-skip', () => {
  test('exhausts the retry budget on an exponential backoff, then skips', async () => {
    const fixture = newFixture('proj-retry-skip');
    await seedThreeEvents(fixture.journal);

    const seen: number[] = [];
    let poisonAttempts = 0;
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('retry-skip-proj')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('retry-and-skip')
      .withMaxRetries(2)
      .withRetryBackoffMs(100)
      .withMaxRetryBackoffMs(1_000)
      .withHandle((ev) => {
        if (ev.event.n === 2) { poisonAttempts++; throw new Error('poison'); }
        seen.push(ev.event.n);
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    // Attempt 1 — the first tick needs no timer at all.
    await waitFor(() => poisonAttempts === 1);
    expect(seen).toEqual([1]);
    expect(stalledGauge(fixture.system, 'retry-skip-proj')).toBe(1);

    // One millisecond short of the first backoff: nothing may happen.  This
    // is the assertion the wall-clock suite cannot make.
    fixture.scheduler.advance(99);
    await settle();
    expect(poisonAttempts).toBe(1);

    fixture.scheduler.advance(1);
    await waitFor(() => poisonAttempts === 2);

    // The delay doubled, so 100 more is still not enough.
    fixture.scheduler.advance(100);
    await settle();
    expect(poisonAttempts).toBe(2);

    fixture.scheduler.advance(100);
    await waitFor(() => seen.length === 2);

    // Budget was 2 retries, so the handler saw the poison event three times.
    expect(poisonAttempts).toBe(3);
    expect(seen).toEqual([1, 3]);
    expect(skippedCount(fixture.system, 'retry-skip-proj')).toBe(1);
    expect(failureCount(fixture.system, 'retry-skip-proj', 'handler')).toBe(3);
    expect(stalledGauge(fixture.system, 'retry-skip-proj')).toBe(0);

    ref.stop();
    await fixture.system.terminate();
  });

  test('a long retry streak produces one error line, not one per attempt', async () => {
    const fixture = newFixture('proj-log-volume');
    await seedThreeEvents(fixture.journal);

    let poisonAttempts = 0;
    const seen: number[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('flood-proj')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('retry-and-skip')
      .withMaxRetries(5)
      .withRetryBackoffMs(10)
      .withMaxRetryBackoffMs(10)
      .withHandle((ev) => {
        if (ev.event.n === 2) { poisonAttempts++; throw new Error('poison'); }
        seen.push(ev.event.n);
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => poisonAttempts === 1);
    for (let attempt = 2; attempt <= 6; attempt++) {
      fixture.scheduler.advance(10);
      await waitFor(() => poisonAttempts === attempt);
    }
    await waitFor(() => seen.length === 2);

    // Six failing attempts.  One error when the streak opens, one warning
    // when it ends in a skip, and the four in between at debug — where the
    // detail is still available to anyone who wants it, but where it cannot
    // drown an error dashboard.
    expect(poisonAttempts).toBe(6);
    expect(fixture.logger.at('error', 'flood-proj')).toHaveLength(1);
    expect(fixture.logger.at('warn', 'flood-proj')).toHaveLength(1);
    expect(fixture.logger.at('debug', 'flood-proj')).toHaveLength(4);

    ref.stop();
    await fixture.system.terminate();
  });
});

/* ---------------------------- retry-and-fail --------------------------- */

describe('projection recovery strategy — retry-and-fail (the default)', () => {
  test('a transient failure is retried and the projection carries on', async () => {
    const fixture = newFixture('proj-retry-fail-transient');
    await seedThreeEvents(fixture.journal);

    let throwOnce = true;
    const seen: number[] = [];
    // No `withRecoveryStrategy` — this is what a projection does out of the box.
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('transient-proj')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('poison')
      .withRetryBackoffMs(50)
      .withHandle((ev) => {
        if (ev.event.n === 2 && throwOnce) { throwOnce = false; throw new Error('transient'); }
        seen.push(ev.event.n);
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => seen.length === 1);
    fixture.scheduler.advance(50);
    await waitFor(() => seen.length === 3);

    expect(seen).toEqual([1, 2, 3]);
    // Recovery clears the stall and says so exactly once.
    expect(stalledGauge(fixture.system, 'transient-proj')).toBe(0);
    expect(fixture.logger.at('info', 'transient-proj')).toHaveLength(1);

    ref.stop();
    await fixture.system.terminate();
  });

  test('a permanent failure stops the projection once the budget is spent', async () => {
    const fixture = newFixture('proj-retry-fail-permanent');
    await seedThreeEvents(fixture.journal);

    let poisonAttempts = 0;
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('permanent-proj')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('retry-and-fail')
      .withMaxRetries(2)
      .withRetryBackoffMs(10)
      .withMaxRetryBackoffMs(10)
      .withHandle((ev) => {
        if (ev.event.n === 2) { poisonAttempts++; throw new Error('poison'); }
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => poisonAttempts === 1);
    fixture.scheduler.advance(10);
    await waitFor(() => poisonAttempts === 2);
    fixture.scheduler.advance(10);
    await waitFor(() => poisonAttempts === 3);

    await waitFor(() => fixture.stoppedPaths.includes(ref.path.toString()));
    fixture.scheduler.advance(60_000);
    await settle();
    expect(poisonAttempts).toBe(3);

    await fixture.system.terminate();
  });
});

/* ------------------------------ onFailure ------------------------------ */

describe('projection onFailure hook', () => {
  test('reports every attempt with the offending event and the action taken', async () => {
    const fixture = newFixture('proj-hook');
    await seedThreeEvents(fixture.journal);

    const failures: ProjectionFailure<CountedEvent>[] = [];
    const seen: number[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('hook-proj')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('retry-and-skip')
      .withMaxRetries(1)
      .withRetryBackoffMs(10)
      .withMaxRetryBackoffMs(10)
      .withOnFailure((failure) => { failures.push(failure); })
      .withHandle((ev) => {
        if (ev.event.n === 2) throw new Error('poison');
        seen.push(ev.event.n);
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => failures.length === 1);
    fixture.scheduler.advance(10);
    await waitFor(() => seen.length === 2);

    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.attempt)).toEqual([1, 2]);
    expect(failures.map((f) => f.action)).toEqual(['retry', 'skip']);
    for (const failure of failures) {
      expect(failure.projection).toBe('hook-proj');
      // The offending event, not just the error — the point of the hook.
      expect(failure.event.event.n).toBe(2);
      expect(failure.event.persistenceId).toBe('poison');
      expect(failure.event.sequenceNr).toBe(2);
      expect((failure.error as Error).message).toBe('poison');
    }

    ref.stop();
    await fixture.system.terminate();
  });

  test('a hook that throws cannot take the projection down with it', async () => {
    const fixture = newFixture('proj-hook-throws');
    await seedThreeEvents(fixture.journal);

    const seen: number[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('bad-hook-proj')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('skip')
      .withOnFailure(() => { throw new Error('the reporter is broken too'); })
      .withHandle((ev) => {
        if (ev.event.n === 2) throw new Error('poison');
        seen.push(ev.event.n);
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([1, 3]);
    expect(fixture.logger.at('error', 'bad-hook-proj').some((r) => r.message.includes('hook threw')))
      .toBe(true);

    ref.stop();
    await fixture.system.terminate();
  });
});

/* ------------------------------ validation ----------------------------- */

describe('ProjectionOptionsValidator', () => {
  /**
   * Every case below sets a handler: a projection without one is rejected on
   * that ground alone (#1448), which would let each of these pass whether or
   * not the rule it names still exists.
   */
  const handle = (): void => {};

  test('rejects a strategy outside the closed vocabulary', () => {
    const validator = new ProjectionOptionsValidator<CountedEvent>();
    expect(() => validator.validate({
      handle,
      recoveryStrategy: 'retry-forever' as never,
    })).toThrow(OptionsError);
  });

  test('rejects a negative retry budget and a non-positive backoff', () => {
    const validator = new ProjectionOptionsValidator<CountedEvent>();
    expect(() => validator.validate({ handle, maxRetries: -1 })).toThrow(OptionsError);
    expect(() => validator.validate({ handle, retryBackoffMs: 0 })).toThrow(OptionsError);
  });

  test('rejects a backoff cap below the first delay', () => {
    const validator = new ProjectionOptionsValidator<CountedEvent>();
    expect(() => validator.validate({ handle, retryBackoffMs: 5_000, maxRetryBackoffMs: 100 }))
      .toThrow(/maxRetryBackoffMs/);
  });

  test('accepts an unset field — the defaults fill it in', () => {
    const validator = new ProjectionOptionsValidator<CountedEvent>();
    expect(() => validator.validate({ handle })).not.toThrow();
    // Zero retries is meaningful, not a typo: `retry-and-skip` with no
    // retries still reports the attempt through `onFailure`.
    expect(() => validator.validate({ handle, maxRetries: 0 })).not.toThrow();
  });

  test('the spawn factory rejects a bad value synchronously, at the call site', () => {
    const fixture = newFixture('proj-validate-spawn');
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('invalid-proj')
      .withQuery(fixture.query)
      .withPersistenceId('poison')
      .withMaxRetries(-3)
      .withHandle(() => {});
    // Not a supervised failure inside the actor's constructor: the caller
    // has to see this, because a restarting group guardian would just re-run
    // the same bad value forever.
    expect(() => ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions))
      .toThrow(OptionsError);
    void fixture.system.terminate();
  });
});

/* ------------------------- non-handler failures ------------------------ */

describe('projection poll failures', () => {
  test('a broken query backs off and logs once, without spending the retry budget', async () => {
    const fixture = newFixture('proj-poll-failure');
    await seedThreeEvents(fixture.journal);

    let queries = 0;
    // Fail the query itself — there is no event to skip or hand to the
    // strategy, so the only correct responses are backoff and log dedup.
    const brokenQuery = new InMemoryQuery(fixture.journal);
    const realCurrentEventsByPersistenceId = brokenQuery.currentEventsByPersistenceId.bind(brokenQuery);
    brokenQuery.currentEventsByPersistenceId = (async (...args: Parameters<typeof realCurrentEventsByPersistenceId>) => {
      queries++;
      if (queries <= 3) throw new Error('journal unavailable');
      return realCurrentEventsByPersistenceId(...args);
    }) as typeof brokenQuery.currentEventsByPersistenceId;

    const seen: number[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('poll-proj')
      .withQuery(brokenQuery)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('poison')
      .withRetryBackoffMs(10)
      .withMaxRetryBackoffMs(10)
      .withHandle((ev) => { seen.push(ev.event.n); })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => queries === 1);
    expect(stalledGauge(fixture.system, 'poll-proj')).toBe(1);
    for (let attempt = 2; attempt <= 4; attempt++) {
      fixture.scheduler.advance(10);
      await waitFor(() => queries === attempt);
    }
    await waitFor(() => seen.length === 3);

    // Three failed polls exceed the default retry budget of 3 attempts, and
    // the projection is still alive: the budget belongs to a poison event,
    // not to the infrastructure underneath it.
    expect(seen).toEqual([1, 2, 3]);
    expect(failureCount(fixture.system, 'poll-proj', 'poll')).toBe(3);
    expect(failureCount(fixture.system, 'poll-proj', 'handler')).toBe(0);
    expect(fixture.logger.at('error', 'poll-proj')).toHaveLength(1);
    expect(fixture.logger.at('debug', 'poll-proj')).toHaveLength(2);
    expect(stalledGauge(fixture.system, 'poll-proj')).toBe(0);

    ref.stop();
    await fixture.system.terminate();
  });
});

/* --------------------------- grouped handler --------------------------- */

/**
 * A failing group (#1448).  What these pin is the decision recorded on the
 * issue: a group is retried *as a group* within the handler-failure budget,
 * and only where the strategy would skip is it split — its events delivered
 * again one per call through the per-event path above, so the strategy skips
 * exactly the event that fails and none of the good ones around it.  `fail`
 * and `retry-and-fail` never split.
 *
 * Seven events in groups of three — [1, 2, 3], [4, 5, 6], [7] — with the
 * poison at n = 5, the middle of the second group: the first group shows the
 * projection was healthy, and an offender with good events on both sides is
 * the case a group-wide skip gets wrong in both directions.
 */

/** Every cursor save, in order: by-persistence-id as `sequenceNr`, by-tag as `pid#seq`. */
class RecordingOffsetStore extends InMemoryOffsetStore {
  readonly saves: number[] = [];
  readonly offsetSaves: string[] = [];

  override async saveSequence(projection: string, persistenceId: string, seqNr: number): Promise<void> {
    this.saves.push(seqNr);
    await super.saveSequence(projection, persistenceId, seqNr);
  }

  override async saveOffset(projection: string, tag: string, offset: Offset): Promise<void> {
    this.offsetSaves.push(`${offset.persistenceId}#${offset.sequenceNr}`);
    await super.saveOffset(projection, tag, offset);
  }
}

async function seedSevenEvents(journal: InMemoryJournal): Promise<void> {
  const entries = [];
  for (let n = 1; n <= 7; n++) entries.push({ event: { n } });
  await journal.append('poison', entries, 0);
}

const numbersOf = (events: ReadonlyArray<PersistentEvent<CountedEvent>>): number[] =>
  events.map((event) => event.event.n);

/** What `onFailure` reported, reduced to what a test compares — `'none'` for an absent group. */
function reported(failure: ProjectionFailure<CountedEvent>): {
  event: number;
  group: number[] | 'none';
  attempt: number;
  action: string;
} {
  return {
    event: failure.event.event.n,
    group: failure.group === undefined ? 'none' : numbersOf(failure.group),
    attempt: failure.attempt,
    action: failure.action,
  };
}

function deadLetterNumbers(fixture: Fixture): number[] {
  return fixture.deadLetters.map((letter) => (letter.message as PersistentEvent<CountedEvent>).event.n);
}

describe('grouped handler — a failing group (#1448)', () => {
  test('retry-and-skip: retries the group, then splits it and skips only the poison event', async () => {
    const fixture = newFixture('proj-group-retry-skip');
    await seedSevenEvents(fixture.journal);
    const offsetStore = new RecordingOffsetStore();

    const calls: number[][] = [];
    const failures: ProjectionFailure<CountedEvent>[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('group-retry-skip')
      .withQuery(fixture.query)
      .withOffsetStore(offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('retry-and-skip')
      .withMaxRetries(2)
      .withRetryBackoffMs(100)
      .withMaxRetryBackoffMs(1_000)
      .withOnFailure((failure) => { failures.push(failure); })
      .withGroupAfterEnvelopes(3)
      .withHandleGroup((events) => {
        calls.push(numbersOf(events));
        if (events.some((event) => event.event.n === 5)) throw new Error('poison');
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    // The first tick commits [1, 2, 3] and fails [4, 5, 6] once.
    await waitFor(() => calls.length === 2);
    expect(offsetStore.saves).toEqual([3]);

    // Retried as a group, on the same backoff curve an event would get.
    fixture.scheduler.advance(100);
    await waitFor(() => calls.length === 3);
    fixture.scheduler.advance(200);
    // Attempt 3 spends the budget.  Where an event would now be skipped, the
    // group is split instead: n=4 goes alone and is committed, n=5 fails alone.
    await waitFor(() => calls.length === 6);
    expect(calls.slice(1)).toEqual([[4, 5, 6], [4, 5, 6], [4, 5, 6], [4], [5]]);
    expect(offsetStore.saves).toEqual([3, 4]);

    // A per-event retry ends the tick.  The next tick must not re-form a group
    // around n=5: the split range outlives the tick that started it.
    fixture.scheduler.advance(100);
    await waitFor(() => calls.length === 7);
    expect(calls[6]).toEqual([5]);

    fixture.scheduler.advance(200);
    await waitFor(() => offsetStore.saves.includes(7));
    await waitFor(() => fixture.deadLetters.length === 1);

    expect(calls).toEqual([
      [1, 2, 3],
      [4, 5, 6], [4, 5, 6], [4, 5, 6],
      [4], [5], [5], [5], [6],
      [7],
    ]);
    expect(offsetStore.saves).toEqual([3, 4, 5, 6, 7]);
    expect(deadLetterNumbers(fixture)).toEqual([5]);
    expect(skippedCount(fixture.system, 'group-retry-skip')).toBe(1);
    // Failed calls, group and single alike.
    expect(failureCount(fixture.system, 'group-retry-skip', 'handler')).toBe(6);
    expect(stalledGauge(fixture.system, 'group-retry-skip')).toBe(0);
    expect(failures.map(reported)).toEqual([
      { event: 4, group: [4, 5, 6], attempt: 1, action: 'retry' },
      { event: 4, group: [4, 5, 6], attempt: 2, action: 'retry' },
      // The hand-over is a `retry`: every event of the group is about to be
      // tried again, one at a time.
      { event: 4, group: [4, 5, 6], attempt: 3, action: 'retry' },
      { event: 5, group: 'none', attempt: 1, action: 'retry' },
      { event: 5, group: 'none', attempt: 2, action: 'retry' },
      { event: 5, group: 'none', attempt: 3, action: 'skip' },
    ]);

    // Two streaks, each opened by one error and closed by one warning: the
    // group's, which names its range, and then the poison event's own.
    const errors = fixture.logger.at('error', 'group-retry-skip').map((record) => record.message);
    const warnings = fixture.logger.at('warn', 'group-retry-skip').map((record) => record.message);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('poison#4..poison#6');
    expect(errors[1]).toContain('poison#5');
    expect(errors[1]).not.toContain('..');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('poison#4..poison#6');
    expect(warnings[1]).toContain('poison#5');
    expect(fixture.logger.at('debug', 'group-retry-skip')).toHaveLength(2);

    ref.stop();
    await fixture.system.terminate();
  });

  test('skip: splits the group at once and skips only the poison event, all in the first tick', async () => {
    const fixture = newFixture('proj-group-skip');
    await seedSevenEvents(fixture.journal);
    const offsetStore = new RecordingOffsetStore();

    const calls: number[][] = [];
    const failures: ProjectionFailure<CountedEvent>[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('group-skip')
      .withQuery(fixture.query)
      .withOffsetStore(offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('skip')
      .withOnFailure((failure) => { failures.push(failure); })
      .withGroupAfterEnvelopes(3)
      .withHandleGroup((events) => {
        calls.push(numbersOf(events));
        if (events.some((event) => event.event.n === 5)) throw new Error('poison');
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    // No `advance` anywhere: like a per-event skip, the split resumes inside
    // the tick that failed.
    await waitFor(() => offsetStore.saves.includes(7));
    await waitFor(() => fixture.deadLetters.length === 1);

    expect(calls).toEqual([[1, 2, 3], [4, 5, 6], [4], [5], [6], [7]]);
    expect(offsetStore.saves).toEqual([3, 4, 5, 6, 7]);
    expect(deadLetterNumbers(fixture)).toEqual([5]);
    expect(skippedCount(fixture.system, 'group-skip')).toBe(1);
    expect(failureCount(fixture.system, 'group-skip', 'handler')).toBe(2);
    expect(stalledGauge(fixture.system, 'group-skip')).toBe(0);
    expect(failures.map(reported)).toEqual([
      { event: 4, group: [4, 5, 6], attempt: 1, action: 'retry' },
      { event: 5, group: 'none', attempt: 1, action: 'skip' },
    ]);

    ref.stop();
    await fixture.system.terminate();
  });

  test('a group that fails only as a group goes out one event at a time and nothing is skipped', async () => {
    const fixture = newFixture('proj-group-batch-refused');
    await seedSevenEvents(fixture.journal);
    const offsetStore = new RecordingOffsetStore();

    const calls: number[][] = [];
    const failures: ProjectionFailure<CountedEvent>[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('group-batch-refused')
      .withQuery(fixture.query)
      .withOffsetStore(offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('skip')
      .withOnFailure((failure) => { failures.push(failure); })
      .withGroupAfterEnvelopes(3)
      // A sink that refuses this batch but takes each of its records — the
      // case where skipping the group would have dropped three good events.
      .withHandleGroup((events) => {
        calls.push(numbersOf(events));
        if (events.length > 1 && events[0]!.event.n === 4) throw new Error('batch refused');
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => offsetStore.saves.includes(7));

    expect(calls).toEqual([[1, 2, 3], [4, 5, 6], [4], [5], [6], [7]]);
    expect(offsetStore.saves).toEqual([3, 4, 5, 6, 7]);
    expect(skippedCount(fixture.system, 'group-batch-refused')).toBe(0);
    expect(failures.map(reported)).toEqual([
      { event: 4, group: [4, 5, 6], attempt: 1, action: 'retry' },
    ]);
    // The split is progress, not a stall: nothing after it failed, so nothing
    // may leave the gauge raised.
    expect(stalledGauge(fixture.system, 'group-batch-refused')).toBe(0);

    await settle();
    expect(fixture.deadLetters).toHaveLength(0);

    ref.stop();
    await fixture.system.terminate();
  });

  test('fail: stops before the group\'s first event, with the cursor where it was', async () => {
    const fixture = newFixture('proj-group-fail');
    await seedSevenEvents(fixture.journal);
    const offsetStore = new RecordingOffsetStore();

    const calls: number[][] = [];
    const failures: ProjectionFailure<CountedEvent>[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('group-fail')
      .withQuery(fixture.query)
      .withOffsetStore(offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('fail')
      .withOnFailure((failure) => { failures.push(failure); })
      .withGroupAfterEnvelopes(3)
      .withHandleGroup((events) => {
        calls.push(numbersOf(events));
        if (events.some((event) => event.event.n === 5)) throw new Error('poison');
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => fixture.stoppedPaths.includes(ref.path.toString()));
    fixture.scheduler.advance(60_000);
    await settle();

    // Never split: n=4 is not delivered alone, so a restart re-sends the
    // whole group from the event the cursor still points before.
    expect(calls).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(offsetStore.saves).toEqual([3]);
    expect(await offsetStore.loadSequence('group-fail', 'poison')).toBe(3);
    expect(failures.map(reported)).toEqual([
      { event: 4, group: [4, 5, 6], attempt: 1, action: 'stop' },
    ]);
    expect(fixture.deadLetters).toHaveLength(0);
    expect(stalledGauge(fixture.system, 'group-fail')).toBe(1);
    expect(fixture.logger.at('error', 'group-fail')
      .some((record) => record.message.includes('stopped at group poison#4..poison#6'))).toBe(true);

    await fixture.system.terminate();
  });

  test('retry-and-fail: retries the group, then stops before its first event — never splits', async () => {
    const fixture = newFixture('proj-group-retry-fail');
    await seedSevenEvents(fixture.journal);
    const offsetStore = new RecordingOffsetStore();

    const calls: number[][] = [];
    const failures: ProjectionFailure<CountedEvent>[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('group-retry-fail')
      .withQuery(fixture.query)
      .withOffsetStore(offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('retry-and-fail')
      .withMaxRetries(2)
      .withRetryBackoffMs(10)
      .withMaxRetryBackoffMs(10)
      .withOnFailure((failure) => { failures.push(failure); })
      .withGroupAfterEnvelopes(3)
      .withHandleGroup((events) => {
        calls.push(numbersOf(events));
        if (events.some((event) => event.event.n === 5)) throw new Error('poison');
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => calls.length === 2);
    fixture.scheduler.advance(10);
    await waitFor(() => calls.length === 3);
    fixture.scheduler.advance(10);
    await waitFor(() => fixture.stoppedPaths.includes(ref.path.toString()));
    fixture.scheduler.advance(60_000);
    await settle();

    expect(calls).toEqual([[1, 2, 3], [4, 5, 6], [4, 5, 6], [4, 5, 6]]);
    expect(offsetStore.saves).toEqual([3]);
    expect(failures.map(reported)).toEqual([
      { event: 4, group: [4, 5, 6], attempt: 1, action: 'retry' },
      { event: 4, group: [4, 5, 6], attempt: 2, action: 'retry' },
      { event: 4, group: [4, 5, 6], attempt: 3, action: 'stop' },
    ]);
    expect(fixture.deadLetters).toHaveLength(0);

    await fixture.system.terminate();
  });

  test('by tag: a split range across two streams outlives the tick, in offset order', async () => {
    const fixture = newFixture('proj-group-tag-split');
    // One append per stream, `a` before `b`: should both land on one
    // timestamp, the persistenceId breaks the tie, so the order is defined
    // either way — a1..a4, then b1..b3.
    await fixture.journal.append('a', [1, 2, 3, 4].map((n) => ({ event: { n }, tags: ['orders'] })), 0);
    await fixture.journal.append('b', [5, 6, 7].map((n) => ({ event: { n }, tags: ['orders'] })), 0);
    const offsetStore = new RecordingOffsetStore();

    const calls: number[][] = [];
    const projectionOptions = ByTagProjectionOptions.create<CountedEvent>()
      .withName('group-tag-split')
      .withQuery(fixture.query)
      .withOffsetStore(offsetStore)
      .withTag('orders')
      .withRecoveryStrategy('retry-and-skip')
      .withMaxRetries(1)
      .withRetryBackoffMs(100)
      .withMaxRetryBackoffMs(1_000)
      .withGroupAfterEnvelopes(3)
      // The poison is a4, first of the group [a4, b1, b2]: by sequenceNr
      // alone it sorts *after* the range's end, b2.
      .withHandleGroup((events) => {
        calls.push(numbersOf(events));
        if (events.some((event) => event.event.n === 4)) throw new Error('poison');
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byTag<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => calls.length === 2);
    fixture.scheduler.advance(100);
    // The budget is spent on the second attempt: split, and a4 fails alone.
    await waitFor(() => calls.length === 4);
    fixture.scheduler.advance(100);
    await waitFor(() => offsetStore.offsetSaves.includes('b#3'));
    await waitFor(() => fixture.deadLetters.length === 1);

    // The tick after the per-event retry still knows a4, b1 and b2 are split:
    // the range is compared by offset — timestamp, then persistenceId, then
    // sequenceNr — not by sequenceNr alone.
    expect(calls).toEqual([[1, 2, 3], [4, 5, 6], [4, 5, 6], [4], [4], [5], [6], [7]]);
    expect(offsetStore.offsetSaves).toEqual(['a#3', 'a#4', 'b#1', 'b#2', 'b#3']);
    expect(deadLetterNumbers(fixture)).toEqual([4]);

    ref.stop();
    await fixture.system.terminate();
  });

  test('a group of one already is one event per call: per-event budget, per-event report', async () => {
    const fixture = newFixture('proj-group-of-one');
    await seedSevenEvents(fixture.journal);
    const offsetStore = new RecordingOffsetStore();

    const calls: number[][] = [];
    const failures: ProjectionFailure<CountedEvent>[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('group-of-one')
      .withQuery(fixture.query)
      .withOffsetStore(offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('skip')
      .withOnFailure((failure) => { failures.push(failure); })
      .withGroupAfterEnvelopes(3)
      // n=7 is the short tail of the tick, alone in its group.
      .withHandleGroup((events) => {
        calls.push(numbersOf(events));
        if (events.some((event) => event.event.n === 7)) throw new Error('poison');
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => offsetStore.saves.includes(7));
    await waitFor(() => fixture.deadLetters.length === 1);

    // Splitting it would only repeat the call it just made, so the one
    // attempt is the per-event one: skipped once, reported without a group.
    expect(calls).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(deadLetterNumbers(fixture)).toEqual([7]);
    expect(failures.map(reported)).toEqual([
      { event: 7, group: 'none', attempt: 1, action: 'skip' },
    ]);

    ref.stop();
    await fixture.system.terminate();
  });

  test('a handle projection\'s failure carries no group', async () => {
    const fixture = newFixture('proj-handle-no-group');
    await seedThreeEvents(fixture.journal);

    const failures: ProjectionFailure<CountedEvent>[] = [];
    const seen: number[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('handle-no-group')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('poison')
      .withRecoveryStrategy('skip')
      .withOnFailure((failure) => { failures.push(failure); })
      .withHandle((ev) => {
        if (ev.event.n === 2) throw new Error('poison');
        seen.push(ev.event.n);
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => seen.length === 2);
    expect(failures.map(reported)).toEqual([
      { event: 2, group: 'none', attempt: 1, action: 'skip' },
    ]);

    ref.stop();
    await fixture.system.terminate();
  });
});
