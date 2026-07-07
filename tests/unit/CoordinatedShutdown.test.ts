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
import { LogLevel, NoopLogger } from '../../src/Logger.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const newSystem = (name = 'cs-unit'): ActorSystem =>
  ActorSystem.create(name, ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));

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
    const p = cs.run();
    expect(cs.isRunning).toBe(true);
    await p;
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
