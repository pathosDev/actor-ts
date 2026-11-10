import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  conventionalActorModule,
  conventionalActorModuleCandidates,
  entryModuleUrl,
} from '../../../src/runtime/entry/EntryModule.js';

const ENTRY = new URL('../parallelism/__fixtures__/entry/main.ts', import.meta.url);

describe('entry module seam (#1563)', () => {
  test('the entry is a file URL of the script the runtime was asked to run', () => {
    // Under `bun test` that is a test file — this one when it runs alone,
    // the first one named when several are, so only the shape is asserted.
    const entry = entryModuleUrl();
    expect(entry).not.toBeNull();
    expect(entry!.protocol).toBe('file:');
    expect(entry!.pathname.endsWith('.test.ts')).toBe(true);
  });

  test('a file: argv[1] and a plain path both resolve; no argv[1] is null', () => {
    const argv = process.argv;
    try {
      process.argv = [argv[0]!, fileURLToPath(ENTRY)];
      expect(entryModuleUrl()!.href).toBe(ENTRY.href);
      process.argv = [argv[0]!, ENTRY.href];
      expect(entryModuleUrl()!.href).toBe(ENTRY.href);
      process.argv = [argv[0]!];
      expect(entryModuleUrl()).toBeNull();
    } finally {
      process.argv = argv;
    }
  });

  test('the conventional module is actors.<ext> beside the entry, the entry’s own extension first', () => {
    expect(conventionalActorModuleCandidates(ENTRY).map((url) => url.pathname.split('/').pop())).toEqual([
      'actors.ts', 'actors.js', 'actors.mjs',
    ]);
    const compiled = new URL('./main.js', ENTRY);
    expect(conventionalActorModuleCandidates(compiled).map((url) => url.pathname.split('/').pop())).toEqual([
      'actors.js', 'actors.mjs', 'actors.ts',
    ]);
    expect(conventionalActorModule(ENTRY)!.href).toBe(new URL('./actors.ts', ENTRY).href);
    expect(conventionalActorModule(new URL('../../PathPattern.test.ts', ENTRY))).toBeNull();
  });
});
