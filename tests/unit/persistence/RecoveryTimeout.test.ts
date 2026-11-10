import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import type { Journal } from '../../../src/persistence/Journal.js';
import {
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
  RecoveryTimeoutError,
} from '../../../src/persistence/index.js';
import { MAX_TIMER_DELAY_MS } from '../../../src/util/Constants.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { StallingJournal } from '../../util/UnavailableJournal.js';

/**
 * A `recovery-timeout` past the host timer ceiling is waited out in full
 * (found while #870).
 *
 * The recovery deadline is a host timer, and `setTimeout` cannot hold a delay
 * above {@link MAX_TIMER_DELAY_MS} (~24.9 days): Bun and Node arm one as 1 ms,
 * Deno wraps it modulo 2^32.  The validator admits any finite duration, so a
 * `recovery-timeout = 30d` failed every recovery against a store that was
 * merely slow, at once, with a `RecoveryTimeoutError` claiming thirty days had
 * passed.
 *
 * Waiting 24.9 days is not a test, so the chain is proven on the runtime's own
 * timers with the global `setTimeout` recorded, a link's callback run by hand
 * standing in for the link elapsing.  The deadline is armed asynchronously, in
 * the actor's start-up, so the recording stays installed until the replay has
 * reached the journal — by then the deadline is armed, because it is armed
 * the moment the replay begins.
 */

/** 2^31 ms — one past the largest delay a host timer holds. */
const CEILING_PLUS_ONE_MS = MAX_TIMER_DELAY_MS + 1;

type DepositCommand = { readonly kind: 'deposit'; readonly amount: number };
type Command = DepositCommand;

type DepositedEvent = { readonly kind: 'deposited'; readonly amount: number };
type Event = DepositedEvent;

type State = { readonly balance: number };

/** Everything the tests read, recorded outside the actor. */
type Observations = {
  readonly recoveryFailures: Error[];
  readonly recovered: State[];
};

const newObservations = (): Observations => ({ recoveryFailures: [], recovered: [] });

/** Records how its recovery ended instead of rethrowing a failure, so a test can read it. */
class Account extends PersistentActor<Command, Event, State> {
  readonly persistenceId: string;

  constructor(persistenceId: string, private readonly observations: Observations) {
    super();
    this.persistenceId = persistenceId;
  }

  initialState(): State { return { balance: 0 }; }

  onEvent(state: State, event: Event): State { return { balance: state.balance + event.amount }; }

  override onRecoveryComplete(state: State): void { this.observations.recovered.push(state); }

  override onRecoveryFailure(reason: Error): void { this.observations.recoveryFailures.push(reason); }

  async onCommand(_state: State, command: Command): Promise<void> {
    await this.persist({ kind: 'deposited', amount: command.amount });
  }
}

/** A system whose recovery deadline is `recoveryTimeoutMs`, recovering from `journal`. */
function systemRecoveringFrom(name: string, recoveryTimeoutMs: number, journal: Journal): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { persistence: { 'recovery-timeout': `${recoveryTimeoutMs}ms` } } });
  const system = ActorSystem.create(name, systemOptions);
  system.extension(PersistenceExtensionId).configure({ journal, snapshotStore: new InMemorySnapshotStore() });
  return system;
}

/** One call the runtime's `setTimeout` received while it was recorded. */
type RecordedTimeout = {
  readonly callback: unknown;
  readonly delayMs: unknown;
  readonly handle: ReturnType<typeof setTimeout>;
};

/** What the runtime's `setTimeout` and `clearTimeout` received while recorded. */
type RecordedTimers = {
  readonly timeouts: RecordedTimeout[];
  readonly cleared: unknown[];
};

/** Put recording primitives in place of the runtime's; the returned function puts the runtime's back. */
function recordTimersInto(recorded: RecordedTimers): () => void {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realSetTimeout(...args);
    recorded.timeouts.push({ callback: args[0], delayMs: args[1], handle });
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    recorded.cleared.push(handle);
    realClearTimeout(handle);
  }) as typeof clearTimeout;
  return () => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  };
}

/**
 * Run `act` — awaited — with the runtime's timer primitives recorded.
 * Everything the process arms in that window is recorded, the poll of
 * `awaitCondition` included, so a case picks the deadline out by its delay.
 * Every call still reaches the real primitive.
 */
async function recordingTimersWhile(act: () => Promise<void>): Promise<RecordedTimers> {
  const recorded: RecordedTimers = { timeouts: [], cleared: [] };
  const restore = recordTimersInto(recorded);
  try {
    await act();
    return recorded;
  } finally {
    restore();
  }
}

/**
 * Stand in for `timeout` elapsing: clear the real timer so it can never also
 * fire, then run its callback now, recording what that call arms — and only
 * that, because the recording ends when the callback returns.
 */
function elapse(timeout: RecordedTimeout | undefined): readonly RecordedTimeout[] {
  if (timeout === undefined) throw new Error('no timer was armed to elapse');
  clearTimeout(timeout.handle);
  const recorded: RecordedTimers = { timeouts: [], cleared: [] };
  const restore = recordTimersInto(recorded);
  try {
    (timeout.callback as () => void)();
    return recorded.timeouts;
  } finally {
    restore();
  }
}

/** The recorded timers that are links of a deadline: no poll of this suite is anywhere near this long. */
const deadlineLinks = (timeouts: readonly RecordedTimeout[]): readonly RecordedTimeout[] =>
  timeouts.filter((timeout) => typeof timeout.delayMs === 'number' && timeout.delayMs >= MAX_TIMER_DELAY_MS);

/**
 * How long a case watches for a recovery failure that must not come.  The
 * overflow failed a recovery within milliseconds of arming its deadline, so
 * the window only has to outlast that by a wide margin.
 */
const ABSENCE_WINDOW_MS = 150;

/** Whether a recovery failure arrives within {@link ABSENCE_WINDOW_MS} — an absence needs a window to be asserted in. */
async function failsWithinWindow(observations: Observations): Promise<boolean> {
  return awaitCondition(() => observations.recoveryFailures.length > 0, {
    timeoutMs: ABSENCE_WINDOW_MS,
    label: 'a recovery failure arrived',
  }).then(() => true, () => false);
}

describe('PersistentActor — a recovery-timeout past the host timer ceiling', () => {
  test('has not failed the recovery on the wall clock long after the overflow would have', async () => {
    const journal = new StallingJournal();
    const system = systemRecoveringFrom('recovery-timeout-long', CEILING_PLUS_ONE_MS, journal);
    const observations = newObservations();
    try {
      system.spawn(() => new Account('acct-long', observations), 'account');
      await awaitCondition(() => journal.inFlight >= 1, { label: 'the replay reached the journal' });
      expect(await failsWithinWindow(observations)).toBe(false);
    } finally {
      // Ends the stalled read, so the recovery fails on that instead and the
      // deadline is cleared on the way out, as it is on every path.
      journal.settleAll();
      await system.terminate();
    }
  });

  test('is a chain of host timers whose links add up to the deadline', async () => {
    const journal = new StallingJournal();
    const system = systemRecoveringFrom('recovery-timeout-chain', CEILING_PLUS_ONE_MS, journal);
    const observations = newObservations();
    try {
      const recorded = await recordingTimersWhile(async () => {
        system.spawn(() => new Account('acct-chain', observations), 'account');
        await awaitCondition(() => journal.inFlight >= 1, { label: 'the replay reached the journal' });
      });
      // One link at the ceiling, and nothing handed to the runtime above it.
      const [firstLink, ...others] = deadlineLinks(recorded.timeouts);
      expect(firstLink?.delayMs).toBe(MAX_TIMER_DELAY_MS);
      expect(others).toEqual([]);

      // 24.9 days on: a link elapsing is not the deadline passing.
      const afterFirst = elapse(firstLink);
      expect(afterFirst.map((timeout) => timeout.delayMs)).toEqual([1]);
      // Held back, so that only the hand below runs the last link: left armed,
      // the real 1 ms timer would fire inside the window and prove nothing.
      for (const timeout of afterFirst) clearTimeout(timeout.handle);
      expect(await failsWithinWindow(observations)).toBe(false);

      // The last millisecond is.
      expect(elapse(afterFirst[0])).toEqual([]);
      await awaitCondition(() => observations.recoveryFailures.length === 1, {
        label: 'the deadline failed the recovery',
      });
      expect(observations.recoveryFailures[0]).toBeInstanceOf(RecoveryTimeoutError);
      expect((observations.recoveryFailures[0] as RecoveryTimeoutError).timeoutMs).toBe(CEILING_PLUS_ONE_MS);
    } finally {
      journal.settleAll();
      await system.terminate();
    }
  });

  test('a recovery that completes clears the link that is armed, as it clears a single timer', async () => {
    // A link left armed is a referenced 24.9-day timer per recovered actor,
    // holding the process open long after the work is done — the reason the
    // deadline is cleared on every path.
    const system = systemRecoveringFrom('recovery-timeout-completes', CEILING_PLUS_ONE_MS, new InMemoryJournal());
    const observations = newObservations();
    try {
      const recorded = await recordingTimersWhile(async () => {
        system.spawn(() => new Account('acct-completes', observations), 'account');
        await awaitCondition(() => observations.recovered.length === 1, { label: 'the actor recovered' });
      });
      const [link, ...others] = deadlineLinks(recorded.timeouts);
      expect(link?.delayMs).toBe(MAX_TIMER_DELAY_MS);
      expect(others).toEqual([]);
      expect(recorded.cleared).toContain(link!.handle);
      expect(observations.recoveryFailures).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('a deadline at the ceiling is one host timer that fails the recovery itself, as it always was', async () => {
    const journal = new StallingJournal();
    const system = systemRecoveringFrom('recovery-timeout-ceiling', MAX_TIMER_DELAY_MS, journal);
    const observations = newObservations();
    try {
      const recorded = await recordingTimersWhile(async () => {
        system.spawn(() => new Account('acct-ceiling', observations), 'account');
        await awaitCondition(() => journal.inFlight >= 1, { label: 'the replay reached the journal' });
      });
      const [deadline, ...others] = deadlineLinks(recorded.timeouts);
      expect(deadline?.delayMs).toBe(MAX_TIMER_DELAY_MS);
      expect(others).toEqual([]);

      expect(elapse(deadline)).toEqual([]);
      await awaitCondition(() => observations.recoveryFailures.length === 1, {
        label: 'the deadline failed the recovery',
      });
      expect(observations.recoveryFailures[0]).toBeInstanceOf(RecoveryTimeoutError);
    } finally {
      journal.settleAll();
      await system.terminate();
    }
  });
});
