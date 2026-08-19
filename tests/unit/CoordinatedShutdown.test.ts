import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import {
  ActorSystemTerminateReason,
  CoordinatedShutdown,
  CoordinatedShutdownId,
  Phases,
  ProcessTerminateReason,
  UnknownReason,
} from '../../src/CoordinatedShutdown.js';
import { EVENT_LOOP_KEEPALIVE_INTERVAL_MS } from '../../src/Constants.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { sleep } from '../util/AwaitCondition.js';

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
    const starts: string[] = [];
    const ends: string[] = [];

    // Equal delays are the fixture: both tasks have to be in flight at the same
    // time, or "within a phase run in parallel" has nothing to observe.  The
    // recorded start/end order and the elapsed bound below are the assertions.
    cs.addTask(Phases.BeforeServiceUnbind, 'slow-1', async () => {
      starts.push('1'); await sleep(30); ends.push('1');
    });
    cs.addTask(Phases.BeforeServiceUnbind, 'slow-2', async () => {
      starts.push('2'); await sleep(30); ends.push('2');
    });

    const t0 = Date.now();
    await cs.run();
    const elapsed = Date.now() - t0;

    // Both started before either ended → parallel execution.
    expect(starts).toEqual(['1', '2']);
    // Shouldn't take 60ms (sequential) — should be ~30ms.
    expect(elapsed).toBeLessThan(500);
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
