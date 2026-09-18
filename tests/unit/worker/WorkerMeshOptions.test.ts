import { describe, expect, test } from 'bun:test';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import {
  WorkerMeshOptions,
  WorkerMeshOptionsValidator,
  type WorkerMeshOptionsType,
} from '../../../src/worker/WorkerMeshOptions.js';

/**
 * The `WorkerMeshOptions` family (#1562): every builder method lands in the
 * field the lockstep rule names, and the validator refuses the shapes the
 * mesh cannot run with — for the module the same allow-list a worker
 * bootstrap is held to (#776), because the worker will execute it.
 */
describe('WorkerMeshOptionsBuilder', () => {
  test('every withX lands in field x', () => {
    const onDown = (): void => {};
    const backend = { containsWorkerErrors: true, spawn: () => { throw new Error('unused'); } };
    const options = WorkerMeshOptions.create()
      .withModule(['file:///a.js', new URL('file:///b.js')])
      .withBootstrap('file:///boot.js')
      .withWorkers(3)
      .withMainHostname('front')
      .withMainPort(7)
      .withWorkerHostname('core')
      .withBasePort(20)
      .withMainRoles(['frontend'])
      .withWorkerRoles(['compute'])
      .withReadyTimeoutMs(1_234)
      .withRestartPolicy('always')
      .withRestartMinBackoffMs(10)
      .withRestartMaxBackoffMs(100)
      .withRestartRandomFactor(0.5)
      .withMaxRestarts(3)
      .withRestartWindowMs(9_999)
      .withOnWorkerPermanentlyDown(onDown)
      .withBackend(backend) as unknown as WorkerMeshOptionsType;

    expect(options.module).toEqual(['file:///a.js', new URL('file:///b.js')]);
    expect(options.bootstrap).toBe('file:///boot.js');
    expect(options.workers).toBe(3);
    expect(options.mainHostname).toBe('front');
    expect(options.mainPort).toBe(7);
    expect(options.workerHostname).toBe('core');
    expect(options.basePort).toBe(20);
    expect(options.mainRoles).toEqual(['frontend']);
    expect(options.workerRoles).toEqual(['compute']);
    expect(options.readyTimeoutMs).toBe(1_234);
    expect(options.restartPolicy).toBe('always');
    expect(options.restartMinBackoffMs).toBe(10);
    expect(options.restartMaxBackoffMs).toBe(100);
    expect(options.restartRandomFactor).toBe(0.5);
    expect(options.maxRestarts).toBe(3);
    expect(options.restartWindowMs).toBe(9_999);
    expect(options.onWorkerPermanentlyDown).toBe(onDown);
    expect(options.backend).toBe(backend);
  });
});

describe('WorkerMeshOptionsValidator', () => {
  const check = (s: Partial<WorkerMeshOptionsType>): void =>
    new WorkerMeshOptionsValidator().validate({ module: 'file:///actors.js', ...s });

  test('accepts the defaults with a module', () => {
    expect(() => check({})).not.toThrow();
  });

  test('requires a module, and holds every module and the bootstrap to the file: no-host rule', () => {
    expect(() => new WorkerMeshOptionsValidator().validate({})).toThrow(/module is required/);
    expect(() => check({ module: './actors.js' })).toThrow(/module must be an absolute URL/);
    expect(() => check({ module: 'https://example.test/actors.js' })).toThrow(/module must use the file: scheme/);
    expect(() => check({ module: 'file://share/actors.js' })).toThrow(/module must be a host-less file: URL/);
    expect(() => check({ module: ['file:///ok.js', 'data:text/javascript,1'] })).toThrow(/module must use the file: scheme/);
    expect(() => check({ bootstrap: 'https://example.test/boot.js' })).toThrow(/bootstrap must use the file: scheme/);
    expect(() => check({ module: 'file://localhost/actors.js' })).not.toThrow();
  });

  test('refuses a worker count that is neither a positive integer nor auto', () => {
    expect(() => check({ workers: 0 })).toThrow(OptionsError);
    expect(() => check({ workers: 1.5 })).toThrow(OptionsError);
    expect(() => check({ workers: 'auto' })).not.toThrow();
    expect(() => check({ workers: 4 })).not.toThrow();
  });

  test('refuses equal hostnames — the two sides are told apart by hostname', () => {
    expect(() => check({ mainHostname: 'same', workerHostname: 'same' }))
      .toThrow(/workerHostname must differ from mainHostname \('same'\)/);
    expect(() => check({ mainHostname: '' })).toThrow(OptionsError);
    expect(() => check({ workerHostname: '' })).toThrow(OptionsError);
  });

  test('bounds the ports and the restart knobs the way the worker cluster does', () => {
    expect(() => check({ mainPort: 0 })).toThrow(OptionsError);
    expect(() => check({ basePort: 70_000 })).toThrow(OptionsError);
    expect(() => check({ readyTimeoutMs: 0 })).toThrow(OptionsError);
    expect(() => check({ restartPolicy: 'sometimes' as never })).toThrow(OptionsError);
    expect(() => check({ restartMinBackoffMs: -1 })).toThrow(OptionsError);
    expect(() => check({ restartMaxBackoffMs: -1 })).toThrow(OptionsError);
    expect(() => check({ restartRandomFactor: 2 })).toThrow(OptionsError);
    expect(() => check({ restartWindowMs: -1 })).toThrow(OptionsError);
    expect(() => check({ maxRestarts: -2 })).toThrow(OptionsError);
    expect(() => check({ restartMinBackoffMs: 500, restartMaxBackoffMs: 100 }))
      .toThrow(/restartMaxBackoffMs must be >= restartMinBackoffMs \(500\)/);
  });
});
