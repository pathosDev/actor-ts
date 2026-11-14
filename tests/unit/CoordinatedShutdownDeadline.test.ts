/**
 * #920 — the coordinated-shutdown pipeline gave its built-in terminator the
 * generic 5 s phase budget, had no bound on the run as a whole, and abandoned a
 * task that overran its phase with nothing more than a WARN — while the task
 * kept running, and `exit-process` could then exit out from under it.
 *
 * What is pinned here:
 *
 *   - `actor-system-terminate` is seeded with a budget of its own, which the
 *     generic `default-phase-timeout` does not shrink;
 *   - `overall-timeout` bounds the whole run: past it the run halts in the
 *     phase it is in, with an ERROR naming that phase and the tasks still
 *     pending, and `exit-process` exits there with a failure status;
 *   - a task its phase budget abandons is reported at ERROR, and `exit-process`
 *     waits for it — up to the overall deadline — rather than exiting under it.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { CoordinatedShutdownId, Phases } from '../../src/CoordinatedShutdown.js';
import type { ConfigObject } from '../../src/config/HoconParser.js';
import { DEFAULT_ACTOR_SYSTEM_TERMINATE_TIMEOUT_MS } from '../../src/Constants.js';
import { sleep } from '../util/AwaitCondition.js';
import { RecordingLogger } from '../util/RecordingLogger.js';

/** A system whose log a test can read, with `actor-ts.coordinated-shutdown` set to `settings`. */
function withRecordedLog(name: string, settings: ConfigObject = {}): { system: ActorSystem; log: RecordingLogger } {
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(log)
    .withConfig({ 'actor-ts': { 'coordinated-shutdown': settings } });
  return { system: ActorSystem.create(name, systemOptions), log };
}

const errorsOf = (log: RecordingLogger): string[] =>
  log.records.filter((record) => record.level === 'error').map((record) => record.message);

/** Replace `process.exit` until `body` is done; `onExit` sees each call as it happens. */
async function withExitStandIn(onExit: (status: number) => void, body: () => Promise<unknown>): Promise<void> {
  const realExit = process.exit;
  process.exit = ((code?: number): never => {
    onExit(code ?? Number.NaN);
    return undefined as never;
  }) as typeof process.exit;
  try {
    await body();
  } finally {
    process.exit = realExit;
  }
}

describe('the built-in terminator has a budget of its own (#920)', () => {
  test('actor-system-terminate is seeded with its own default, not the generic phase default', async () => {
    const { system } = withRecordedLog('terminate-own-budget', { 'default-phase-timeout': '20ms' });
    const shutdown = system.extension(CoordinatedShutdownId);

    expect(shutdown.phaseDefinition(Phases.ServiceUnbind)?.timeoutMs).toBe(20);
    expect(shutdown.phaseDefinition(Phases.ActorSystemTerminate)?.timeoutMs)
      .toBe(DEFAULT_ACTOR_SYSTEM_TERMINATE_TIMEOUT_MS);
    await system.terminate();
  });

  test('a drain in the last phase that outlasts the generic phase default completes', async () => {
    const { system, log } = withRecordedLog('terminate-drain-completes', { 'default-phase-timeout': '20ms' });
    const shutdown = system.extension(CoordinatedShutdownId);
    const seen: string[] = [];
    // 80 ms of work in the terminator's phase against a 20 ms generic budget:
    // under the old seeding the phase abandoned it at 20 ms.
    shutdown.addTask(Phases.ActorSystemTerminate, 'slow-flush', async () => {
      await sleep(80);   // the task's own duration IS the assertion: it outlasts the 20 ms generic budget
      seen.push('flushed');
    });

    await shutdown.run();

    expect(seen).toEqual(['flushed']);
    expect(log.records.some((record) => record.message.includes('timed out'))).toBe(false);
    expect(system.isTerminated).toBe(true);
  });

  test('a phases.actor-system-terminate.timeout still overrides it', async () => {
    const { system } = withRecordedLog('terminate-budget-override', {
      phases: { 'actor-system-terminate': { timeout: '45s' } },
    });
    const shutdown = system.extension(CoordinatedShutdownId);

    expect(shutdown.phaseDefinition(Phases.ActorSystemTerminate)?.timeoutMs).toBe(45_000);
    await system.terminate();
  });
});

describe('overall-timeout bounds the whole run (#920)', () => {
  test('past the deadline the run halts in its phase, with an ERROR naming the phase and what is pending', async () => {
    const { system, log } = withRecordedLog('overall-deadline-halts', {
      'overall-timeout': '60ms',
      phases: { 'service-unbind': { timeout: '30s' } },
    });
    const shutdown = system.extension(CoordinatedShutdownId);
    const later: string[] = [];
    shutdown.addTask(Phases.ServiceUnbind, 'never-settles', () => new Promise<void>(() => {}));
    shutdown.addTask(Phases.ServiceStop, 'later', () => { later.push('ran'); });

    const startedAt = Date.now();
    let outcome = 'resolved';
    try { await shutdown.run(); } catch (e) { outcome = `rejected: ${(e as Error).message}`; }

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(outcome).toContain('overall-timeout');
    expect(later).toEqual([]);
    const deadline = errorsOf(log).filter((m) => m.includes('overall deadline'));
    expect(deadline).toHaveLength(1);
    expect(deadline[0]).toContain('"service-unbind"');
    expect(deadline[0]).toContain('never-settles');
    await system.terminate();
  });

  test('with exit-process on, the deadline is what the exit honours, with a failure status', async () => {
    const { system } = withRecordedLog('overall-deadline-exits', {
      'overall-timeout': '60ms',
      'exit-process': true,
      phases: { 'service-unbind': { timeout: '30s' } },
    });
    const shutdown = system.extension(CoordinatedShutdownId);
    shutdown.addTask(Phases.ServiceUnbind, 'never-settles', () => new Promise<void>(() => {}));
    const statuses: number[] = [];

    await withExitStandIn((status) => { statuses.push(status); }, async () => {
      await shutdown.run().catch(() => {});
    });

    expect(statuses).toEqual([1]);
    await system.terminate();
  });

  test('overall-timeout = 0 sets no deadline', async () => {
    const { system, log } = withRecordedLog('overall-deadline-off', {
      'overall-timeout': '0s',
      'default-phase-timeout': '20ms',
    });
    const shutdown = system.extension(CoordinatedShutdownId);
    shutdown.addTask(Phases.ServiceUnbind, 'quick', () => {});

    await shutdown.run();

    expect(errorsOf(log).filter((m) => m.includes('overall deadline'))).toEqual([]);
    expect(system.isTerminated).toBe(true);
  });
});

describe('an abandoned task is reported, and exit-process does not exit under it (#920)', () => {
  test('a task its phase budget abandons is logged at ERROR, naming its phase and that it still runs', async () => {
    const { system, log } = withRecordedLog('abandoned-task-error', {
      phases: { 'service-unbind': { timeout: '10ms' } },
    });
    const shutdown = system.extension(CoordinatedShutdownId);
    shutdown.addTask(Phases.ServiceUnbind, 'overruns', () => sleep(60));   // overrunning the 10 ms budget is the point

    await shutdown.run();

    const timedOut = log.records.filter((record) => record.message.includes('timed out'));
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]!.level).toBe('error');
    expect(timedOut[0]!.message).toContain('"service-unbind"');
    expect(timedOut[0]!.message).toContain('overruns');
    expect(timedOut[0]!.message).toContain('still running');
    // Let the overrunning task settle before the next test reuses the runner.
    await sleep(80);
  });

  test('exit-process waits for an abandoned task to settle before exiting', async () => {
    const { system } = withRecordedLog('abandoned-task-exit-waits', {
      'exit-process': true,
      phases: { 'service-unbind': { timeout: '10ms' } },
    });
    const shutdown = system.extension(CoordinatedShutdownId);
    const state = { settled: false };
    shutdown.addTask(Phases.ServiceUnbind, 'overruns', async () => {
      await sleep(80);   // the overrun the exit has to wait out IS the assertion
      state.settled = true;
    });
    const seenAtExit: boolean[] = [];

    await withExitStandIn(() => { seenAtExit.push(state.settled); }, () => shutdown.run());

    expect(seenAtExit).toEqual([true]);
  });

  test('…but no longer than the overall deadline, and it says which task it gave up on', async () => {
    const { system, log } = withRecordedLog('abandoned-task-exit-bounded', {
      'exit-process': true,
      'overall-timeout': '120ms',
      phases: { 'service-unbind': { timeout: '10ms' } },
    });
    const shutdown = system.extension(CoordinatedShutdownId);
    shutdown.addTask(Phases.ServiceUnbind, 'never-settles', () => new Promise<void>(() => {}));
    const statuses: number[] = [];
    const startedAt = Date.now();

    await withExitStandIn((status) => { statuses.push(status); }, () => shutdown.run());

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(statuses).toHaveLength(1);
    const gaveUp = errorsOf(log).filter((m) => m.includes('overall deadline'));
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]).toContain('never-settles');
  });
});
