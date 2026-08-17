import { afterEach, describe, expect, test } from 'bun:test';
import { setRuntimeOverride } from '../../../src/runtime/Detect.js';
import {
  BunProcessSignals,
  DenoProcessSignals,
  NodeProcessSignals,
  getProcessSignals,
  resetProcessSignalsCache,
  setProcessSignalsOverride,
} from '../../../src/runtime/signals/index.js';

/**
 * The runtime signal backend behind `installProcessHooks` (#549).
 *
 * The Deno half cannot be exercised on Bun for real, so the tests below
 * drive it against a stand-in `Deno` global.  That is the whole point of the
 * abstraction: the branch that decides *not* to register SIGTERM on Windows
 * is reachable and assertable from the runtime the suite happens to run on,
 * instead of being a claim only CI's ubuntu matrix could ever check.
 */

type DenoStub = {
  addSignalListener(signal: string, handler: () => void): void;
  removeSignalListener(signal: string, handler: () => void): void;
  build: { os: string };
  added: string[];
  removed: string[];
};

const globalScope = globalThis as { Deno?: unknown };

function installDenoStub(os: string): DenoStub {
  const stub: DenoStub = {
    added: [],
    removed: [],
    build: { os },
    addSignalListener(signal) { stub.added.push(signal); },
    removeSignalListener(signal) { stub.removed.push(signal); },
  };
  globalScope.Deno = stub;
  return stub;
}

afterEach(() => {
  delete globalScope.Deno;
  setProcessSignalsOverride(null);
  resetProcessSignalsCache();
  setRuntimeOverride(null);
});

describe('process-signal backend selection', () => {
  test('follows the detected runtime', () => {
    setRuntimeOverride('node');
    resetProcessSignalsCache();
    expect(getProcessSignals().runtime).toBe('Node.js');

    setRuntimeOverride('bun');
    resetProcessSignalsCache();
    expect(getProcessSignals().runtime).toBe('Bun');

    setRuntimeOverride('deno');
    resetProcessSignalsCache();
    expect(getProcessSignals().runtime).toBe('Deno');
  });

  test('memoises, and the test override wins over the cache', () => {
    setRuntimeOverride('node');
    resetProcessSignalsCache();
    const first = getProcessSignals();
    expect(getProcessSignals()).toBe(first);

    const standIn = new DenoProcessSignals();
    setProcessSignalsOverride(standIn);
    expect(getProcessSignals()).toBe(standIn);
  });
});

describe('process-event backends (Bun, Node)', () => {
  test('add and remove exactly one listener', () => {
    const backend = new NodeProcessSignals();
    const handler = (): void => {};
    const before = process.listenerCount('SIGUSR2');

    backend.add('SIGUSR2', handler);
    expect(process.listenerCount('SIGUSR2')).toBe(before + 1);

    backend.remove('SIGUSR2', handler);
    expect(process.listenerCount('SIGUSR2')).toBe(before);
  });

  test('Bun shares the implementation and differs only in the name it reports', () => {
    expect(new BunProcessSignals()).toBeInstanceOf(NodeProcessSignals);
    expect(new BunProcessSignals().runtime).toBe('Bun');
  });

  test('refuse the two signals no process can catch', () => {
    const backend = new NodeProcessSignals();
    expect(backend.supports('SIGKILL')).toBe(false);
    expect(backend.supports('SIGSTOP')).toBe(false);
    expect(backend.supports('SIGTERM')).toBe(true);
  });

  test('SIGTERM stays supported on Windows — Node accepts it and never fires it', () => {
    // Deliberately NOT gated on `process.platform`: registering it is
    // harmless everywhere, and branching here would mean the shutdown path
    // takes a different shape on the maintainer's box than in CI.
    expect(new NodeProcessSignals().supports('SIGTERM')).toBe(true);
  });
});

describe('DenoProcessSignals', () => {
  test('registers through Deno.addSignalListener, not process.on', () => {
    const stub = installDenoStub('linux');
    const backend = new DenoProcessSignals();
    const handler = (): void => {};
    const beforeProcessListeners = process.listenerCount('SIGTERM');

    backend.add('SIGTERM', handler);
    expect(stub.added).toEqual(['SIGTERM']);
    // The bug this abstraction closes: the old call site used `process.on`,
    // which on Deno registers on a shim that never delivers a signal.
    expect(process.listenerCount('SIGTERM')).toBe(beforeProcessListeners);

    backend.remove('SIGTERM', handler);
    expect(stub.removed).toEqual(['SIGTERM']);
  });

  test('on Windows only the console control events are supported', () => {
    installDenoStub('windows');
    const backend = new DenoProcessSignals();
    expect(backend.supports('SIGINT')).toBe(true);
    expect(backend.supports('SIGBREAK')).toBe(true);
    // Deno *throws* on this one rather than ignoring it, which is why the
    // caller has to ask before registering.
    expect(backend.supports('SIGTERM')).toBe(false);
    expect(backend.supports('SIGHUP')).toBe(false);
  });

  test('on Linux everything catchable that Deno knows by name is supported', () => {
    installDenoStub('linux');
    const backend = new DenoProcessSignals();
    expect(backend.supports('SIGTERM')).toBe(true);
    expect(backend.supports('SIGINT')).toBe(true);
    expect(backend.supports('SIGHUP')).toBe(true);
    expect(backend.supports('SIGKILL')).toBe(false);
    expect(backend.supports('SIGSTOP')).toBe(false);
  });

  test('the four aliases Deno.Signal does not carry are filtered, not forwarded', () => {
    const stub = installDenoStub('linux');
    const backend = new DenoProcessSignals();
    for (const alias of ['SIGIOT', 'SIGLOST', 'SIGPOLL', 'SIGUNUSED'] as const) {
      expect(backend.supports(alias)).toBe(false);
    }
    expect(stub.added).toEqual([]);
  });

  test('supports nothing when there is no Deno global at all', () => {
    expect(new DenoProcessSignals().supports('SIGTERM')).toBe(false);
  });
});
