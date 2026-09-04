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
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LocalActorRef } from '../../../src/internal/LocalActorRef.js';
import { LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import { LogContext, type LogContextData } from '../../../src/LogContext.js';
import { DeadLetter, Terminated } from '../../../src/SystemMessages.js';
import type { ActorClassOrFactory } from '../../../src/Actor.js';
import {
  BackoffSupervisor,
  type BackoffOptions,
} from '../../../src/pattern/BackoffSupervisor.js';
import type { BackoffPolicy } from '../../../src/pattern/BackoffPolicy.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

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

type FlakyMessage =
  | { kind: 'crash' }
  | { kind: 'echo'; value: number };

let crashesObserved = 0;
/** Counts child incarnations, so a test can wait for a respawn to complete. */
let flakyStarts = 0;

class Flaky extends Actor<FlakyMessage> {
  override preStart(): void { flakyStarts += 1; }
  override onReceive(message: FlakyMessage): void {
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
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
}

function withDefaults<T>(over: Partial<BackoffOptions<T>>): BackoffOptions<T> {
  return {
    child: (() => new Flaky()) as unknown as ActorClassOrFactory<T>,
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
    crashesObserved = 0; flakyStarts = 0;
    const sys = newSystem('backoff-cadence');
    const policy = new RecordingPolicy([40, 80, 160]);
    const supervisor = sys.spawn(
      BackoffSupervisor.factory(withDefaults({
        child: Flaky,
        policy,
        // disable the time-based reset so consecutive crashes accumulate
        resetCounter: 'never',
      })),
      'sup-cadence',
    );
    try {
      // First crash → policy.delayFor(0) → 40ms wait, then respawn.  The
      // second crash has to land on a *live* child for the counter to advance,
      // so the wait is on the replacement having started rather than on 120 ms
      // being enough room for the 40 ms backoff plus a spawn.
      supervisor.tell({ kind: 'crash' });
      await awaitCondition(() => flakyStarts === 2, {
        timeoutMs: 4_000,
        label: 'the child was respawned after the first crash',
      });
      // Second crash → policy.delayFor(1) → 80ms wait.
      supervisor.tell({ kind: 'crash' });
      await awaitCondition(() => flakyStarts === 3, {
        timeoutMs: 4_000,
        label: 'the child was respawned after the second crash',
      });

      expect(crashesObserved).toBe(2);
      // Two scheduling decisions, with restart-counts 0 then 1.
      expect(policy.calls).toEqual([0, 1]);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);

  test('after a stable run >= minBackoff, the counter resets to 0', async () => {
    crashesObserved = 0; flakyStarts = 0;
    const sys = newSystem('backoff-reset');
    const policy = new RecordingPolicy([20, 40, 80, 160]);
    const supervisor = sys.spawn(
      BackoffSupervisor.factory(withDefaults({
        child: Flaky,
        policy,
        // 'after-min-stable' threshold = minBackoff (50ms).  We let the
        // child run for 200ms before crashing again.
        resetCounter: 'after-min-stable',
      })),
      'sup-reset',
    );
    try {
      supervisor.tell({ kind: 'crash' });
      await awaitCondition(() => flakyStarts === 2, {
        timeoutMs: 4_000,
        label: 'the child was respawned after the 20 ms backoff',
      });
      // Child now alive; let it stay alive past minBackoff so the reset
      // triggers.  This one stays a sleep — the elapsed stable time *is* what
      // the reset rule keys on, so it is the subject and not a proxy for it.
      await sleep(120);
      supervisor.tell({ kind: 'crash' });
      await awaitCondition(() => policy.calls.length === 2, {
        timeoutMs: 4_000,
        label: 'the second crash was scheduled for restart',
      });

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
    crashesObserved = 0; flakyStarts = 0;
    const sys = newSystem('backoff-stash');
    // Slow the respawn down so we have a clear backoff window.
    const policy = new RecordingPolicy([120]);
    const supervisor = sys.spawn(
      BackoffSupervisor.factory(withDefaults({
        child: Flaky,
        policy,
        forward: 'stash',
        resetCounter: 'never',
      })),
      'sup-stash',
    );
    try {
      // Crash the child, then wait for the Terminated event to reach the
      // supervisor — only after that does an ask actually land in the stash
      // (rather than being forwarded to the dying child).  `delayFor` being
      // called is that event: the supervisor calls it when it schedules the
      // respawn, so it is a direct signal rather than 30 ms of hoping.
      supervisor.tell({ kind: 'crash' });
      await awaitCondition(() => policy.calls.length === 1, {
        timeoutMs: 4_000,
        label: 'the supervisor entered its backoff window',
      });
      // Now the supervisor is in its backoff window; ask sits in the
      // stash, gets drained when the new child spawns, and replies.
      const reply = await supervisor.ask<number>({ kind: 'echo', value: 42 }, 1_000);
      expect(reply).toBe(42);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);

  test('drop mode discards messages during the backoff window', async () => {
    crashesObserved = 0; flakyStarts = 0;
    const sys = newSystem('backoff-drop');
    const policy = new RecordingPolicy([100]);
    const supervisor = sys.spawn(
      BackoffSupervisor.factory(withDefaults({
        child: Flaky,
        policy,
        forward: 'drop',
        resetCounter: 'never',
      })),
      'sup-drop',
    );
    try {
      supervisor.tell({ kind: 'crash' });
      // Wait for the supervisor to enter backoff (currentChild = null).
      await awaitCondition(() => policy.calls.length === 1, {
        timeoutMs: 4_000,
        label: 'the supervisor entered its backoff window',
      });
      // Now: this ask hits drop mode and never reaches a child.
      let timedOut = false;
      try { await supervisor.ask<number>({ kind: 'echo', value: 1 }, 50); }
      catch { timedOut = true; }
      expect(timedOut).toBe(true);

      // After the backoff completes, a fresh ask gets through.
      await awaitCondition(() => flakyStarts === 2, {
        timeoutMs: 4_000,
        label: 'the replacement child started',
      });
      const reply = await supervisor.ask<number>({ kind: 'echo', value: 99 }, 500);
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
    const supervisor = sys.spawn(
      BackoffSupervisor.factory(withDefaults({
        child: FailingPreStart,
        policy,
        resetCounter: 'never',
      })),
      'sup-prestart',
    );
    try {
      // Two preStart failures with delays 40 + 80 ms.  Waiting for the crash
      // budget to be spent *and* both restarts to have been scheduled says the
      // cycle reached the third child; 200 ms said it probably had.
      await awaitCondition(() => preStartCrashCounter.left === 0 && policy.calls.length === 2, {
        timeoutMs: 4_000,
        label: 'both preStart failures were absorbed by the backoff',
      });
      const reply = await supervisor.ask<number>({ kind: 'echo', value: 7 }, 500,);
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
    const supervisor = sys.spawn(
      BackoffSupervisor.factory(withDefaults({
        child: Flaky,
        policy,
      })),
      'sup-cancel',
    );

    supervisor.tell({ kind: 'crash' });
    // Mid-backoff: stop the supervisor.  The respawn timer should be
    // cancelled — no new child spawn should happen.  "Mid-backoff" means
    // after the respawn was scheduled, which `delayFor` having been called
    // says exactly; the 300 ms delay leaves ample room after that.
    await awaitCondition(() => policy.calls.length === 1, {
      timeoutMs: 4_000,
      label: 'the respawn was scheduled',
    });
    supervisor.stop();
    // Outliving the 300 ms backoff is the point — a plain sleep is correct.
    await sleep(400);
    // policy.delayFor was called exactly once (for the very first
    // scheduled respawn) and no second respawn ever happened.
    expect(policy.calls).toEqual([0]);
    await sys.terminate();
  }, 5_000);

  test('rejects illegal options at construction', () => {
    expect(() => new BackoffSupervisor({
      child: Flaky,
      minBackoff: 0,
      maxBackoff: 100,
    })).toThrow(/minBackoff/);
    expect(() => new BackoffSupervisor({
      child: Flaky,
      minBackoff: 100,
      maxBackoff: 50,
    })).toThrow(/maxBackoff/);
    expect(() => new BackoffSupervisor({
      child: Flaky,
      minBackoff: 100,
      maxBackoff: 1000,
      resetCounter: { kind: 'after-time', ms: -1 },
    })).toThrow(/resetCounter/);
  });
});

/* ============================================================== */
/* triggerOn modes (#68)                                          */
/* ============================================================== */

/** Child that stops itself cleanly the first time it gets a `stop` command. */
type SelfStopMessage = { kind: 'stop' } | { kind: 'crash' } | { kind: 'echo'; value: number };

let lifecycleStops = 0;
let lifecycleSpawns = 0;
/** Lets the negative "did NOT respawn" assertions anchor on the crash itself. */
let lifecycleCrashes = 0;

class SelfStopChild extends Actor<SelfStopMessage> {
  constructor() { super(); lifecycleSpawns += 1; }
  override onReceive(m: SelfStopMessage): void {
    if (m.kind === 'stop') {
      lifecycleStops += 1;
      // Clean self-stop — parent (the BackoffSupervisor) sees this as
      // a non-failure termination.  triggerOn='failure' should NOT
      // respawn; triggerOn='stop' or 'any' SHOULD.
      this.context.stop(this.self);
      return;
    }
    if (m.kind === 'crash') {
      lifecycleCrashes += 1;
      throw new Error('intentional crash');
    }
    this.sender.toNullable()?.tell(m.value);
  }
}

describe('BackoffSupervisor — triggerOn modes (#68)', () => {
  test('triggerOn=failure: child crash respawns; clean self-stop does NOT', async () => {
    lifecycleSpawns = 0; lifecycleStops = 0;
    const sys = newSystem('backoff-trigger-failure');
    const supervisor = sys.spawn(
      BackoffSupervisor.factory({
        child: SelfStopChild,
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
      await awaitCondition(() => lifecycleSpawns >= 2, {
        timeoutMs: 4_000,
        label: 'the crashed child was respawned',
      });
      expect(lifecycleSpawns).toBeGreaterThanOrEqual(2); // initial + at least 1 respawn

      // 2) Clean self-stop — supervisor must stop itself, no respawn.  The
      // "no respawn" half needs the stop to have been *handled* first: the old
      // 120 ms could expire before the message was dequeued, and the spawn
      // count would then match for the wrong reason.
      const spawnsBeforeStop = lifecycleSpawns;
      supervisor.tell({ kind: 'stop' });
      await awaitCondition(() => lifecycleStops === 1, {
        timeoutMs: 4_000,
        label: 'the child stopped itself cleanly',
      });
      // The settle window named above: 'no respawn' is an absence, so this is the
      // span in which a respawn would have moved `lifecycleSpawns`.
      await sleep(60);
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
    const supervisor = sys.spawn(
      BackoffSupervisor.factory({
        child: SelfStopChild,
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
      await awaitCondition(() => lifecycleSpawns >= 2, {
        timeoutMs: 4_000,
        label: 'the cleanly-stopped child was respawned',
      });
      expect(lifecycleStops).toBe(1);
      expect(lifecycleSpawns).toBeGreaterThanOrEqual(2);

      // 2) Crash — supervisor must stop itself, no respawn.  Anchored on the
      // crash actually being handled, then a short settle for the respawn
      // that must not come.
      const spawnsBeforeCrash = lifecycleSpawns;
      const crashesBefore = lifecycleCrashes;
      supervisor.tell({ kind: 'crash' });
      await awaitCondition(() => lifecycleCrashes > crashesBefore, {
        timeoutMs: 4_000,
        label: 'the child handled the crash message',
      });
      // The settle window: the assertion is that the spawn count did NOT move, and
      // the poll above returns on the crash itself, before a respawn could happen.
      await sleep(60);
      expect(lifecycleSpawns).toBe(spawnsBeforeCrash);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);

  test('forwardDuringGrace=false: messages during a failed-respawn grace survive (#67)', async () => {
    // Strict mode (opt-in).  preStartCrashCounter=3 → initial spawn
    // and two more respawns fail in preStart; the fourth succeeds.
    // Messages sent during those windows must end up at child #4.
    preStartCrashCounter = { left: 3 };
    const sys = newSystem('backoff-stash-survives');
    const replies: number[] = [];
    const supervisor = sys.spawn(
      BackoffSupervisor.factory<{ kind: 'echo'; value: number }>({
        child: FailingPreStart,
        minBackoff: 40,
        maxBackoff: 400,
        randomFactor: 0,
        drainGraceMs: 40,
        forwardDuringGrace: false, // strict mode — the #67 gate
      }),
      'sup-stash-survives',
    );
    try {
      // Stagger asks across the cascade.  With forwardDuringGrace=false,
      // anything that lands while currentChild is set but unconfirmed
      // gets stashed — and stays there across subsequent crashes —
      // until the eventually-successful child drains the queue.
      const firstAsk = supervisor.ask<number>({ kind: 'echo', value: 1 }, 4_000,).then((r) => replies.push(r));
      // Staggering the asks IS the fixture: each one has to land at a different
      // point of the crash/respawn cascade for the stash to be exercised at all.
      await sleep(50);
      const secondAsk = supervisor.ask<number>({ kind: 'echo', value: 2 }, 4_000,).then((r) => replies.push(r));
      // Same: the third ask has to arrive a cascade step later than the second.
      await sleep(50);
      const thirdAsk = supervisor.ask<number>({ kind: 'echo', value: 3 }, 4_000,).then((r) => replies.push(r));

      await Promise.all([firstAsk, secondAsk, thirdAsk]);
      expect(replies.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 8_000);

  test('forwardDuringGrace default (true) preserves v1 fast-forward', async () => {
    // Default mode — confirms the opt-in nature of the strict gate.
    // A single ask in the happy path round-trips immediately; we
    // don't pay drainGraceMs of latency for the absence of any
    // crash.
    const sys = newSystem('backoff-grace-default');
    const supervisor = sys.spawn(
      BackoffSupervisor.factory<{ kind: 'echo'; value: number }>({
        child: (() => new Flaky()) as unknown as ActorClassOrFactory<{ kind: 'echo'; value: number }>,
        minBackoff: 80,
        maxBackoff: 400,
        randomFactor: 0,
        drainGraceMs: 80,
        // forwardDuringGrace omitted — defaults to true.
      }),
      'sup-grace-default',
    );
    try {
      const reply = await supervisor.ask<number>({ kind: 'echo', value: 7 }, 1_000,);
      expect(reply).toBe(7);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);

  test('triggerOn=any (default): both crash AND clean self-stop respawn', async () => {
    lifecycleSpawns = 0; lifecycleStops = 0;
    const sys = newSystem('backoff-trigger-any');
    const supervisor = sys.spawn(
      BackoffSupervisor.factory({
        child: SelfStopChild,
        minBackoff: 30,
        maxBackoff: 200,
        randomFactor: 0,
        // triggerOn omitted — default 'any'.
      }),
      'sup-any',
    );
    try {
      supervisor.tell({ kind: 'crash' });
      await awaitCondition(() => lifecycleSpawns >= 2, {
        timeoutMs: 4_000,
        label: 'the crashed child was respawned',
      });
      const afterCrash = lifecycleSpawns;
      supervisor.tell({ kind: 'stop' });
      await awaitCondition(() => lifecycleSpawns > afterCrash, {
        timeoutMs: 4_000,
        label: 'the cleanly-stopped child was respawned too',
      });
      // Both terminations triggered respawns: spawn count grew twice.
      expect(afterCrash).toBeGreaterThanOrEqual(2);
      expect(lifecycleSpawns).toBeGreaterThan(afterCrash);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);
});

/**
 * #769 — the supervisor must not retire a live child on the word of a
 * `Terminated`.  Two layers, and one test each, because they fail
 * independently: `ActorCell` refuses a signal the runtime did not emit, and
 * `handleTerminated` refuses one whose subject is demonstrably still running.
 */
describe('BackoffSupervisor — Terminated provenance', () => {
  /** The supervisor's children, by name, straight off its cell. */
  const childNames = (supervisor: ActorRef<unknown>): string[] =>
    (supervisor as unknown as LocalActorRef).getCell().children.map((c) => c.path.name);

  const currentChild = (supervisor: ActorRef<unknown>): ActorRef =>
    (supervisor as unknown as LocalActorRef).getCell().children[0] as ActorRef;

  test('a fabricated Terminated neither orphans the live child nor drives a respawn', async () => {
    crashesObserved = 0; flakyStarts = 0;
    const sys = newSystem('backoff-forged-terminated');
    const policy = new RecordingPolicy([10]);
    const supervisor = sys.spawn(
      BackoffSupervisor.factory(withDefaults({ child: Flaky, policy, resetCounter: 'never' })),
      'sup-forged',
    );
    try {
      await awaitCondition(() => flakyStarts === 1, {
        timeoutMs: 4_000,
        label: 'the first child started',
      });
      const child = currentChild(supervisor as ActorRef<unknown>);
      expect(child.path.name).toBe('child-1');

      // The exploit, in one line: anything holding the supervisor's ref can
      // build this, and before #769 it retired the watch, bumped the backoff
      // counter and spawned `child-2` alongside a `child-1` nobody stopped.
      supervisor.tell(new Terminated(child) as never);

      // Round-trip a real message so the assertions follow the forgery
      // through the supervisor's mailbox rather than racing it.
      const echoed = await supervisor.ask<number>({ kind: 'echo', value: 7 }, 1_000);
      expect(echoed).toBe(7);

      expect(flakyStarts).toBe(1);
      expect(policy.calls).toEqual([]);
      expect(childNames(supervisor as ActorRef<unknown>)).toEqual(['child-1']);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);

  test('a runtime-emitted Terminated naming a child that is still running is refused', async () => {
    crashesObserved = 0; flakyStarts = 0;
    const sys = newSystem('backoff-live-terminated');
    const policy = new RecordingPolicy([10]);
    const supervisor = sys.spawn(
      BackoffSupervisor.factory(withDefaults({ child: Flaky, policy, resetCounter: 'never' })),
      'sup-live',
    );
    try {
      await awaitCondition(() => flakyStarts === 1, {
        timeoutMs: 4_000,
        label: 'the first child started',
      });
      const cell = (supervisor as unknown as LocalActorRef).getCell();
      const child = cell.children[0] as ActorRef;

      // `watchNotify` is the one door that builds a *branded* `Terminated` for
      // an arbitrary target, so it is the only way to hand the supervisor a
      // signal whose provenance is genuine and whose claim is false.  That is
      // exactly what the supervisor's own liveness check is for: the cell's
      // brand says who sent it, not whether the subject died.
      cell.enqueueSystem({ kind: 'watchNotify', target: child });

      // Two round-trips, not one.  `enqueueSystem` only queues the command,
      // and the notification it produces is appended to the *user* queue when
      // the command runs — so a single echo sent now sits in front of the
      // signal and would resolve before the supervisor had seen it, which is
      // a test that passes for no reason.  The first ask flushes the command;
      // the second is behind the notification the command produced.
      expect(await supervisor.ask<number>({ kind: 'echo', value: 11 }, 1_000)).toBe(11);
      expect(await supervisor.ask<number>({ kind: 'echo', value: 12 }, 1_000)).toBe(12);

      expect(flakyStarts).toBe(1);
      expect(policy.calls).toEqual([]);
      expect(childNames(supervisor as ActorRef<unknown>)).toEqual(['child-1']);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);

  test('a genuine respawn leaves exactly one child and dead-letters nothing', async () => {
    // The backstop added for #769 stops the child it is replacing if that
    // child is somehow still alive — and `context.stop` is a `PoisonPill`,
    // which a terminated cell turns into a dead letter.  So the liveness
    // check inside that backstop is the whole reason an ordinary respawn
    // stays silent, and this is what says so.
    crashesObserved = 0; flakyStarts = 0;
    const letters: unknown[] = [];
    const subscribed = { value: false };
    class Listener extends Actor<DeadLetter> {
      override preStart(): void {
        this.system.eventStream.subscribe(this.self, DeadLetter);
        subscribed.value = true;
      }
      override onReceive(letter: DeadLetter): void { letters.push(letter.message); }
    }

    const sys = newSystem('backoff-respawn-silent');
    const policy = new RecordingPolicy([10]);
    const supervisor = sys.spawn(
      BackoffSupervisor.factory(withDefaults({ child: Flaky, policy, resetCounter: 'never' })),
      'sup-silent',
    );
    try {
      sys.spawn(Listener, 'listener');
      await awaitCondition(() => subscribed.value && flakyStarts === 1, {
        timeoutMs: 4_000,
        label: 'the listener subscribed and the first child started',
      });

      supervisor.tell({ kind: 'crash' });
      await awaitCondition(() => flakyStarts === 2, {
        timeoutMs: 4_000,
        label: 'the crashed child was respawned',
      });
      expect(await supervisor.ask<number>({ kind: 'echo', value: 3 }, 1_000)).toBe(3);

      expect(childNames(supervisor as ActorRef<unknown>)).toEqual(['child-2']);
      expect(letters).toEqual([]);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 5_000);
});

/* ============================================================== */
/* Stash overflow (#773)                                          */
/* ============================================================== */

/**
 * Collects `warn` calls with their structured fields.
 *
 * `withSource` / `withFields` return `this` the way `NoopLogger` does, so a
 * line the supervisor emits through its own actor-scoped logger still lands
 * in the same list.
 */
class WarnCollector implements Logger {
  readonly level = LogLevel.Warn;
  readonly warnings: Array<{ readonly message: string; readonly args: unknown[] }> = [];

  debug(): void { /* discarded */ }
  info(): void { /* discarded */ }
  error(): void { /* discarded */ }
  warn(message: string, ...args: unknown[]): void { this.warnings.push({ message, args }); }
  withSource(_source: string): Logger { return this; }
  withFields(_fields: LogContextData): Logger { return this; }

  /** The warnings whose message mentions `fragment`. */
  about(fragment: string): Array<{ readonly message: string; readonly args: unknown[] }> {
    return this.warnings.filter((w) => w.message.includes(fragment));
  }
}

describe('BackoffSupervisor — stash overflow (#773)', () => {
  test('an evicted stash entry dead-letters, and the warning aggregates', async () => {
    // Before #773 this path was the framework's other silent loss: `shift()`
    // threw the entry away and emitted one `log.warn` per message, so a flood
    // against a supervisor in a backoff window destroyed the payload and
    // amplified into the log at the same rate.
    crashesObserved = 0; flakyStarts = 0;
    const log = new WarnCollector();
    const letters: unknown[] = [];
    const subscribed = { value: false };
    class Listener extends Actor<DeadLetter> {
      override preStart(): void {
        this.system.eventStream.subscribe(this.self, DeadLetter);
        subscribed.value = true;
      }
      override onReceive(letter: DeadLetter): void { letters.push(letter.message); }
    }

    const sysOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withLogLevel(LogLevel.Warn);
    const sys = ActorSystem.create('backoff-stash-overflow', sysOptions);
    // Long enough that the respawn timer never fires inside this test: the
    // stash has to still be the only place those messages live when the
    // assertions run.
    const policy = new RecordingPolicy([30_000]);
    const supervisor = sys.spawn(
      BackoffSupervisor.factory(withDefaults({
        child: Flaky,
        policy,
        forward: 'stash',
        maxStashSize: 2,
        resetCounter: 'never',
      })),
      'sup-stash-overflow',
    );
    try {
      sys.spawn(Listener, 'listener');
      await awaitCondition(() => subscribed.value && flakyStarts === 1, {
        timeoutMs: 4_000,
        label: 'the listener subscribed and the first child started',
      });

      supervisor.tell({ kind: 'crash' });
      await awaitCondition(() => policy.calls.length === 1, {
        timeoutMs: 4_000,
        label: 'the supervisor entered its backoff window',
      });

      // Five messages into a stash of two: 1 and 2 fill it, then 3, 4 and 5
      // each evict the oldest — so 1, 2 and 3 are the ones lost.
      for (const value of [1, 2, 3, 4, 5]) supervisor.tell({ kind: 'echo', value });
      await awaitCondition(() => letters.length >= 3, {
        timeoutMs: 4_000,
        label: 'the three evicted messages were dead-lettered',
      });

      expect(letters).toEqual([
        { kind: 'echo', value: 1 },
        { kind: 'echo', value: 2 },
        { kind: 'echo', value: 3 },
      ]);
      // Doubling, not one line per message: evictions 1 and 2 warn, eviction
      // 3 does not.  The count is the assertion — three warnings would mean
      // the flood is back.
      const overflowWarnings = log.about('stash full');
      expect(overflowWarnings).toHaveLength(2);
      expect(overflowWarnings[1]!.args[0]).toEqual({ stashLimit: 2, droppedTotal: 2 });
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 8_000);

  test('the letter carries the MDC the evicted message arrived with', async () => {
    // The half of #773 the dead letter alone does not close.  `StashedMessage`
    // held a message and a sender, so the letter named *what* was lost and
    // nothing about which request it belonged to — the same gap the mailbox
    // path had, one layer up.
    //
    // The capture has to happen at stash time, and this test is built to fail
    // if it does not: each message arrives under its own MDC, and the eviction
    // runs while the supervisor is handling a *later* one.  A `LogContext.get()`
    // read inside `evictOldestStashed` would therefore stamp every letter with
    // the context of whichever message triggered the overflow.
    crashesObserved = 0; flakyStarts = 0;
    const letters: DeadLetter[] = [];
    const subscribed = { value: false };
    class Listener extends Actor<DeadLetter> {
      override preStart(): void {
        this.system.eventStream.subscribe(this.self, DeadLetter);
        subscribed.value = true;
      }
      override onReceive(letter: DeadLetter): void { letters.push(letter); }
    }

    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('backoff-stash-attribution', sysOptions);
    const policy = new RecordingPolicy([30_000]);
    const supervisor = sys.spawn(
      BackoffSupervisor.factory(withDefaults({
        child: Flaky,
        policy,
        forward: 'stash',
        maxStashSize: 2,
        resetCounter: 'never',
      })),
      'sup-stash-attribution',
    );
    try {
      sys.spawn(Listener, 'listener');
      await awaitCondition(() => subscribed.value && flakyStarts === 1, {
        timeoutMs: 4_000,
        label: 'the listener subscribed and the first child started',
      });

      supervisor.tell({ kind: 'crash' });
      await awaitCondition(() => policy.calls.length === 1, {
        timeoutMs: 4_000,
        label: 'the supervisor entered its backoff window',
      });

      // 1 and 2 fill the stash; 3 evicts 1 and 4 evicts 2.
      for (const value of [1, 2, 3, 4]) {
        LogContext.run(
          { requestId: `request-${value}` },
          () => supervisor.tell({ kind: 'echo', value }),
        );
      }
      await awaitCondition(() => letters.length >= 2, {
        timeoutMs: 4_000,
        label: 'the two evicted messages were dead-lettered',
      });

      expect(letters.map((l) => l.message)).toEqual([
        { kind: 'echo', value: 1 },
        { kind: 'echo', value: 2 },
      ]);
      // Each letter names the request that sent the message it lost — not the
      // one whose arrival made room.
      expect(letters.map((l) => l.attribution.context)).toEqual([
        { requestId: 'request-1' },
        { requestId: 'request-2' },
      ]);
      // No span: nothing exposes the arriving envelope's `trace` to actor
      // code, so the supervisor has none to copy.  Asserting it keeps the
      // limitation visible rather than letting a later change fill the field
      // with a span belonging to a different operation.
      expect(letters.every((l) => l.attribution.trace === undefined)).toBe(true);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 8_000);
});

/* ============================================================== */
/* #770 — the control ticks are not reconstructible                */
/* ============================================================== */

/**
 * The sentinels were `Symbol.for(...)`, so anything holding the registry
 * string — a compile-time constant in the published package — got back the
 * identical symbol and could tell it on the supervisor's public channel.
 * They are `Symbol(...)` now, unnameable outside their own module.
 *
 * Both tests assert the same two things, one per sentinel: the timing
 * guarantee held, and the forged value was treated as *ordinary user
 * traffic* rather than being specially rejected.  The second half matters —
 * the fix is "this value is no longer special", not "this value is now
 * refused", and a test that only checked for a refusal would pass against a
 * blocklist on the registry symbol, which would be the wrong fix.
 *
 * The timing assertions use a wide band on purpose.  Under the old code a
 * forged tick acted within a millisecond or two; under the new one the full
 * configured delay is served.  The thresholds sit far below the configured
 * value so that neither Bun firing a timer a 15.6 ms quantum early (#477)
 * nor `awaitCondition`'s poll interval can move the verdict.
 */
const forgedInbox: unknown[] = [];
let forgedStarts = 0;

/** Records what reaches the child, and crashes on demand to open a window. */
class ForgeTarget extends Actor<unknown> {
  override preStart(): void { forgedStarts += 1; }
  override onReceive(message: unknown): void {
    if (message === 'crash') throw new Error('forge-target boom');
    forgedInbox.push(message);
  }
}

describe('BackoffSupervisor — forged control ticks (#770)', () => {
  test('a reconstructed global respawn sentinel cannot collapse the backoff window', async () => {
    forgedStarts = 0; forgedInbox.length = 0;
    const sys = newSystem('backoff-forged-respawn');
    // A long window, so "held" and "collapsed" are hundreds of milliseconds
    // apart rather than a judgement call about scheduler jitter.
    const policy = new RecordingPolicy([600]);
    const supervisor = sys.spawn(
      BackoffSupervisor.factory<unknown>({
        child: ForgeTarget,
        minBackoff: 600,
        maxBackoff: 5_000,
        randomFactor: 0,
        policy,
        forward: 'stash',
        resetCounter: 'never',
      }),
      'sup-forged-respawn',
    );
    try {
      await awaitCondition(() => forgedStarts === 1, {
        timeoutMs: 4_000,
        label: 'the first incarnation started',
      });

      // Crash it, and wait for `delayFor` — the supervisor calls it as it
      // schedules the respawn, so it is a direct signal that the backoff
      // window is open rather than a sleep and a hope.
      supervisor.tell('crash');
      await awaitCondition(() => policy.calls.length === 1, {
        timeoutMs: 4_000,
        label: 'the supervisor entered its backoff window',
      });
      const windowOpenedAt = Date.now();
      expect(forgedStarts).toBe(1);

      // The exploit exactly as filed: rebuild the sentinel through the
      // cross-realm global registry and tell it on the public channel.
      const forgedRespawn = Symbol.for('actor-ts.pattern.BackoffSupervisor.respawn');
      supervisor.tell(forgedRespawn);

      await awaitCondition(() => forgedStarts === 2, {
        timeoutMs: 8_000,
        label: 'the legitimate timer respawned the child',
      });

      // The window was actually served.  A forged tick reaching `respawn()`
      // spawns on the spot, which lands this in single-digit milliseconds.
      expect(Date.now() - windowOpenedAt).toBeGreaterThan(300);
      // And exactly one respawn was scheduled — the forged tick did not
      // produce an extra incarnation for the real tick to then refuse.
      expect(policy.calls.length).toBe(1);

      // Ordinary user traffic: stashed during the window like anything else,
      // then forwarded to the new child when the stash drained.
      await awaitCondition(() => forgedInbox.includes(forgedRespawn), {
        timeoutMs: 4_000,
        label: 'the forged respawn symbol reached the child as a user message',
      });
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 20_000);

  test('a reconstructed global drain sentinel cannot cut the post-respawn grace short', async () => {
    forgedStarts = 0; forgedInbox.length = 0;
    const sys = newSystem('backoff-forged-drain');
    const supervisor = sys.spawn(
      BackoffSupervisor.factory<unknown>({
        child: ForgeTarget,
        minBackoff: 50,
        maxBackoff: 5_000,
        randomFactor: 0,
        drainGraceMs: 600,
        // Strict mode — the #67 gate, and the configuration in which a forged
        // drain has its full effect: new arrivals are stashed until the child
        // has proven it survives `preStart`.
        forwardDuringGrace: false,
        forward: 'stash',
      }),
      'sup-forged-drain',
    );
    try {
      // The supervisor spawns in `preStart`, so the grace window is already
      // open by the time the first incarnation reports in.
      await awaitCondition(() => forgedStarts === 1, {
        timeoutMs: 4_000,
        label: 'the first incarnation started',
      });
      const graceOpenedAt = Date.now();

      supervisor.tell('payload');
      const forgedDrain = Symbol.for('actor-ts.pattern.BackoffSupervisor.drain');
      supervisor.tell(forgedDrain);

      await awaitCondition(() => forgedInbox.includes('payload'), {
        timeoutMs: 8_000,
        label: 'the stashed payload reached the child',
      });
      // The grace was served: a forged drain flips `childConfirmedAlive` and
      // flushes the stash immediately, which lands this near zero.
      expect(Date.now() - graceOpenedAt).toBeGreaterThan(300);
      // The forged symbol went the same way as the payload — stashed, then
      // forwarded — rather than being consumed as a control message.
      expect(forgedInbox).toContain(forgedDrain);
      // And it did not restart anything on its way through.
      expect(forgedStarts).toBe(1);
    } finally {
      supervisor.stop();
      await sys.terminate();
    }
  }, 20_000);
});
