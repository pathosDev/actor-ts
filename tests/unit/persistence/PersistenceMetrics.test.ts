import { describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import type { MetricSample, MetricsRegistry } from '../../../src/metrics/Metrics.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { CircuitBreakerOpenError, CircuitBreakerTimeoutError } from '../../../src/pattern/CircuitBreaker.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import {
  JournalConcurrencyError,
  type JournalEntry,
  type PersistentEvent,
  type Snapshot,
} from '../../../src/persistence/JournalTypes.js';
import { PersistenceExtensionId } from '../../../src/persistence/PersistenceExtension.js';
import { PersistentActor } from '../../../src/persistence/PersistentActor.js';
import { JournalIntegrityError } from '../../../src/persistence/Replay.js';
import { InMemorySnapshotStore } from '../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import type { SnapshotStore } from '../../../src/persistence/SnapshotStore.js';
import type { Scheduler } from '../../../src/Scheduler.js';
import type { Option } from '../../../src/util/Option.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import type { ConfigObject } from '../../../src/index.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { createTestActorSystem } from '../../util/TestActorSystem.js';
import { minimumElapsedMs } from '../../util/TimerTolerance.js';
import { JournalUnavailableError } from '../../util/UnavailableJournal.js';

/**
 * #1496 — what the two persistence breaker seams report while metrics are on.
 *
 * Every journal and snapshot-store call a `PersistentActor` makes runs through
 * `PersistenceExtension.callThroughJournalBreaker` / `callThroughSnapshotBreaker`,
 * so those two methods are where a store's latency and its failures are
 * visible at all.  The breaker is no signal for slowness — with no
 * `call-timeout` shipped, a slow success is a success — so the histogram is the
 * only early warning a degrading backend gives, and the failure counter is what
 * tells an outage from an ownership verdict or a trust failure.
 */

const JOURNAL_LATENCY = 'persistence_journal_latency_seconds';
const SNAPSHOT_LATENCY = 'persistence_snapshot_latency_seconds';
const JOURNAL_FAILURES = 'persistence_journal_failures_total';
const SNAPSHOT_FAILURES = 'persistence_snapshot_failures_total';
const BREAKER_STATE = 'persistence_breaker_state';
const APPEND = { operation: 'append' } as const;

const metricsSystemOf = (config?: ConfigObject) => {
  const system = createTestActorSystem({ name: 'persistence-metrics', ...(config ? { config } : {}) });
  const registry = system.extension(MetricsExtensionId).enable();
  return { system, registry, extension: system.extension(PersistenceExtensionId) };
};

/** Every sample of `family` whose labels carry each pair in `labels`. */
function samplesOf(
  registry: MetricsRegistry,
  family: string,
  labels: Readonly<Record<string, string>> = {},
): MetricSample[] {
  return registry.collect().filter((sample) => sample.name === family
    && Object.entries(labels).every(([key, value]) => sample.labels[key] === value));
}

/** Observations in one histogram series — `0` when the series was never minted. */
function observationsOf(registry: MetricsRegistry, family: string, labels: Readonly<Record<string, string>>): number {
  return samplesOf(registry, family, labels).find((sample) => sample.count !== undefined)?.count ?? 0;
}

/** Observations above `bound` seconds: the series' count minus its cumulative bucket at `bound`. */
function observationsAbove(
  registry: MetricsRegistry,
  family: string,
  labels: Readonly<Record<string, string>>,
  bound: number,
): number {
  const atOrBelow = samplesOf(registry, family, labels).find((sample) => sample.bucket === bound)?.value ?? 0;
  return observationsOf(registry, family, labels) - atOrBelow;
}

/** One failure series' value — `0` when it was never minted. */
function failuresOf(registry: MetricsRegistry, family: string, operation: string, reason: string): number {
  return samplesOf(registry, family, { operation, reason })[0]?.value ?? 0;
}

/** `persistence_breaker_state` for one breaker, or `undefined` when it has no series. */
function breakerStateOf(registry: MetricsRegistry, breaker: 'journal' | 'snapshot'): number | undefined {
  return samplesOf(registry, BREAKER_STATE, { breaker })[0]?.value;
}

/** The `operation` values a family has a series for, sorted. */
function operationsOf(registry: MetricsRegistry, family: string): string[] {
  return [...new Set(samplesOf(registry, family).map((sample) => String(sample.labels['operation'])))].sort();
}

/* ------------------------------ the fixtures ------------------------------ */

type DepositCommand = { readonly kind: 'deposit'; readonly amount: number };
type SnapshotCommand = { readonly kind: 'snapshot' };
type CompactCommand = { readonly kind: 'compact'; readonly toSequenceNr: number };
type LedgerCommand = DepositCommand | SnapshotCommand | CompactCommand;
type DepositedEvent = { readonly kind: 'deposited'; readonly amount: number };
type LedgerState = { readonly balance: number };
type StepOutcome = Error | 'done';

/** Everything the tests read, recorded outside the actors. */
type Observations = {
  readonly recovered: string[];
  readonly recoveryFailures: Error[];
  readonly steps: StepOutcome[];
};

const newObservations = (): Observations => ({ recovered: [], recoveryFailures: [], steps: [] });

/** A ledger whose every command is one store-touching step. */
class Ledger extends PersistentActor<LedgerCommand, DepositedEvent, LedgerState> {
  constructor(readonly persistenceId: string, private readonly observations: Observations) { super(); }

  initialState(): LedgerState { return { balance: 0 }; }

  onEvent(state: LedgerState, event: DepositedEvent): LedgerState {
    return { balance: state.balance + event.amount };
  }

  override onRecoveryComplete(): void { this.observations.recovered.push(this.persistenceId); }

  /** Records and returns, so a failed recovery stops the actor instead of restarting it. */
  override onRecoveryFailure(reason: Error): void { this.observations.recoveryFailures.push(reason); }

  async onCommand(_state: LedgerState, command: LedgerCommand): Promise<void> {
    await match(command)
      .with({ kind: 'deposit' }, (deposit) => this.onDeposit(deposit))
      .with({ kind: 'snapshot' }, () => this.onSnapshot())
      .with({ kind: 'compact' }, (compact) => this.onCompact(compact))
      .exhaustive();
  }

  private onDeposit(command: DepositCommand): Promise<void> {
    return this.recordStep(() => this.persist({ kind: 'deposited', amount: command.amount }));
  }

  private onSnapshot(): Promise<void> {
    return this.recordStep(() => this.saveSnapshot());
  }

  private onCompact(command: CompactCommand): Promise<void> {
    return this.recordStep(() => this.deleteHistory(command.toSequenceNr));
  }

  /** Run one step and record how it ended, so a failing store does not restart the actor. */
  private async recordStep(step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
      this.observations.steps.push('done');
    } catch (e) {
      this.observations.steps.push(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

/** An in-memory journal whose appends can be slowed — a backend degrading without failing. */
class DegradingJournal extends InMemoryJournal {
  appendDelayMs = 0;

  constructor(private readonly scheduler: Scheduler) { super(); }

  override async append<E>(
    persistenceId: string,
    entries: ReadonlyArray<JournalEntry<E>>,
    expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    // The delay is the condition under test — a backend that answers slowly —
    // and not a wait before an assertion, so it runs inside the store call.
    if (this.appendDelayMs > 0) await this.delayed(this.appendDelayMs);
    return super.append(persistenceId, entries, expectedSeq);
  }

  private delayed(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => { this.scheduler.scheduleOnceFunction(delayMs, resolve); });
  }
}

/** Reads like a healthy journal; every append is refused with the error the test names. */
class AppendRefusingJournal extends InMemoryJournal {
  constructor(private readonly refusal: () => Error) { super(); }

  override async append<E>(): Promise<PersistentEvent<E>[]> { throw this.refusal(); }
}

/** A hole in the middle of the stream — what a crash inside a claimed sequence range leaves. */
class HoledJournal extends InMemoryJournal {
  override async read<E>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    const events = await super.read<E>(persistenceId, fromSeq, toSeq);
    return events.filter((event) => event.sequenceNr !== 2);
  }
}

/** Every call throws — the snapshot store is simply gone. */
class UnreachableSnapshotStore implements SnapshotStore {
  async save<S>(): Promise<Snapshot<S>> { throw new Error('snapshot store is unreachable'); }
  async loadLatest<S>(): Promise<Option<Snapshot<S>>> { throw new Error('snapshot store is unreachable'); }
  async loadBefore<S>(): Promise<Option<Snapshot<S>>> { throw new Error('snapshot store is unreachable'); }
  async delete(): Promise<void> { throw new Error('snapshot store is unreachable'); }
}

/* -------------------------------- the tests -------------------------------- */

describe('Persistence seam metrics (#1496)', () => {
  test('every store call a PersistentActor makes is observed under its own operation', async () => {
    const { system, registry, extension } = metricsSystemOf();
    extension.configure({ journal: new InMemoryJournal(), snapshotStore: new InMemorySnapshotStore() });
    const observations = newObservations();
    try {
      const ledger = system.spawn(() => new Ledger('ledger-every-call', observations), 'ledger-every-call');
      await awaitCondition(() => observations.recovered.length === 1, { label: 'the ledger recovered' });
      ledger.tell({ kind: 'deposit', amount: 5 });
      ledger.tell({ kind: 'snapshot' });
      ledger.tell({ kind: 'compact', toSequenceNr: 1 });
      await awaitCondition(() => observations.steps.length === 3, { label: 'all three steps settled' });

      expect(observations.steps).toEqual(['done', 'done', 'done']);
      // Recovery is one `load` and one `replay`; the three commands are one
      // `append`, one `save`, and one `delete` per store.
      expect(operationsOf(registry, JOURNAL_LATENCY)).toEqual(['append', 'delete', 'replay']);
      expect(operationsOf(registry, SNAPSHOT_LATENCY)).toEqual(['delete', 'load', 'save']);
      for (const operation of ['append', 'delete', 'replay']) {
        expect(observationsOf(registry, JOURNAL_LATENCY, { operation })).toBe(1);
      }
      for (const operation of ['delete', 'load', 'save']) {
        expect(observationsOf(registry, SNAPSHOT_LATENCY, { operation })).toBe(1);
      }
      expect(samplesOf(registry, JOURNAL_FAILURES)).toEqual([]);
      expect(samplesOf(registry, SNAPSHOT_FAILURES)).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('a slow journal raises the latency buckets while the breaker stays closed', async () => {
    const slowAppendMs = 150;
    // The premise the bucket assertion below rests on, checked rather than assumed.
    expect(minimumElapsedMs(slowAppendMs) / 1_000).toBeGreaterThan(0.1);

    const { system, registry, extension } = metricsSystemOf();
    const journal = new DegradingJournal(system.scheduler);
    extension.configure({ journal, snapshotStore: new InMemorySnapshotStore() });
    const observations = newObservations();
    try {
      const ledger = system.spawn(() => new Ledger('ledger-degrading', observations), 'ledger-degrading');
      await awaitCondition(() => observations.recovered.length === 1, { label: 'the ledger recovered' });
      ledger.tell({ kind: 'deposit', amount: 1 });
      await awaitCondition(() => observations.steps.length === 1, { label: 'the healthy append settled' });
      const slowBefore = observationsAbove(registry, JOURNAL_LATENCY, APPEND, 0.1);

      journal.appendDelayMs = slowAppendMs;
      for (let i = 0; i < 3; i++) ledger.tell({ kind: 'deposit', amount: 1 });
      await awaitCondition(() => observations.steps.length === 4, {
        timeoutMs: 3_000,
        label: 'the three slow appends settled',
      });

      expect(observations.steps).toEqual(['done', 'done', 'done', 'done']);
      expect(observationsOf(registry, JOURNAL_LATENCY, APPEND)).toBe(4);
      expect(observationsAbove(registry, JOURNAL_LATENCY, APPEND, 0.1) - slowBefore).toBe(3);
      // The breaker never noticed, and could not have: a slow success is a success.
      expect(extension.journalBreaker!.state).toBe('closed');
      expect(samplesOf(registry, JOURNAL_FAILURES)).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('outage, ownership and integrity land on different reason series', async () => {
    const { system, registry, extension } = metricsSystemOf();
    const observations = newObservations();
    try {
      // `PersistentActor` resolves its stores in `preStart`, so each ledger
      // keeps the journal configured when it was spawned.
      extension.configure({ journal: new AppendRefusingJournal(() => new JournalUnavailableError('append')) });
      const unavailable = system.spawn(() => new Ledger('ledger-unavailable', observations), 'ledger-unavailable');
      await awaitCondition(() => observations.recovered.length === 1, { label: 'the first ledger recovered' });
      unavailable.tell({ kind: 'deposit', amount: 1 });
      await awaitCondition(() => observations.steps.length === 1, { label: 'the refused append settled' });

      extension.configure({
        journal: new AppendRefusingJournal(() => new JournalConcurrencyError('ledger-owned', 0, 3)),
      });
      const owned = system.spawn(() => new Ledger('ledger-owned', observations), 'ledger-owned');
      await awaitCondition(() => observations.recovered.length === 2, { label: 'the second ledger recovered' });
      owned.tell({ kind: 'deposit', amount: 1 });
      await awaitCondition(() => observations.steps.length === 2, { label: 'the losing append settled' });

      const holed = new HoledJournal();
      await holed.append<DepositedEvent>('ledger-holed', [1, 2, 3].map((amount) => ({
        event: { kind: 'deposited', amount },
      })), 0);
      extension.configure({ journal: holed });
      system.spawn(() => new Ledger('ledger-holed', observations), 'ledger-holed');
      await awaitCondition(() => observations.recoveryFailures.length === 1, { label: 'the holed replay failed' });

      expect(observations.steps[0]).toBeInstanceOf(JournalUnavailableError);
      expect(observations.steps[1]).toBeInstanceOf(JournalConcurrencyError);
      expect(observations.recoveryFailures[0]).toBeInstanceOf(JournalIntegrityError);

      expect(failuresOf(registry, JOURNAL_FAILURES, 'append', 'outage')).toBe(1);
      expect(failuresOf(registry, JOURNAL_FAILURES, 'append', 'ownership')).toBe(1);
      expect(failuresOf(registry, JOURNAL_FAILURES, 'replay', 'integrity')).toBe(1);
      expect(samplesOf(registry, JOURNAL_FAILURES)).toHaveLength(3);
      // All three reached the store, so all three were timed — failing is not
      // the same as never having been asked.
      expect(observationsOf(registry, JOURNAL_LATENCY, APPEND)).toBe(2);
      expect(observationsOf(registry, JOURNAL_LATENCY, { operation: 'replay' })).toBe(3);
    } finally {
      await system.terminate();
    }
  });

  test('breaker-open never reaches the histogram, and a timeout is a reason of its own', async () => {
    const { system, registry, extension } = metricsSystemOf({
      'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'max-failures': 1, 'call-timeout': '30ms' } } },
    });
    try {
      await expect(extension.callThroughJournalBreaker('append', () => new Promise<never>(() => {})))
        .rejects.toBeInstanceOf(CircuitBreakerTimeoutError);
      expect(extension.journalBreaker!.state).toBe('open');
      let asked = 0;
      for (let i = 0; i < 3; i++) {
        await expect(extension.callThroughJournalBreaker('append', async () => { asked++; }))
          .rejects.toBeInstanceOf(CircuitBreakerOpenError);
      }
      expect(asked).toBe(0);

      expect(failuresOf(registry, JOURNAL_FAILURES, 'append', 'timeout')).toBe(1);
      expect(failuresOf(registry, JOURNAL_FAILURES, 'append', 'breaker-open')).toBe(3);
      // One observation — the call that waited out its timeout — and none for
      // the three the open breaker refused, which would otherwise drag every
      // quantile to zero exactly while the store is down.
      expect(observationsOf(registry, JOURNAL_LATENCY, APPEND)).toBe(1);
      expect(observationsAbove(registry, JOURNAL_LATENCY, APPEND, 0.025)).toBe(1);
    } finally {
      await system.terminate();
    }
  });

  test('an error ignored-error-names excuses is still counted, under the reason its class gives', async () => {
    const { system, registry, extension } = metricsSystemOf({
      'actor-ts': {
        'circuit-breaker': {
          'persistence-journal': { 'max-failures': 2, 'ignored-error-names': ['JournalUnavailableError'] },
        },
      },
    });
    try {
      for (let i = 0; i < 3; i++) {
        await expect(extension.callThroughJournalBreaker('append', async () => {
          throw new JournalUnavailableError('append');
        })).rejects.toBeInstanceOf(JournalUnavailableError);
      }
      // The list decides what trips the breaker; the counter reports what happened.
      expect(extension.journalBreaker!.state).toBe('closed');
      expect(failuresOf(registry, JOURNAL_FAILURES, 'append', 'outage')).toBe(3);
    } finally {
      await system.terminate();
    }
  });

  test('a snapshot store that cannot answer is counted on the snapshot families, never the journal\'s', async () => {
    const { system, registry, extension } = metricsSystemOf({
      'actor-ts': { persistence: { 'snapshot-is-optional': true } },
    });
    extension.configure({ journal: new InMemoryJournal(), snapshotStore: new UnreachableSnapshotStore() });
    const observations = newObservations();
    try {
      const ledger = system.spawn(() => new Ledger('ledger-no-snapshots', observations), 'ledger-no-snapshots');
      await awaitCondition(() => observations.recovered.length === 1, { label: 'recovered by a full replay' });
      ledger.tell({ kind: 'snapshot' });
      await awaitCondition(() => observations.steps.length === 1, { label: 'the refused save settled' });

      // The tolerated load is still a failure the store had, and is counted.
      expect(failuresOf(registry, SNAPSHOT_FAILURES, 'load', 'outage')).toBe(1);
      expect(failuresOf(registry, SNAPSHOT_FAILURES, 'save', 'outage')).toBe(1);
      expect(observationsOf(registry, SNAPSHOT_LATENCY, { operation: 'load' })).toBe(1);
      expect(observationsOf(registry, SNAPSHOT_LATENCY, { operation: 'save' })).toBe(1);
      expect(samplesOf(registry, JOURNAL_FAILURES)).toEqual([]);
      expect(observationsOf(registry, JOURNAL_LATENCY, { operation: 'replay' })).toBe(1);
    } finally {
      await system.terminate();
    }
  });

  test('the live registry is read on every call, so nothing is written while metrics are off', async () => {
    const system = createTestActorSystem({ name: 'persistence-metrics-toggle' });
    const metrics = system.extension(MetricsExtensionId);
    const extension = system.extension(PersistenceExtensionId);
    try {
      await extension.callThroughJournalBreaker('append', async () => 'before enable');
      const registry = metrics.enable();
      await extension.callThroughJournalBreaker('append', async () => 'enabled');
      expect(observationsOf(registry, JOURNAL_LATENCY, APPEND)).toBe(1);

      metrics.disable();
      await extension.callThroughJournalBreaker('append', async () => 'after disable');
      // A registry that was switched off is not written to behind the operator's back.
      expect(observationsOf(registry, JOURNAL_LATENCY, APPEND)).toBe(1);
    } finally {
      await system.terminate();
    }
  });
});

/**
 * `persistence_breaker_state{breaker}` — the one place the two persistence
 * breakers' state reaches a scrape.  0 closed, 1 half-open, 2 open: ordered by
 * how much of the store's traffic is being refused.
 */
describe('Persistence breaker-state gauge (#1496)', () => {
  test('follows each breaker through open, half-open and closed, the two apart', async () => {
    const { system, registry, extension } = metricsSystemOf({
      'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'max-failures': 1 } } },
    });
    try {
      // Resolving a breaker publishes its state, before anything has moved.
      expect(extension.journalBreaker).not.toBeNull();
      expect(extension.snapshotBreaker).not.toBeNull();
      expect(breakerStateOf(registry, 'journal')).toBe(0);
      expect(breakerStateOf(registry, 'snapshot')).toBe(0);

      await expect(extension.callThroughJournalBreaker('append', async () => {
        throw new JournalUnavailableError('append');
      })).rejects.toBeInstanceOf(JournalUnavailableError);
      expect(breakerStateOf(registry, 'journal')).toBe(2);
      expect(breakerStateOf(registry, 'snapshot')).toBe(0);

      // The reset window is wall-clock time on a breaker resolved by id, so the
      // probe state is entered by hand — every transition fires the listener.
      extension.journalBreaker!.setState('half-open');
      expect(breakerStateOf(registry, 'journal')).toBe(1);
      await expect(extension.callThroughJournalBreaker('append', async () => 'probe')).resolves.toBe('probe');
      expect(breakerStateOf(registry, 'journal')).toBe(0);
    } finally {
      await system.terminate();
    }
  });

  test('a registry installed after the breakers were resolved is given their state on the next call', async () => {
    const system = createTestActorSystem({ name: 'persistence-metrics-late-registry' });
    const extension = system.extension(PersistenceExtensionId);
    try {
      // Resolved and opened while metrics were off — the transition had nowhere to go.
      extension.journalBreaker!.setState('open');
      const registry = system.extension(MetricsExtensionId).enable();
      expect(breakerStateOf(registry, 'journal')).toBeUndefined();

      // Any call through either seam brings the new registry up to date.
      await expect(extension.callThroughSnapshotBreaker('save', async () => 'saved')).resolves.toBe('saved');
      expect(breakerStateOf(registry, 'journal')).toBe(2);
      expect(breakerStateOf(registry, 'snapshot')).toBe(0);
    } finally {
      await system.terminate();
    }
  });

  test('a journal call never builds the snapshot breaker, so a bad snapshot block cannot fail an append', async () => {
    const { system, registry, extension } = metricsSystemOf({
      'actor-ts': { 'circuit-breaker': { 'persistence-snapshot': { 'max-failures': 0 } } },
    });
    try {
      await expect(extension.callThroughJournalBreaker('append', async () => 'appended')).resolves.toBe('appended');
      expect(breakerStateOf(registry, 'journal')).toBe(0);
      expect(breakerStateOf(registry, 'snapshot')).toBeUndefined();
      // The mistake still surfaces — where the snapshot breaker is first needed.
      expect(() => extension.snapshotBreaker).toThrow(OptionsError);
    } finally {
      await system.terminate();
    }
  });

  test('a store with no breaker has no series', async () => {
    const { system, registry, extension } = metricsSystemOf({
      'actor-ts': { persistence: { 'journal-breaker': '' } },
    });
    try {
      expect(extension.journalBreaker).toBeNull();
      expect(extension.snapshotBreaker).not.toBeNull();
      await expect(extension.callThroughJournalBreaker('append', async () => 'unguarded')).resolves.toBe('unguarded');
      expect(breakerStateOf(registry, 'journal')).toBeUndefined();
      expect(breakerStateOf(registry, 'snapshot')).toBe(0);
    } finally {
      await system.terminate();
    }
  });
});
