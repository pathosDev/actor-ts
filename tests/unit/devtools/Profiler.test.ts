import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Props } from '../../../src/Props.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ProfilerTap } from '../../../src/devtools/taps/ProfilerTap.js';
import type { DevToolsRequestHandler, DevToolsServer } from '../../../src/devtools/DevToolsServer.js';
import type {
  DevToolsRequestMethod,
  DevToolsStreamPayload,
  ProfilerCapabilitiesResult,
  ProfilerStartResult,
  ProfilerStopResult,
} from '../../../src/devtools/protocol/index.js';

class WorkerActor extends Actor<string> {
  override async onReceive(message: string): Promise<void> {
    if (message === 'boom') throw new Error('handler exploded');
    if (message === 'slow') await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
});

function newSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

function fakeServer(): {
  server: DevToolsServer;
  invoke: <T>(method: DevToolsRequestMethod, parameters?: unknown) => Promise<T>;
} {
  const handlers = new Map<DevToolsRequestMethod, DevToolsRequestHandler>();
  const server = {
    registerMethod(method: DevToolsRequestMethod, handler: DevToolsRequestHandler): void {
      handlers.set(method, handler);
    },
  } as unknown as DevToolsServer;
  return {
    server,
    invoke: <T>(method: DevToolsRequestMethod, parameters?: unknown): Promise<T> => {
      const handler = handlers.get(method);
      if (handler === undefined) throw new Error(`not registered: ${method}`);
      return handler(parameters) as Promise<T>;
    },
  };
}

const settle = (ms = 120): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The extras the panel reads off a wallclock profile. */
function bucketsOf(result: ProfilerStopResult): ReadonlyArray<{
  actorPath: string; className: string; messageType: string;
  count: number; totalMs: number; errors: number;
}> {
  return (result.profile as { actorTs: { buckets: never[] } }).actorTs.buckets;
}

describe('ProfilerTap — wallclock', () => {
  test('aggregates handled messages by actor and message type', async () => {
    const system = newSystem('prof-basic');
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      const ref = system.spawn(Props.create(() => new WorkerActor()), 'worker');
      await invoke<ProfilerStartResult>('profiler.start', {});
      ref.tell('a');
      ref.tell('b');
      await settle();
      const result = await invoke<ProfilerStopResult>('profiler.stop');

      expect(result.mode).toBe('wallclock');
      expect(result.format).toBe('speedscope');
      expect(result.sampleCount).toBe(2);
      const buckets = bucketsOf(result);
      const worker = buckets.find((b) => b.actorPath.endsWith('/worker'))!;
      expect(worker.count).toBe(2);
      expect(worker.className).toBe('WorkerActor');
      expect(worker.messageType).toBe('String');
    } finally {
      tap.uninstall();
    }
  });

  test('records time actually spent in the handler', async () => {
    const system = newSystem('prof-time');
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      const ref = system.spawn(Props.create(() => new WorkerActor()), 'worker');
      await invoke('profiler.start', {});
      ref.tell('slow');
      await settle(150);
      const result = await invoke<ProfilerStopResult>('profiler.stop');
      expect(bucketsOf(result)[0]!.totalMs).toBeGreaterThan(15);
    } finally {
      tap.uninstall();
    }
  });

  test('counts failing handlers separately', async () => {
    const system = newSystem('prof-errors');
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      const ref = system.spawn(Props.create(() => new WorkerActor()), 'worker');
      await invoke('profiler.start', {});
      ref.tell('boom');
      await settle();
      const result = await invoke<ProfilerStopResult>('profiler.stop');
      expect(bucketsOf(result).some((bucket) => bucket.errors > 0)).toBe(true);
    } finally {
      tap.uninstall();
    }
  });

  test('emits a document speedscope can open', async () => {
    const system = newSystem('prof-speedscope');
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      const ref = system.spawn(Props.create(() => new WorkerActor()), 'worker');
      await invoke('profiler.start', {});
      ref.tell('a');
      await settle();
      const result = await invoke<ProfilerStopResult>('profiler.stop');

      const profile = result.profile as {
        $schema: string;
        shared: { frames: { name: string }[] };
        profiles: { type: string; unit: string; samples: number[][]; weights: number[] }[];
      };
      expect(profile.$schema).toContain('speedscope');
      expect(profile.profiles[0]!.type).toBe('sampled');
      expect(profile.profiles[0]!.unit).toBe('milliseconds');
      // Every sample is a stack of valid frame indices, same length as
      // its weight list — the two invariants speedscope relies on.
      expect(profile.profiles[0]!.samples.length).toBe(profile.profiles[0]!.weights.length);
      for (const sample of profile.profiles[0]!.samples) {
        for (const index of sample) {
          expect(profile.shared.frames[index]).toBeDefined();
        }
      }
    } finally {
      tap.uninstall();
    }
  });

  test('the stack ends with the message type, so the leaf is the handler', async () => {
    const system = newSystem('prof-stack');
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      const ref = system.spawn(Props.create(() => new WorkerActor()), 'worker');
      await invoke('profiler.start', {});
      ref.tell('a');
      await settle();
      const result = await invoke<ProfilerStopResult>('profiler.stop');
      const profile = result.profile as {
        shared: { frames: { name: string }[] };
        profiles: { samples: number[][] }[];
      };
      const stack = profile.profiles[0]!.samples[0]!.map((i) => profile.shared.frames[i]!.name);
      expect(stack[0]).toBe('user');
      expect(stack[stack.length - 1]).toBe('String (WorkerActor)');
    } finally {
      tap.uninstall();
    }
  });
});

describe('ProfilerTap — lifecycle', () => {
  test('costs nothing before a session starts', async () => {
    const system = newSystem('prof-idle');
    const tap = new ProfilerTap(system);
    tap.install(() => {});
    try {
      expect(system._dispatchObserver).toBeNull();
      const ref = system.spawn(Props.create(() => new WorkerActor()), 'worker');
      ref.tell('a');
      await settle();
      expect(system._dispatchObserver).toBeNull();
    } finally {
      tap.uninstall();
    }
  });

  test('removes the observer again on stop', async () => {
    const system = newSystem('prof-cleanup');
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      await invoke('profiler.start', {});
      expect(system._dispatchObserver).not.toBeNull();
      await invoke('profiler.stop');
      expect(system._dispatchObserver).toBeNull();
    } finally {
      tap.uninstall();
    }
  });

  test('uninstall stops a running session, so a closed tab leaves no hook', async () => {
    const system = newSystem('prof-abort');
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    await invoke('profiler.start', {});
    expect(system._dispatchObserver).not.toBeNull();

    tap.uninstall();
    await settle(30);
    expect(system._dispatchObserver).toBeNull();
  });

  test('refuses a second concurrent session', async () => {
    const system = newSystem('prof-single');
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      await invoke('profiler.start', {});
      await expect(invoke('profiler.start', {})).rejects.toThrow(/already running/);
    } finally {
      tap.uninstall();
    }
  });

  test('stopping without a session is an error, not a silent empty profile', async () => {
    const system = newSystem('prof-nostart');
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      await expect(invoke('profiler.stop')).rejects.toThrow(/no profiling session/);
    } finally {
      tap.uninstall();
    }
  });

  test('rejects an absurd duration', async () => {
    const system = newSystem('prof-duration');
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      await expect(invoke('profiler.start', { durationMs: 0 })).rejects.toThrow(/durationMs/);
      await expect(invoke('profiler.start', { durationMs: 60 * 60 * 1000 }))
        .rejects.toThrow(/durationMs/);
    } finally {
      tap.uninstall();
    }
  });

  test('reports progress while running', async () => {
    const system = newSystem('prof-progress');
    const emitted: DevToolsStreamPayload[] = [];
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install((payload) => emitted.push(payload));
    tap.installMethods(server);
    try {
      const ref = system.spawn(Props.create(() => new WorkerActor()), 'worker');
      await invoke('profiler.start', {});
      ref.tell('a');
      await settle(700);
      const progress = emitted.filter((p) => p.kind === 'profiler-progress');
      expect(progress.length).toBeGreaterThan(0);
      await invoke('profiler.stop');
    } finally {
      tap.uninstall();
    }
  });

  test('a new subscriber gets no stale profile', () => {
    // A profile is produced by a run; replaying an old one would show a
    // measurement the developer did not take.
    const system = newSystem('prof-snapshot');
    const tap = new ProfilerTap(system);
    tap.install(() => {});
    expect(tap.snapshot()).toEqual([]);
    tap.uninstall();
  });
});

describe('ProfilerTap — capabilities', () => {
  test('wallclock is always available; CPU answers for this runtime', async () => {
    const system = newSystem('prof-capabilities');
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      const capabilities = await invoke<ProfilerCapabilitiesResult>('profiler.capabilities');
      const wallclock = capabilities.modes.find((m) => m.mode === 'wallclock');
      const cpu = capabilities.modes.find((m) => m.mode === 'cpu');

      expect(wallclock).toEqual({ mode: 'wallclock', available: true });
      expect(cpu).toBeDefined();
      // Whatever the answer is on this host, an unavailable mode must
      // carry a reason — that string is what the panel shows instead of
      // letting Start fail.
      if (!cpu!.available) expect(cpu!.reason).toBeTruthy();
    } finally {
      tap.uninstall();
    }
  });

  test('starting an unsupported CPU profile fails with our message, not the runtime\'s', async () => {
    const system = newSystem('prof-cpu-refusal');
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      const capabilities = await invoke<ProfilerCapabilitiesResult>('profiler.capabilities');
      const cpu = capabilities.modes.find((m) => m.mode === 'cpu')!;
      if (cpu.available) return;   // Nothing to assert on a host that has an inspector.

      await expect(invoke<ProfilerStartResult>('profiler.start', { mode: 'cpu' }))
        .rejects.toThrow('CPU profiling is not available here');
      // The failed start must not leave a session behind.
      await expect(invoke('profiler.stop')).rejects.toThrow('no profiling session is running');
    } finally {
      tap.uninstall();
    }
  });
});
