/**
 * BackoffSupervisor — restart-with-backoff (#48).
 *
 * The unit-of-test is the supervisor wrapping a single child.  We
 * inject a fake `clock` and a deterministic `policy` so the timing
 * is reproducible without sleeping for real wall-clock seconds.
 *
 * What we cover:
 *   - First restart waits the policy delay; each subsequent one waits
 *     the next policy delay (covered with a simple "step counter"
 *     policy).
 *   - The reset rule (`after-min-stable`) actually resets the counter
 *     once the child has been alive long enough.
 *   - Stash mode buffers messages while the child is dead and replays
 *     them — preserving senders — once the child is back.
 *   - Drop mode discards them silently.
 *   - The supervisor's child is implicitly run under `stoppingStrategy`,
 *     so a thrown error converts to a Stop and triggers the backoff
 *     path (rather than an immediate restart at the cell level).
 *   - Stopping the supervisor cancels any pending respawn timer.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ask } from '../../../src/Ask.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Props } from '../../../src/Props.js';
import {
  BackoffSupervisor,
  type BackoffOptions,
} from '../../../src/pattern/BackoffSupervisor.js';
import type { BackoffPolicy } from '../../../src/pattern/BackoffPolicy.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/** Records each `delayFor(n)` call so tests can assert exact restart counts. */
class RecordingPolicy implements BackoffPolicy {
  readonly calls: number[] = [];
  constructor(public readonly delays: ReadonlyArray<number>) {}
  delayFor(n: number): number {
    this.calls.push(n);
    return this.delays[Math.min(n, this.delays.length - 1)] ?? 5;
  }
}

/* ---------------------- Test child actors --------------------- */

type FlakyMsg =
  | { kind: 'crash' }
  | { kind: 'echo'; value: number };

let crashesObserved = 0;

class Flaky extends Actor<FlakyMsg> {
  override onReceive(message: FlakyMsg): void {
    if (message.kind === 'crash') {
      crashesObserved += 1;
      throw new Error('flaky boom');
    }
    // ask-style echo back to the original sender (which the supervisor
    // forwarded for us).
    this.sender.toNullable()?.tell(message.value);
  }
}

/** Crashes during preStart `crashCount` times, then runs normally. */
let preStartCrashCounter = { left: 0 };

class FailingPreStart extends Actor<{ kind: 'echo'; value: number }> {
  override preStart(): void {
    if (preStartCrashCounter.left > 0) {
      preStartCrashCounter.left -= 1;
      throw new Error('preStart failure');
    }
  }
  override onReceive(m: { kind: 'echo'; value: number }): void {
    this.sender.toNullable()?.tell(m.value);
  }
}

/* ---------------------- Helpers --------------------- */

function newSystem(name: string): ActorSystem {
  return ActorSystem.create(name, { logger: new NoopLogger(), logLevel: LogLevel.Off });
}

function withDefaults<T>(over: Partial<BackoffOptions<T>>): BackoffOptions<T> {
  return {
    childProps: Props.create(() => new Flaky()) as unknown as Props<T>,
    minBackoff: 50,
    maxBackoff: 5_000,
    randomFactor: 0,
    ...over,
  };
}

/* ============================================================== */
/* Tests                                                          */
/* ============================================================== */

describe('BackoffSupervisor — restart cadence', () => {
  test('first crash waits the first policy delay; second crash waits the next', async () => {
    crashesObserved = 0;
    const sys = newSystem('backoff-cadence');
    const policy = new RecordingPolicy([40, 80, 160]);
    const supervisor = sys.actorOf(
      BackoffSupervisor.props(withDefaults({
        childProps: Props.create(() => new Flaky()),
        policy,
        // disable the time-based reset so consecutive crashes accumulate
        resetCounter: 'never',
      })),
      'sup-cadence',
    );
    try {
      // First crash → policy.delayFor(0) → 40ms wait, then respawn.
      supervisor.tell({ kind: 'crash' });
      await sleep(120);
      // Second crash → policy.delayFor(1) → 80ms wait.
      supervisor.tell({ kind: 'crash' });
      await sleep(160);

      expect(crashesObserved).toBe(2);
      // Two scheduling decisions, with restart-counts 0 then 1.
      expect(policy.calls).toEqual([0, 1]);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);

  test('after a stable run >= minBackoff, the counter resets to 0', async () => {
    crashesObserved = 0;
    const sys = newSystem('backoff-reset');
    const policy = new RecordingPolicy([20, 40, 80, 160]);
    const supervisor = sys.actorOf(
      BackoffSupervisor.props(withDefaults({
        childProps: Props.create(() => new Flaky()),
        policy,
        // 'after-min-stable' threshold = minBackoff (50ms).  We let the
        // child run for 200ms before crashing again.
        resetCounter: 'after-min-stable',
      })),
      'sup-reset',
    );
    try {
      supervisor.tell({ kind: 'crash' });
      await sleep(80);                        // wait past the 20ms backoff
      // Child now alive; let it stay alive past minBackoff so the reset triggers.
      await sleep(120);
      supervisor.tell({ kind: 'crash' });
      await sleep(80);

      // Two `delayFor` calls — both at index 0 because the counter reset
      // before the second crash.
      expect(policy.calls).toEqual([0, 0]);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);
});

describe('BackoffSupervisor — message forwarding', () => {
  test('stash mode buffers messages during backoff and forwards them with original senders', async () => {
    crashesObserved = 0;
    const sys = newSystem('backoff-stash');
    const supervisor = sys.actorOf(
      BackoffSupervisor.props(withDefaults({
        childProps: Props.create(() => new Flaky()),
        // Slow the respawn down so we have a clear backoff window.
        policy: new RecordingPolicy([120]),
        forward: 'stash',
        resetCounter: 'never',
      })),
      'sup-stash',
    );
    try {
      // Crash the child, then wait briefly for the Terminated event
      // to reach the supervisor — only after that does an ask actually
      // land in the stash (rather than forwarded to the dying child).
      supervisor.tell({ kind: 'crash' });
      await sleep(30);
      // Now the supervisor is in its backoff window; ask sits in the
      // stash, gets drained when the new child spawns, and replies.
      const reply = await ask<unknown, number>(supervisor, { kind: 'echo', value: 42 }, 1_000);
      expect(reply).toBe(42);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);

  test('drop mode discards messages during the backoff window', async () => {
    crashesObserved = 0;
    const sys = newSystem('backoff-drop');
    const supervisor = sys.actorOf(
      BackoffSupervisor.props(withDefaults({
        childProps: Props.create(() => new Flaky()),
        policy: new RecordingPolicy([100]),
        forward: 'drop',
        resetCounter: 'never',
      })),
      'sup-drop',
    );
    try {
      supervisor.tell({ kind: 'crash' });
      // Wait for the supervisor to enter backoff (currentChild = null).
      await sleep(30);
      // Now: this ask hits drop mode and never reaches a child.
      let timedOut = false;
      try { await ask<unknown, number>(supervisor, { kind: 'echo', value: 1 }, 50); }
      catch { timedOut = true; }
      expect(timedOut).toBe(true);

      // After the backoff completes, a fresh ask gets through.
      await sleep(120);
      const reply = await ask<unknown, number>(supervisor, { kind: 'echo', value: 99 }, 500);
      expect(reply).toBe(99);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);
});

describe('BackoffSupervisor — preStart failures', () => {
  test('a child that crashes in preStart still triggers the backoff path', async () => {
    preStartCrashCounter = { left: 2 };  // crash twice, then succeed
    const sys = newSystem('backoff-prestart');
    const policy = new RecordingPolicy([40, 80]);
    const supervisor = sys.actorOf(
      BackoffSupervisor.props(withDefaults({
        childProps: Props.create(() => new FailingPreStart()),
        policy,
        resetCounter: 'never',
      })),
      'sup-prestart',
    );
    try {
      // Two preStart failures with delays 40 + 80 ms — give the cycle
      // time to land on the third child before asking.
      await sleep(200);
      const reply = await ask<unknown, number>(
        supervisor, { kind: 'echo', value: 7 }, 500,
      );
      expect(reply).toBe(7);
      // Two restarts were scheduled: first at count=0, second at count=1.
      expect(policy.calls).toEqual([0, 1]);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);
});

describe('BackoffSupervisor — lifecycle', () => {
  test('stopping the supervisor cancels the pending respawn timer', async () => {
    crashesObserved = 0;
    const sys = newSystem('backoff-cancel');
    const policy = new RecordingPolicy([300]);  // long backoff
    const supervisor = sys.actorOf(
      BackoffSupervisor.props(withDefaults({
        childProps: Props.create(() => new Flaky()),
        policy,
      })),
      'sup-cancel',
    );

    supervisor.tell({ kind: 'crash' });
    // Mid-backoff: stop the supervisor.  The respawn timer should be
    // cancelled — no new child spawn should happen.
    await sleep(50);
    supervisor.stop();
    await sleep(400);
    // policy.delayFor was called exactly once (for the very first
    // scheduled respawn) and no second respawn ever happened.
    expect(policy.calls).toEqual([0]);
    await sys.terminate();
  }, 5_000);

  test('rejects illegal options at construction', () => {
    expect(() => new BackoffSupervisor({
      childProps: Props.create(() => new Flaky()),
      minBackoff: 0,
      maxBackoff: 100,
    })).toThrow(/minBackoff/);
    expect(() => new BackoffSupervisor({
      childProps: Props.create(() => new Flaky()),
      minBackoff: 100,
      maxBackoff: 50,
    })).toThrow(/maxBackoff/);
    expect(() => new BackoffSupervisor({
      childProps: Props.create(() => new Flaky()),
      minBackoff: 100,
      maxBackoff: 1000,
      resetCounter: { kind: 'after-time', ms: -1 },
    })).toThrow(/resetCounter/);
  });
});

/* ============================================================== */
/* triggerOn modes (#68)                                          */
/* ============================================================== */

/** Child that stops itself cleanly the first time it gets a `stop` cmd. */
type SelfStopMsg = { kind: 'stop' } | { kind: 'crash' } | { kind: 'echo'; value: number };

let lifecycleStops = 0;
let lifecycleSpawns = 0;

class SelfStopChild extends Actor<SelfStopMsg> {
  constructor() { super(); lifecycleSpawns += 1; }
  override onReceive(m: SelfStopMsg): void {
    if (m.kind === 'stop') {
      lifecycleStops += 1;
      // Clean self-stop — parent (the BackoffSupervisor) sees this as
      // a non-failure termination.  triggerOn='failure' should NOT
      // respawn; triggerOn='stop' or 'any' SHOULD.
      this.context.stop(this.self);
      return;
    }
    if (m.kind === 'crash') {
      throw new Error('intentional crash');
    }
    this.sender.toNullable()?.tell(m.value);
  }
}

describe('BackoffSupervisor — triggerOn modes (#68)', () => {
  test('triggerOn=failure: child crash respawns; clean self-stop does NOT', async () => {
    lifecycleSpawns = 0; lifecycleStops = 0;
    const sys = newSystem('backoff-trigger-failure');
    const supervisor = sys.actorOf(
      BackoffSupervisor.props({
        childProps: Props.create(() => new SelfStopChild()),
        minBackoff: 30,
        maxBackoff: 200,
        randomFactor: 0,
        triggerOn: 'failure',
      }),
      'sup-failure',
    );
    try {
      // 1) Crash the child — supervisor must respawn (failure matches).
      supervisor.tell({ kind: 'crash' });
      await sleep(120);
      expect(lifecycleSpawns).toBeGreaterThanOrEqual(2); // initial + at least 1 respawn

      // 2) Clean self-stop — supervisor must stop itself, no respawn.
      const spawnsBeforeStop = lifecycleSpawns;
      supervisor.tell({ kind: 'stop' });
      await sleep(120);
      expect(lifecycleStops).toBe(1);
      // No respawn happened: spawn count stays put.
      expect(lifecycleSpawns).toBe(spawnsBeforeStop);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);

  test('triggerOn=stop: clean self-stop respawns; child crash does NOT', async () => {
    lifecycleSpawns = 0; lifecycleStops = 0;
    const sys = newSystem('backoff-trigger-stop');
    const supervisor = sys.actorOf(
      BackoffSupervisor.props({
        childProps: Props.create(() => new SelfStopChild()),
        minBackoff: 30,
        maxBackoff: 200,
        randomFactor: 0,
        triggerOn: 'stop',
      }),
      'sup-stop',
    );
    try {
      // 1) Clean self-stop — must respawn.
      supervisor.tell({ kind: 'stop' });
      await sleep(120);
      expect(lifecycleStops).toBe(1);
      expect(lifecycleSpawns).toBeGreaterThanOrEqual(2);

      // 2) Crash — supervisor must stop itself, no respawn.
      const spawnsBeforeCrash = lifecycleSpawns;
      supervisor.tell({ kind: 'crash' });
      await sleep(120);
      expect(lifecycleSpawns).toBe(spawnsBeforeCrash);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);

  test('triggerOn=any (default): both crash AND clean self-stop respawn', async () => {
    lifecycleSpawns = 0; lifecycleStops = 0;
    const sys = newSystem('backoff-trigger-any');
    const supervisor = sys.actorOf(
      BackoffSupervisor.props({
        childProps: Props.create(() => new SelfStopChild()),
        minBackoff: 30,
        maxBackoff: 200,
        randomFactor: 0,
        // triggerOn omitted — default 'any'.
      }),
      'sup-any',
    );
    try {
      supervisor.tell({ kind: 'crash' });
      await sleep(120);
      const afterCrash = lifecycleSpawns;
      supervisor.tell({ kind: 'stop' });
      await sleep(120);
      // Both terminations triggered respawns: spawn count grew twice.
      expect(afterCrash).toBeGreaterThanOrEqual(2);
      expect(lifecycleSpawns).toBeGreaterThan(afterCrash);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);
});
