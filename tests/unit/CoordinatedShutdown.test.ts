import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import {
  ActorSystemTerminateReason,
  CoordinatedShutdown,
  CoordinatedShutdownId,
  Phases,
  ProcessTerminateReason,
  UnknownReason,
  type Reason,
} from '../../src/CoordinatedShutdown.js';
import type { ConfigObject } from '../../src/config/HoconParser.js';
import { EVENT_LOOP_KEEPALIVE_INTERVAL_MS } from '../../src/Constants.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { awaitCondition, sleep } from '../util/AwaitCondition.js';
import { RecordingLogger } from '../util/RecordingLogger.js';

const newSystem = (name = 'cs-unit'): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

describe('CoordinatedShutdown basics', () => {
  test('is an Extension with a dedicated id', async () => {
    const sys = newSystem();
    const cs = sys.extension(CoordinatedShutdownId);
    expect(cs).toBeInstanceOf(CoordinatedShutdown);
    // Same id returns the same instance.
    expect(sys.extension(CoordinatedShutdownId)).toBe(cs);
    await sys.terminate();
  });

  test('run() eventually terminates the ActorSystem', async () => {
    const sys = newSystem();
    const cs = sys.extension(CoordinatedShutdownId);
    expect(sys.isTerminated).toBe(false);
    await cs.run(ActorSystemTerminateReason.instance);
    expect(sys.isTerminated).toBe(true);
    expect(cs.isComplete).toBe(true);
  });

  test('phases run in declared order with reason passed through', async () => {
    const sys = newSystem();
    const cs = sys.extension(CoordinatedShutdownId);
    const order: string[] = [];

    cs.addTask(Phases.BeforeServiceUnbind, 't-a', r => { order.push(`a:${r.name}`); });
    cs.addTask(Phases.ServiceUnbind,       't-b', r => { order.push(`b:${r.name}`); });
    cs.addTask(Phases.ClusterLeave,        't-c', r => { order.push(`c:${r.name}`); });
    cs.addTask(Phases.BeforeActorSystemTerminate, 't-d', r => { order.push(`d:${r.name}`); });

    await cs.run(new ProcessTerminateReason('SIGTERM'));

    expect(order).toEqual([
      'a:ProcessTerminateReason',
      'b:ProcessTerminateReason',
      'c:ProcessTerminateReason',
      'd:ProcessTerminateReason',
    ]);
  });

  test('tasks within a phase run in parallel', async () => {
    const sys = newSystem();
    const cs = sys.extension(CoordinatedShutdownId);
    // **One** trace, not a starts array and an ends array.  Two arrays cannot
    // tell the two schedules apart: run sequentially they read `['1', '2']` and
    // `['1', '2']`, exactly as they do run in parallel, because each records
    // only its own events in its own order.  Interleaving them is the whole
    // observation.
    const trace: string[] = [];

    // Equal delays are the fixture: both tasks have to be in flight at the same
    // time, or "within a phase run in parallel" has nothing to observe.
    cs.addTask(Phases.BeforeServiceUnbind, 'slow-1', async () => {
      trace.push('start-1');
      await sleep(30); // the overlap, not a wait — see above
      trace.push('end-1');
    });
    cs.addTask(Phases.BeforeServiceUnbind, 'slow-2', async () => {
      trace.push('start-2');
      await sleep(30); // the overlap, not a wait — see above
      trace.push('end-2');
    });

    await cs.run();

    // Parallelism as an ordering fact rather than a duration.  Sequential
    // execution produces `start-1, end-1, start-2, end-2`; parallel puts both
    // starts before either end.  The `elapsed < 500` this replaces established
    // the same thing by asserting the machine's speed against two 30 ms tasks,
    // and could only ever be the weaker version of it (#1338).
    expect(trace).toEqual(['start-1', 'start-2', 'end-1', 'end-2']);
  });

  test('the built-in terminate task stops the system even if user code is empty', async () => {
    const sys = newSystem();
    const cs = sys.extension(CoordinatedShutdownId);
    await cs.run();
    expect(sys.isTerminated).toBe(true);
  });
});

describe('CoordinatedShutdown task registration', () => {
  test('duplicate task name in a phase is rejected', async () => {
    const sys = newSystem();
    const cs = sys.extension(CoordinatedShutdownId);
    cs.addTask(Phases.ServiceUnbind, 'x', () => {});
    expect(() => cs.addTask(Phases.ServiceUnbind, 'x', () => {})).toThrow(/already registered/);
    await sys.terminate();
  });

  test('unknown phase is rejected', async () => {
    const sys = newSystem();
    const cs = sys.extension(CoordinatedShutdownId);
    expect(() => cs.addTask('imaginary-phase', 't', () => {})).toThrow(/unknown phase/i);
    await sys.terminate();
  });
});

describe('CoordinatedShutdown error handling', () => {
  test('a failing task does not stop the pipeline (default recover=true)', async () => {
    const sys = newSystem();
    const cs = sys.extension(CoordinatedShutdownId);
    const events: string[] = [];
    cs.addTask(Phases.ServiceUnbind, 'boom', () => { throw new Error('bad'); });
    cs.addTask(Phases.ServiceRequestsDone, 'ok', () => { events.push('after-boom'); });
    await cs.run();
    expect(events).toEqual(['after-boom']);
    expect(sys.isTerminated).toBe(true);
  });

  test('task timeout is enforced; remaining phases still run', async () => {
    const sys = newSystem();
    const cs = sys.extension(CoordinatedShutdownId);
    // Phase budget (5 ms) is shorter than the task's wall time (50 ms) —
    // the race must reject via timeout and the pipeline must continue.
    cs.setPhaseTimeout(Phases.ServiceUnbind, 5);
    const seen: string[] = [];
    // The 50 ms IS the assertion: it has to outrun the 5 ms phase budget set
    // above, which is what makes the timeout fire.
    cs.addTask(Phases.ServiceUnbind, 'slow', () => Bun.sleep(50));
    cs.addTask(Phases.ServiceRequestsDone, 'next', () => { seen.push('next'); });
    await cs.run();
    expect(seen).toEqual(['next']);
    // Give the slow task a chance to settle naturally before the process exits.
    await Bun.sleep(80);
  });
});

describe('CoordinatedShutdown.run idempotency', () => {
  test('calling run twice returns the same promise', async () => {
    const sys = newSystem();
    const cs = sys.extension(CoordinatedShutdownId);
    const p1 = cs.run();
    const p2 = cs.run(new ActorSystemTerminateReason());
    expect(p1).toBe(p2);
    await p1;
  });

  test('isRunning / isComplete reflect state', async () => {
    const sys = newSystem();
    const cs = sys.extension(CoordinatedShutdownId);
    expect(cs.isRunning).toBe(false);
    expect(cs.isComplete).toBe(false);
    const shutdownPromise = cs.run();
    expect(cs.isRunning).toBe(true);
    await shutdownPromise;
    expect(cs.isComplete).toBe(true);
  });
});

describe('CoordinatedShutdown custom phases', () => {
  test('addPhase rejects duplicate and unknown dependencies', async () => {
    const sys = newSystem();
    const cs = sys.extension(CoordinatedShutdownId);
    expect(() => cs.addPhase({
      name: Phases.ServiceUnbind, // already exists
      timeoutMs: 1_000, dependsOn: [], recover: true,
    })).toThrow(/already exists/);
    expect(() => cs.addPhase({
      name: 'custom', timeoutMs: 1_000, dependsOn: ['unknown'], recover: true,
    })).toThrow(/unknown/);
    await sys.terminate();
  });

  test('a custom phase runs after its dependencies', async () => {
    const sys = newSystem();
    const cs = sys.extension(CoordinatedShutdownId);
    const order: string[] = [];
    cs.addPhase({
      name: 'custom-late',
      timeoutMs: 1_000,
      dependsOn: [Phases.ActorSystemTerminate],
      recover: true,
    });
    cs.addTask(Phases.ActorSystemTerminate, 'core', () => { order.push('core'); });
    cs.addTask('custom-late', 'tail', () => { order.push('tail'); });
    await cs.run();
    expect(order).toEqual(['core', 'tail']);
  });
});

describe('CoordinatedShutdown Reasons', () => {
  test('built-in reasons carry stable names', () => {
    expect(UnknownReason.instance.name).toBe('UnknownReason');
    expect(new ActorSystemTerminateReason().name).toBe('ActorSystemTerminateReason');
    const sig = new ProcessTerminateReason('SIGTERM');
    expect(sig.name).toBe('ProcessTerminateReason');
    expect(sig.toString()).toContain('SIGTERM');
  });
});

describe('CoordinatedShutdown — removing tasks', () => {
  test('a removed task does not run, and its name is free again', async () => {
    const system = newSystem('cs-remove');
    const shutdown = system.extension(CoordinatedShutdownId);
    const ran: string[] = [];

    shutdown.addTask(Phases.ServiceUnbind, 'release', async () => { ran.push('first'); });
    expect(shutdown.removeTask(Phases.ServiceUnbind, 'release')).toBe(true);

    // The point of removal: the same name can be registered again, which
    // is what lets a component re-acquire a resource it gave back.
    shutdown.addTask(Phases.ServiceUnbind, 'release', async () => { ran.push('second'); });

    await shutdown.run();
    expect(ran).toEqual(['second']);
  });

  test('removing something that is not there is not an error', () => {
    const system = newSystem('cs-remove-missing');
    const shutdown = system.extension(CoordinatedShutdownId);
    expect(shutdown.removeTask(Phases.ServiceUnbind, 'never-added')).toBe(false);
    expect(shutdown.removeTask('no-such-phase', 'never-added')).toBe(false);
    void system.terminate();
  });
});

// #644 / #764 — `removeProcessHooks()` called `process.removeAllListeners(sig)`,
// so detaching one ActorSystem's shutdown hooks tore out the application's
// own SIGTERM handling, every other library's, and any second system's.
describe('CoordinatedShutdown process hooks', () => {
  test('removing hooks leaves other listeners alone', () => {
    const applicationHandler = (): void => {};
    const before = process.listenerCount('SIGTERM');
    process.on('SIGTERM', applicationHandler);

    const system = newSystem('hooks-isolation');
    const shutdown = system.extension(CoordinatedShutdownId);
    shutdown.installProcessHooks(['SIGTERM']);
    expect(process.listenerCount('SIGTERM')).toBe(before + 2);

    shutdown.removeProcessHooks();

    // The application's handler survives; only ours went.
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    expect(process.listeners('SIGTERM')).toContain(applicationHandler);

    process.off('SIGTERM', applicationHandler);
    void system.terminate();
  });

  test('two systems detach independently', () => {
    // The second ActorSystem in a process used to be collateral damage.
    const before = process.listenerCount('SIGINT');
    const first = newSystem('hooks-first');
    const second = newSystem('hooks-second');
    first.extension(CoordinatedShutdownId).installProcessHooks(['SIGINT']);
    second.extension(CoordinatedShutdownId).installProcessHooks(['SIGINT']);
    expect(process.listenerCount('SIGINT')).toBe(before + 2);

    first.extension(CoordinatedShutdownId).removeProcessHooks();

    expect(process.listenerCount('SIGINT')).toBe(before + 1);

    second.extension(CoordinatedShutdownId).removeProcessHooks();
    expect(process.listenerCount('SIGINT')).toBe(before);

    void first.terminate();
    void second.terminate();
  });

  test('removing twice is harmless', () => {
    const before = process.listenerCount('SIGTERM');
    const system = newSystem('hooks-idempotent');
    system.extension(CoordinatedShutdownId).installProcessHooks(['SIGTERM']);
    system.extension(CoordinatedShutdownId).removeProcessHooks();
    system.extension(CoordinatedShutdownId).removeProcessHooks();
    expect(process.listenerCount('SIGTERM')).toBe(before);
    void system.terminate();
  });

  // The hooks now go through `src/runtime/signals/`, which skips a signal
  // the platform cannot deliver instead of registering it.  Nothing on Bun
  // or Node is skipped; the assertion is that the filter did not start
  // silently dropping ordinary ones.
  test('a signal no process can catch is skipped, not registered', () => {
    const system = newSystem('hooks-uncatchable');
    system.extension(CoordinatedShutdownId).installProcessHooks(['SIGKILL', 'SIGTERM']);
    expect(process.listenerCount('SIGKILL')).toBe(0);
    system.extension(CoordinatedShutdownId).removeProcessHooks();
    void system.terminate();
  });
});

// #549 — the one-liner that replaces a hand-rolled `process.on('SIGTERM', …)`
// in every service's `main`.
describe('ActorSystem.runUntilTerminated', () => {
  test('resolves once the system is down and detaches its handlers', async () => {
    const before = process.listenerCount('SIGTERM');
    const system = newSystem('run-until-terminated');

    const running = system.runUntilTerminated(['SIGTERM']);
    // Installed while it is waiting…
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);

    await system.extension(CoordinatedShutdownId).run(ActorSystemTerminateReason.instance);
    await running;

    expect(system.isTerminated).toBe(true);
    // …and gone once it returns.  Not housekeeping: on Deno a signal
    // listener holds the event loop open with no `unref`, so leaving one
    // behind means the process never exits.
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  test('holds the event loop open while it waits, and lets go on the way out', async () => {
    // The failure this pins cannot be observed from inside a process: Node
    // unrefs its signal handles, so an idle service that had installed
    // SIGTERM and nothing else drained its event loop and exited *instead of*
    // waiting for the signal it had just armed itself for.  Bun — which runs
    // this suite — refs its handles, so the suite could never have shown it;
    // only Node's smoke arm did, with `code=13`, an unsettled top-level await
    // and no shutdown at all.
    //
    // What is assertable here is the wiring, and it is the half that can
    // regress silently: a hold is taken for exactly as long as the promise is
    // pending.  That a *referenced timer* is what keeps all three runtimes
    // alive is the claim `tests/smoke/cases/28-graceful-shutdown-signals.mjs`
    // exists to prove, in a real process, per runtime.
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const held = new Set<unknown>();
    globalThis.setInterval = ((handler: () => void, delayMs?: number): unknown => {
      const timer = realSetInterval(handler, delayMs);
      // Only the keep-alive, identified by its interval: the system under
      // test is free to run timers of its own while this is patched.
      if (delayMs === EVENT_LOOP_KEEPALIVE_INTERVAL_MS) held.add(timer);
      return timer;
    }) as unknown as typeof globalThis.setInterval;
    globalThis.clearInterval = ((timer?: unknown): void => {
      held.delete(timer);
      realClearInterval(timer as Parameters<typeof globalThis.clearInterval>[0]);
    }) as unknown as typeof globalThis.clearInterval;

    try {
      const system = newSystem('run-until-terminated-keepalive');
      const running = system.runUntilTerminated(['SIGTERM']);
      expect(held.size).toBe(1);

      await system.terminate();
      await running;

      // Released in the same `finally` as the handlers.  A keep-alive that
      // outlived the wait would be the mirror image of the bug it fixes: a
      // process that can no longer exit.
      expect(held.size).toBe(0);
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });

  test('a plain terminate() also releases it', async () => {
    const before = process.listenerCount('SIGINT');
    const system = newSystem('run-until-terminated-direct');

    const running = system.runUntilTerminated(['SIGINT']);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);

    await system.terminate();
    await running;

    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  test('waits for tasks that share the final phase with the terminator', async () => {
    const system = newSystem('run-until-terminated-final-phase');
    let sibling = false;
    system.extension(CoordinatedShutdownId).addTask(
      Phases.ActorSystemTerminate,
      'slow-sibling',
      // The delay is the fixture: it is what keeps the sibling in flight past
      // the point `whenTerminated()` alone would have resolved.
      async () => { await sleep(30); sibling = true; },
    );

    const running = system.runUntilTerminated(['SIGTERM']);
    void system.extension(CoordinatedShutdownId).run(ActorSystemTerminateReason.instance);
    await running;

    // `whenTerminated()` alone would have resolved while this was still in
    // flight — the phase runs its tasks in parallel.
    expect(sibling).toBe(true);
  });

  test('returns immediately for a system that is already down', async () => {
    const before = process.listenerCount('SIGTERM');
    const system = newSystem('run-until-terminated-late');
    await system.terminate();

    await system.runUntilTerminated(['SIGTERM']);

    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});

describe('framework task auto-registration', () => {
  const withAutoRegister = (value: boolean): ActorSystem => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { 'coordinated-shutdown': { 'auto-register-tasks': value } } });
    return ActorSystem.create('auto-register', sysOptions);
  };

  test('defaults to on', async () => {
    const system = newSystem('auto-register-default');
    const shutdown = system.extension(CoordinatedShutdownId);
    expect(shutdown.autoRegisterTasks).toBe(true);
    expect(shutdown.addFrameworkTask(Phases.ServiceStop, 'framework', () => {})).toBe(true);
    await system.terminate();
  });

  test('off drops the framework task and keeps the explicit one', async () => {
    const system = withAutoRegister(false);
    const shutdown = system.extension(CoordinatedShutdownId);
    const ran: string[] = [];

    expect(shutdown.addFrameworkTask(Phases.ServiceStop, 'framework', () => {
      ran.push('framework');
    })).toBe(false);
    shutdown.addTask(Phases.ServiceStop, 'mine', () => { ran.push('mine'); });

    await shutdown.run(UnknownReason.instance);
    expect(ran).toEqual(['mine']);
  });

  test('off does not disable the phases themselves', async () => {
    const system = withAutoRegister(false);
    const shutdown = system.extension(CoordinatedShutdownId);
    await shutdown.run(UnknownReason.instance);
    // The built-in terminator is not a framework task — opting out of
    // auto-registration is not opting out of shutting down.
    expect(system.isTerminated).toBe(true);
  });
});

// #1455 — `terminate()` was only ever the bare teardown: a program that called
// it left its HTTP port bound and its cluster node up, because every framework
// task lives in a phase.  Asked to, it now runs the pipeline first.
//
// A phase budget above bun's 5 s per-test cap recurs below, and it is the
// point of those tests: a task that waits on the run it belongs to does not
// hang forever, it holds its phase until the budget abandons it with a WARN.
// "Does not hang" therefore passes against that defect at the default 5 s;
// a budget the runner gives up on first turns it into a red test.
const ABOVE_THE_TEST_TIMEOUT = '30s';

/** A system whose log a test can read, with `actor-ts.coordinated-shutdown` set to `settings`. */
const withRecordedLog = (
  name: string,
  settings: ConfigObject = {},
): { system: ActorSystem; log: RecordingLogger } => {
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(log)
    .withConfig({ 'actor-ts': { 'coordinated-shutdown': settings } });
  return { system: ActorSystem.create(name, systemOptions), log };
};

/** What `runOneTask` logs when a phase budget abandons a task — the trace a self-await leaves. */
const timeoutWarnings = (log: RecordingLogger): string[] => log.records
  .filter((record) => record.message.includes('timed out'))
  .map((record) => record.message);

describe('system.terminate() and the pipeline', () => {
  test('the timeout probe sees a real phase timeout, so its silence below means something', async () => {
    // Every "no timeout warning" assertion in this file is only as good as
    // this filter: were the WARN reworded, `timeoutWarnings` would return []
    // for a stalled run too, and those assertions would pass on nothing.
    const { system, log } = withRecordedLog('timeout-probe', {
      phases: { 'service-unbind': { timeout: '5ms' } },
    });
    const shutdown = system.extension(CoordinatedShutdownId);
    shutdown.addTask(Phases.ServiceUnbind, 'never-settles', () => new Promise<void>(() => {}));

    await shutdown.run(ActorSystemTerminateReason.instance);

    expect(timeoutWarnings(log)).toHaveLength(1);
    expect(timeoutWarnings(log)[0]).toContain('never-settles');
  });

  test('a plain terminate() is still the bare teardown — no phase runs', async () => {
    for (const options of [undefined, {}, { runCoordinatedShutdown: false }]) {
      const { system } = withRecordedLog('terminate-bare');
      const shutdown = system.extension(CoordinatedShutdownId);
      const ran: string[] = [];
      shutdown.addTask(Phases.ServiceUnbind, 'unbind', () => { ran.push('service-unbind'); });

      await system.terminate(options);

      expect(system.isTerminated).toBe(true);
      expect(ran).toEqual([]);
      expect(shutdown.isRunning).toBe(false);
    }
  });

  test('runCoordinatedShutdown runs the phases with ActorSystemTerminateReason, then the teardown', async () => {
    const { system } = withRecordedLog('terminate-runs-pipeline');
    const shutdown = system.extension(CoordinatedShutdownId);
    const seen: string[] = [];
    const record = (phase: string) => (reason: Reason): void => {
      seen.push(`${phase} ${reason.name} terminated=${system.isTerminated}`);
    };
    shutdown.addTask(Phases.ServiceUnbind, 'unbind', record(Phases.ServiceUnbind));
    shutdown.addTask(Phases.ClusterLeave, 'leave', record(Phases.ClusterLeave));
    shutdown.addTask(Phases.BeforeActorSystemTerminate, 'last-call', record(Phases.BeforeActorSystemTerminate));

    await system.terminate({ runCoordinatedShutdown: true });

    expect(seen).toEqual([
      'service-unbind ActorSystemTerminateReason terminated=false',
      'cluster-leave ActorSystemTerminateReason terminated=false',
      'before-actor-system-terminate ActorSystemTerminateReason terminated=false',
    ]);
    expect(shutdown.isComplete).toBe(true);
    expect(system.isTerminated).toBe(true);
  });

  test('it finishes inside the terminator\'s budget, with no timeout warning', async () => {
    const { system, log } = withRecordedLog('terminate-no-self-await', {
      phases: { 'actor-system-terminate': { timeout: ABOVE_THE_TEST_TIMEOUT } },
    });
    const startedAt = performance.now();

    await system.terminate({ runCoordinatedShutdown: true });

    expect(system.isTerminated).toBe(true);
    expect(system.extension(CoordinatedShutdownId).isComplete).toBe(true);
    expect(timeoutWarnings(log)).toEqual([]);
    // Orders of magnitude, not a stopwatch: what this rules out is the whole
    // 30 s budget, and bun's own cap has already ruled it out at 5 s.
    expect(performance.now() - startedAt).toBeLessThan(15_000);
  });

  test('it resolves once the pipeline has finished, not merely once the system is down', async () => {
    const { system } = withRecordedLog('terminate-awaits-final-phase');
    let sibling = 'pending';
    system.extension(CoordinatedShutdownId).addTask(
      Phases.ActorSystemTerminate,
      'outlives-the-teardown',
      async () => {
        await system.whenTerminated();
        // The delay is the fixture: it keeps this sibling of the terminator in
        // flight after the system is already down.
        await sleep(20);
        sibling = 'done';
      },
    );

    await system.terminate({ runCoordinatedShutdown: true });

    expect(sibling).toBe('done');
  });

  test('with terminate-actor-system = false the teardown still follows the run', async () => {
    const { system } = withRecordedLog('terminate-without-terminator', { 'terminate-actor-system': false });
    const shutdown = system.extension(CoordinatedShutdownId);
    const seen: boolean[] = [];
    shutdown.addTask(Phases.ActorSystemTerminate, 'last', () => { seen.push(system.isTerminated); });

    await system.terminate({ runCoordinatedShutdown: true });

    // The run ended with the system up — there is no terminator in it…
    expect(seen).toEqual([false]);
    expect(shutdown.isComplete).toBe(true);
    // …and `terminate()` was still asked to take the system down.
    expect(system.isTerminated).toBe(true);
  });

  test('a pipeline that halts still ends in the teardown, and says so', async () => {
    const { system, log } = withRecordedLog('terminate-halted', {
      phases: { 'service-stop': { recover: false } },
    });
    const shutdown = system.extension(CoordinatedShutdownId);
    const ran: string[] = [];
    shutdown.addTask(Phases.ServiceStop, 'throws', () => {
      ran.push('service-stop');
      throw new Error('boom');
    });
    shutdown.addTask(Phases.ClusterLeave, 'after-the-halt', () => { ran.push('cluster-leave'); });

    await system.terminate({ runCoordinatedShutdown: true });

    // The halt held — nothing after the failed phase ran…
    expect(ran).toEqual(['service-stop']);
    // …and the call still did what it is named for.
    expect(system.isTerminated).toBe(true);
    expect(log.records.some((record) => record.level === 'error' && record.message.includes('halted'))).toBe(true);
  });

  test('once a bare teardown has started, an opted-in terminate() joins it instead of starting the pipeline', async () => {
    const { system } = withRecordedLog('terminate-joins-teardown');
    const shutdown = system.extension(CoordinatedShutdownId);
    const ran: string[] = [];
    shutdown.addTask(Phases.ServiceUnbind, 'unbind', () => { ran.push('service-unbind'); });

    const bare = system.terminate();
    await system.terminate({ runCoordinatedShutdown: true });
    await bare;

    // A pipeline started over a half-stopped tree would unbind and leave
    // after the actors it exists to protect have already gone.
    expect(ran).toEqual([]);
    expect(shutdown.isRunning).toBe(false);
    expect(system.isTerminated).toBe(true);
  });

  test('a pipeline the extension refuses to build is reported, and the teardown runs without it', async () => {
    // Nothing built the extension before this call, so its config is read —
    // and refused — inside `terminate()`.  Throwing out of it would leave the
    // system running; tearing down without the pipeline is what was asked.
    const { system, log } = withRecordedLog('terminate-unbuildable', {
      phases: { 'flush-metrics': { timeout: '1s' } },
    });

    await system.terminate({ runCoordinatedShutdown: true });

    expect(system.isTerminated).toBe(true);
    expect(log.records.some((record) => record.level === 'error'
      && record.message.includes('could not be built'))).toBe(true);
  });
});

class Idle extends Actor<unknown> { override onReceive(): void {} }

/**
 * Whether the system still takes a spawn — refused from the moment a teardown
 * starts, so it answers "did anything start one?" deterministically, where
 * `isTerminated` would only say whether that teardown had finished yet.
 */
const acceptsSpawns = (system: ActorSystem): boolean => {
  try {
    system.spawnAnonymous(Idle);
    return true;
  } catch {
    return false;
  }
};

// The re-entrancy rule: while a run is in flight, `terminate()` starts nothing
// and resolves at once, in either form.  Joining the run instead would make a
// task that awaits `terminate()` wait on the run it belongs to; tearing down
// on the spot — what a plain `terminate()` used to do — stops the actors in
// the middle of the pipeline and runs every later phase on a dead system.
describe('terminate() while a run is in flight', () => {
  test('a plain terminate() does not build the pipeline to ask whether one is running', async () => {
    // A block the extension refuses — a new phase with no `depends-on`.
    // Looking the extension up to ask for its run would build it, throwing
    // that refusal out of a call that has nothing to do with the pipeline.
    const { system } = withRecordedLog('terminate-unbuilt', {
      phases: { 'flush-metrics': { timeout: '1s' } },
    });

    await system.terminate();

    expect(system.isTerminated).toBe(true);
    expect(system.extensions.has(CoordinatedShutdownId)).toBe(false);
    // The fixture really is one the extension refuses, or the test above
    // proves nothing.
    expect(() => system.extension(CoordinatedShutdownId)).toThrow(/depends-on/);
  });

  test('awaited from a task, it starts nothing and returns at once', async () => {
    const { system, log } = withRecordedLog('terminate-in-task-awaited', {
      phases: { 'service-unbind': { timeout: ABOVE_THE_TEST_TIMEOUT } },
    });
    const shutdown = system.extension(CoordinatedShutdownId);
    const seen: string[] = [];
    shutdown.addTask(Phases.ServiceUnbind, 'awaits-terminate', async () => {
      await system.terminate();
      seen.push(`returned terminated=${system.isTerminated}`);
    });
    shutdown.addTask(Phases.ClusterLeave, 'later', () => {
      seen.push(`later terminated=${system.isTerminated}`);
    });

    await shutdown.run(ActorSystemTerminateReason.instance);

    expect(seen).toEqual(['returned terminated=false', 'later terminated=false']);
    expect(system.isTerminated).toBe(true);
    expect(timeoutWarnings(log)).toEqual([]);
  });

  test('fired from a task, it starts nothing either', async () => {
    const { system } = withRecordedLog('terminate-in-task-fired');
    const shutdown = system.extension(CoordinatedShutdownId);
    const seen: string[] = [];
    shutdown.addTask(Phases.ServiceUnbind, 'fires-terminate', () => { void system.terminate(); });
    shutdown.addTask(Phases.ClusterLeave, 'later', () => {
      seen.push(`later accepts spawns=${acceptsSpawns(system)}`);
    });

    await shutdown.run(ActorSystemTerminateReason.instance);

    expect(seen).toEqual(['later accepts spawns=true']);
    expect(system.isTerminated).toBe(true);
  });

  test('an opted-in terminate() from a task neither starts a second run nor waits on this one', async () => {
    const { system, log } = withRecordedLog('terminate-in-task-opted-in', {
      phases: { 'service-unbind': { timeout: ABOVE_THE_TEST_TIMEOUT } },
    });
    const shutdown = system.extension(CoordinatedShutdownId);
    const seen: string[] = [];
    shutdown.addTask(Phases.ServiceUnbind, 'awaits-terminate', async () => {
      await system.terminate({ runCoordinatedShutdown: true });
      seen.push(`returned terminated=${system.isTerminated}`);
    });
    shutdown.addTask(Phases.ClusterLeave, 'later', () => {
      seen.push(`later terminated=${system.isTerminated}`);
    });

    await shutdown.run(ActorSystemTerminateReason.instance);

    expect(seen).toEqual(['returned terminated=false', 'later terminated=false']);
    expect(system.isTerminated).toBe(true);
    expect(timeoutWarnings(log)).toEqual([]);
  });

  test('from outside, it returns without joining the run — whenTerminated() is the wait', async () => {
    const { system } = withRecordedLog('terminate-beside-run', {
      phases: { 'service-unbind': { timeout: ABOVE_THE_TEST_TIMEOUT } },
    });
    const shutdown = system.extension(CoordinatedShutdownId);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    shutdown.addTask(Phases.ServiceUnbind, 'held-open', () => held);
    const run = shutdown.run(ActorSystemTerminateReason.instance);

    await system.terminate();
    expect(system.isTerminated).toBe(false);

    release();
    await system.whenTerminated();
    await run;
    expect(shutdown.isComplete).toBe(true);
  });

  test('beside the terminator it returns before the system is down — it joins the teardown no more than the run', async () => {
    const { system } = withRecordedLog('terminate-beside-terminator');
    const shutdown = system.extension(CoordinatedShutdownId);
    const order: string[] = [];
    void system.whenTerminated().then(() => { order.push('system down'); });
    // Same phase as the terminator, which starts first and has already begun
    // the teardown by the time this asks.
    shutdown.addTask(Phases.ActorSystemTerminate, 'beside-the-terminator', async () => {
      await system.terminate();
      order.push('terminate() returned');
    });

    await shutdown.run(ActorSystemTerminateReason.instance);

    expect(order).toEqual(['terminate() returned', 'system down']);
  });

  test('the built-in terminator is not such a call: the system is down before the next phase', async () => {
    const { system } = withRecordedLog('terminator-inside-its-phase');
    const shutdown = system.extension(CoordinatedShutdownId);
    shutdown.addPhase({
      name: 'after-actor-system-terminate',
      timeoutMs: 1_000,
      dependsOn: [Phases.ActorSystemTerminate],
      recover: true,
    });
    const seen: boolean[] = [];
    shutdown.addTask('after-actor-system-terminate', 'observe', () => { seen.push(system.isTerminated); });

    await shutdown.run(ActorSystemTerminateReason.instance);

    expect(seen).toEqual([true]);
  });

  test('a run that ends without the terminator is followed by the teardown it was asked for', async () => {
    const { system } = withRecordedLog('terminate-behind-run', { 'terminate-actor-system': false });
    const shutdown = system.extension(CoordinatedShutdownId);
    const seen: boolean[] = [];
    shutdown.addTask(Phases.ServiceUnbind, 'asks-for-terminate', async () => { await system.terminate(); });
    shutdown.addTask(Phases.ActorSystemTerminate, 'last', () => { seen.push(system.isTerminated); });

    await shutdown.run(ActorSystemTerminateReason.instance);

    expect(seen).toEqual([false]);
    await awaitCondition(() => system.isTerminated, {
      label: 'the terminate() asked for during the run took the system down after it',
    });
  });

  test('so is a run that halts', async () => {
    const { system } = withRecordedLog('terminate-behind-halt', {
      phases: { 'service-stop': { recover: false } },
    });
    const shutdown = system.extension(CoordinatedShutdownId);
    const seen: string[] = [];
    shutdown.addTask(Phases.ServiceUnbind, 'asks-for-terminate', () => { void system.terminate(); });
    shutdown.addTask(Phases.ServiceRequestsDone, 'between', () => {
      seen.push(`accepts spawns=${acceptsSpawns(system)}`);
    });
    shutdown.addTask(Phases.ServiceStop, 'throws', () => { throw new Error('boom'); });

    await expect(shutdown.run(ActorSystemTerminateReason.instance)).rejects.toThrow('boom');

    expect(seen).toEqual(['accepts spawns=true']);
    await awaitCondition(() => system.isTerminated, {
      label: 'the terminate() asked for during the halted run took the system down after it',
    });
  });

  test('once the run has settled, terminate() is the ordinary teardown again', async () => {
    const { system } = withRecordedLog('terminate-after-settled-run', { 'terminate-actor-system': false });
    const shutdown = system.extension(CoordinatedShutdownId);
    await shutdown.run(ActorSystemTerminateReason.instance);
    expect(system.isTerminated).toBe(false);

    await system.terminate();

    expect(system.isTerminated).toBe(true);
  });
});
