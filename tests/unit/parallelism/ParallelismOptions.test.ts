import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import {
  ParallelismOptions,
  ParallelismOptionsValidator,
  readParallelismOptionsFromConfig,
  withParallelismConfigDefaults,
} from '../../../src/parallelism/ParallelismOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

const validator = new ParallelismOptionsValidator();

describe('ParallelismOptionsValidator (#1563)', () => {
  test('workers: 0, a positive integer or auto', () => {
    for (const workers of [0, 1, 8, 'auto'] as const) {
      expect(() => validator.validate({ workers })).not.toThrow();
    }
    for (const workers of [-1, 1.5, Number.NaN]) {
      expect(() => validator.validate({ workers })).toThrow(OptionsError);
    }
  });

  test('an offload pattern that could reach /system is refused, and the error names the role-based route', () => {
    for (const source of ['/system/*', '/*', '/**']) {
      let caught: unknown;
      try { validator.validate({ offload: [source] }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(OptionsError);
      const message = (caught as Error).message;
      expect(message).toContain('/system');
      expect(message).toContain('actor-ts.worker-mesh.worker-roles');
      expect(message).toContain('actor-ts.parallelism.leader');
    }
    // A bare `**` never gets as far as the tree check: it is not a path.
    expect(() => validator.validate({ offload: ['**'] })).toThrow(/must start with/);
    expect(() => validator.validate({ offload: ['/user/*', '/user/resize-*'] })).not.toThrow();
  });

  test('offload: non-empty, absolute, strings', () => {
    expect(() => validator.validate({ offload: [] })).toThrow(OptionsError);
    expect(() => validator.validate({ offload: ['user/*'] })).toThrow(/must start with/);
    expect(() => validator.validate({ offload: [42 as unknown as string] })).toThrow(OptionsError);
  });

  test('placement and leader are closed enums; the timeout and the buffer have their domains', () => {
    expect(() => validator.validate({ placement: 'random' as never })).toThrow(OptionsError);
    expect(() => validator.validate({ leader: 'nobody' as never })).toThrow(OptionsError);
    expect(() => validator.validate({ spawnTimeoutMs: 0 })).toThrow(OptionsError);
    expect(() => validator.validate({ bufferSize: -1 })).toThrow(OptionsError);
    expect(() => validator.validate({ bufferSize: 0, spawnTimeoutMs: 1, placement: 'round-robin', leader: 'worker' }))
      .not.toThrow();
  });

  test('module and bootstrap follow the worker bootstrap URL rules', () => {
    expect(() => validator.validate({ module: './actors.js' })).toThrow(/absolute URL/);
    expect(() => validator.validate({ module: 'https://example.com/actors.js' })).toThrow(/file: scheme/);
    expect(() => validator.validate({ module: 'file://server/share/actors.js' })).toThrow(/host-less/);
    expect(() => validator.validate({ module: ['file:///a.js', new URL('file:///b.js')] })).not.toThrow();
    expect(() => validator.validate({ bootstrap: 'data:text/javascript,1' })).toThrow(OptionsError);
  });
});

describe('actor-ts.parallelism config block', () => {
  test('every leaf is read, and workers takes both spellings', () => {
    const config = Config.parseString(`
      actor-ts.parallelism {
        workers = auto
        offload = ["/user/remote-*"]
        placement = "round-robin"
        leader = "worker"
        spawn-timeout = 2s
        buffer-size = 12
      }
    `);
    expect(readParallelismOptionsFromConfig(config)).toEqual({
      workers: 'auto',
      offload: ['/user/remote-*'],
      placement: 'round-robin',
      leader: 'worker',
      spawnTimeoutMs: 2_000,
      bufferSize: 12,
    });
    expect(readParallelismOptionsFromConfig(Config.parseString('actor-ts.parallelism.workers = 3')).workers).toBe(3);
  });

  test('explicit options win over HOCON, and unset fields fall through', () => {
    const config = Config.parseString('actor-ts.parallelism { workers = 3, placement = "round-robin" }');
    const explicit = ParallelismOptions.create().withWorkers(5);
    const merged = withParallelismConfigDefaults(explicit, config);
    expect(merged.workers).toBe(5);
    expect(merged.placement).toBe('round-robin');
  });
});
