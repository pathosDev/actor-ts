/**
 * A projection that cannot load its cursor says so on the instruments an
 * operator watches (#1507, #1070).
 *
 * `BaseProjectionActor.preStart` loads the cursor and then starts ticking.
 * Every failure *after* that point — the handler throwing, the query layer
 * throwing, the offset store throwing on a save — is reported three ways:
 * `persistence_projection_failures_total` moves,
 * `persistence_projection_stalled` goes to 1, and an error line names the
 * projection.  A failure in the load itself reached none of them: it escaped
 * `preStart`, and from there it is an `ActorInitializationError` like any
 * other, handled by the group supervisor and gone.
 *
 * What that costs is specific and was measured before this file existed
 * (`probe-operator-path2.ts`, a capturing logger at `LogLevel.Debug`, a
 * by-persistenceId projection under a composite key of 272 characters):
 *
 *   load attempts (= preStart runs) : 11    (1 + defaultStrategy.maxRetries)
 *   withOnFailure calls             : 0
 *   log records                     : 2
 *     [error] Actor initialization failed        <- ActorCell, once
 *     [warn]  Restart threshold exceeded …       <- the group supervisor
 *   persistence_projection_stalled  : 0    <- published healthy, then died
 *
 * The gauge is the sharp end.  `docs/…/observability/metrics/stock-metrics.mdx`
 * calls it "the alert" and leans on its being published as 0 at start so that
 * `== 1` is a working expression — so a projection that never started reads as
 * a *healthy* projection, not as a missing one.  Ten of the eleven attempts
 * produce no line at all, because `ActorCell.completeRecreate` fails to its
 * parent without logging; the one that does says `Actor initialization failed`,
 * which names the projection only in the record's `source` field and says
 * nothing an operator can act on.
 *
 * The population is ordinary.  Ten tags of 21 characters
 * (`order-lifecycle-01-eu`) as `{ all: 5, any: 4, not: 1 }` render a 234-character
 * cursor key, which under `orders-projection` composes to 256 — one over.  See
 * `OffsetStoreCompositeKeyBound.test.ts` for that half.
 *
 * Deliberately *not* asserted here: the `onFailure` hook.  It takes a
 * `ProjectionFailure<E>`, whose `event` is required and which a cursor-load
 * failure has none of — closing that gap means changing the type in
 * `ProjectionOptions.ts`, which is a wider change than this repair.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import type { LogContextData } from '../../../../../src/LogContext.js';
import { LogLevel, type Logger } from '../../../../../src/Logger.js';
import { MetricsExtensionId, metricsOf } from '../../../../../src/metrics/MetricsExtension.js';
import { InMemoryDurableStateStore } from '../../../../../src/persistence/durable-state-stores/InMemoryDurableStateStore.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import {
  DurableStateOffsetStore,
  InMemoryOffsetStore,
  type OffsetStore,
} from '../../../../../src/persistence/projection/OffsetStore.js';
import { ProjectionActor } from '../../../../../src/persistence/projection/ProjectionActor.js';
import { ByPersistenceIdProjectionOptions } from '../../../../../src/persistence/projection/ProjectionOptions.js';
import { InMemoryQuery } from '../../../../../src/persistence/query/InMemoryQuery.js';
import type { Offset } from '../../../../../src/persistence/query/PersistenceQuery.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

/** The projection name from the issue's worked example — 17 characters. */
const PROJECTION_NAME = 'orders-projection';

/** Legal on its own (`MAX_PERSISTENCE_ID_LENGTH` is 255); 272 once composed. */
const LONG_PERSISTENCE_ID = 'order-'.padEnd(250, 'x');

type LogRecord = {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  /** Every extra argument, flattened — an `Error` down its whole cause chain. */
  readonly detail: string;
};

function renderArgument(value: unknown): string {
  if (!(value instanceof Error)) return String(value);
  let rendered = `${value.name}: ${value.message}`;
  let cause: unknown = (value as { cause?: unknown }).cause;
  while (cause instanceof Error) {
    rendered += ` <- ${cause.name}: ${cause.message}`;
    cause = (cause as { cause?: unknown }).cause;
  }
  return rendered;
}

/**
 * Records message *and* arguments, and returns `this` from `withSource`.
 *
 * Both halves are load-bearing and neither is the obvious choice.  Keeping the
 * arguments is what lets the assertions ask whether the operator was told what
 * to shorten, rather than only that something was written — the offending key
 * travels as the second argument to `log.error`, never in the message.
 * Dropping the source is what makes "the message names the projection" a real
 * question: `ActorCell` logs through `system.log.withSource(path)`, and the
 * actor path happens to contain the projection name, so a logger that folded
 * the source into the record would make the generic line look attributed.
 */
class CapturingLogger implements Logger {
  readonly level = LogLevel.Debug;
  readonly records: LogRecord[] = [];

  private push(level: LogRecord['level'], message: string, args: unknown[]): void {
    this.records.push({ level, message, detail: args.map(renderArgument).join(' | ') });
  }

  debug(message: string, ...args: unknown[]): void { this.push('debug', message, args); }
  info(message: string, ...args: unknown[]): void { this.push('info', message, args); }
  warn(message: string, ...args: unknown[]): void { this.push('warn', message, args); }
  error(message: string, ...args: unknown[]): void { this.push('error', message, args); }
  withSource(_source: string): Logger { return this; }
  withFields(_fields: LogContextData): Logger { return this; }

  /** Error records whose **message** names `projection` — not their source. */
  errorsNaming(projection: string): LogRecord[] {
    return this.records.filter((r) => r.level === 'error' && r.message.includes(projection));
  }
}

/** An offset store that fails its first `failures` loads, then delegates. */
class FlakyOffsetStore implements OffsetStore {
  loadAttempts = 0;
  private readonly inner = new InMemoryOffsetStore();

  constructor(private readonly failures: number) {}

  async loadSequence(projection: string, persistenceId: string): Promise<number> {
    this.loadAttempts++;
    if (this.loadAttempts <= this.failures) {
      throw new Error('simulated offset-store outage on load');
    }
    return this.inner.loadSequence(projection, persistenceId);
  }
  async saveSequence(projection: string, persistenceId: string, sequenceNr: number): Promise<void> {
    return this.inner.saveSequence(projection, persistenceId, sequenceNr);
  }
  async loadOffset(projection: string, tag: string): Promise<Offset> {
    return this.inner.loadOffset(projection, tag);
  }
  async saveOffset(projection: string, tag: string, offset: Offset): Promise<void> {
    return this.inner.saveOffset(projection, tag, offset);
  }
  async clear(projection: string): Promise<void> {
    return this.inner.clear(projection);
  }
}

type Fixture = {
  readonly system: ActorSystem;
  readonly logger: CapturingLogger;
  readonly journal: InMemoryJournal;
  readonly query: InMemoryQuery;
};

function newFixture(name: string): Fixture {
  const logger = new CapturingLogger();
  const system = ActorSystem.create(name, ActorSystemOptions.create().withLogger(logger));
  system.extension(MetricsExtensionId).enable();
  const journal = new InMemoryJournal();
  return { system, logger, journal, query: new InMemoryQuery(journal) };
}

function pollFailures(system: ActorSystem, projection: string): number {
  return metricsOf(system)
    .counter('persistence_projection_failures_total', { projection, reason: 'poll' })
    .value;
}

function stalledGauge(system: ActorSystem, projection: string): number {
  return metricsOf(system).gauge('persistence_projection_stalled', { projection }).value;
}

describe('ProjectionActor — a refused cursor key is visible to the operator', () => {
  test('the stalled gauge, the failure counter and an error line all name the projection', async () => {
    const fixture = newFixture('proj-cursor-visible');
    await fixture.journal.append('alice', [{ event: { n: 1 } }, { event: { n: 2 } }], 0);
    await fixture.journal.append(LONG_PERSISTENCE_ID, [{ event: { n: 9 } }], 0);
    const offsetStore = new DurableStateOffsetStore(new InMemoryDurableStateStore());

    // A control on the same system, the same backend and the same projection
    // name: when it has delivered, the pipeline has demonstrably run, so the
    // absences asserted below are absences rather than a race (#418).
    const controlSeen: number[] = [];
    const controlOptions = ByPersistenceIdProjectionOptions.create<{ n: number }>()
      .withName(PROJECTION_NAME)
      .withQuery(fixture.query)
      .withOffsetStore(offsetStore)
      .withPersistenceId('alice')
      .withHandle((event) => { controlSeen.push(event.event.n); })
      .withLiveOptions({ pollIntervalMs: 30 });
    const controlRef = ProjectionActor.byPersistenceId<{ n: number }>(fixture.system, controlOptions);

    const subjectSeen: number[] = [];
    const subjectOptions = ByPersistenceIdProjectionOptions.create<{ n: number }>()
      .withName(PROJECTION_NAME)
      .withQuery(fixture.query)
      .withOffsetStore(offsetStore)
      .withPersistenceId(LONG_PERSISTENCE_ID)
      .withHandle((event) => { subjectSeen.push(event.event.n); })
      .withLiveOptions({ pollIntervalMs: 30 });
    const subjectRef = ProjectionActor.byPersistenceId<{ n: number }>(fixture.system, subjectOptions);

    await awaitCondition(() => controlSeen.length >= 2, {
      timeoutMs: 4_000,
      label: 'the control projection drained its two events through the durable-state cursor',
    });
    await awaitCondition(() => pollFailures(fixture.system, PROJECTION_NAME) >= 1, {
      timeoutMs: 4_000,
      label: 'the refused cursor load was counted as a poll failure',
    });

    // The alert expression the metrics page documents: a projection that can
    // never run must not read as a healthy one.
    expect(stalledGauge(fixture.system, PROJECTION_NAME)).toBe(1);

    // And the line an operator greps for: the projection's own name in the
    // message, and the remedy in the detail.  `Actor initialization failed`
    // carries the second and neither the first nor an actionable subject.
    const named = fixture.logger.errorsNaming(PROJECTION_NAME);
    expect(named.length).toBeGreaterThanOrEqual(1);
    expect(named.some((r) => r.detail.includes('Shorten the projection name'))).toBe(true);
    expect(named.some((r) => r.detail.includes('272'))).toBe(true);

    // The handler never ran — a projection that cannot commit its cursor must
    // not deliver, which is the half the store's own bound already gave us.
    expect(subjectSeen).toEqual([]);

    controlRef.stop();
    subjectRef.stop();
    await fixture.system.terminate();
  });

  test('a transient offset-store outage is counted, then clears when the load succeeds', async () => {
    const fixture = newFixture('proj-cursor-transient');
    await fixture.journal.append('counter', [{ event: { n: 1 } }, { event: { n: 2 } }], 0);
    // Two failures, then success: inside `defaultStrategy`'s ten restarts, so
    // this is the recovering case and not a second copy of the one above.
    const offsetStore = new FlakyOffsetStore(2);

    const seen: number[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<{ n: number }>()
      .withName('flaky-cursor-projection')
      .withQuery(fixture.query)
      .withOffsetStore(offsetStore)
      .withPersistenceId('counter')
      .withHandle((event) => { seen.push(event.event.n); })
      .withLiveOptions({ pollIntervalMs: 30 });
    const ref = ProjectionActor.byPersistenceId<{ n: number }>(fixture.system, projectionOptions);

    await awaitCondition(() => seen.length >= 2, {
      timeoutMs: 4_000,
      label: 'the projection recovered from the outage and delivered both events',
    });

    // The counter is monotonic, so it still carries what happened; the gauge
    // is a level and must have come back down.  Both halves matter: a repair
    // that only ever raised the alert would leave a recovered projection
    // permanently stalled.
    expect(pollFailures(fixture.system, 'flaky-cursor-projection')).toBe(2);
    expect(stalledGauge(fixture.system, 'flaky-cursor-projection')).toBe(0);
    expect(offsetStore.loadAttempts).toBe(3);

    // A second projection name, asserted the same way, is what makes the
    // first test's log assertion about the *field* rather than about one
    // string.  Measured: with `${this.options.name}` replaced by the literal
    // `orders-projection`, the first test stayed green and this one goes red.
    expect(fixture.logger.errorsNaming('flaky-cursor-projection')).toHaveLength(2);

    ref.stop();
    await fixture.system.terminate();
  });
});
