import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LogLevel } from '../../../src/Logger.js';
import { FileSink } from '../../../src/logging/FileSink.js';
import { FileSinkOptions } from '../../../src/logging/FileSinkOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import type { LogRecord } from '../../../src/logging/LogRecord.js';

/**
 * The file sink is the one sink whose correctness is about the filesystem,
 * so these run against a real temporary directory rather than a fake.
 */

let directory: string;
let consoleErrors: unknown[][] = [];
const originalError = console.error;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'actor-ts-filesink-'));
  consoleErrors = [];
  console.error = ((...args: unknown[]) => { consoleErrors.push(args); }) as typeof console.error;
});
afterEach(() => { console.error = originalError; });

/** A record stamped at a chosen wall-clock time, in local time. */
function at(year: number, month: number, day: number, hour: number, minute: number, second: number, message: string): LogRecord {
  return {
    timestampMs: new Date(year, month - 1, day, hour, minute, second).getTime(),
    level: LogLevel.Info,
    message,
    fields: {},
  };
}

async function namesIn(path: string): Promise<string[]> {
  return (await readdir(path)).sort();
}

async function contentOf(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

describe('FileSink naming', () => {
  it('names the file after the moment it was opened', async () => {
    const sink = new FileSink({ directory, rotateInterval: 'off' });
    sink.write(at(2026, 8, 12, 9, 41, 2, 'first'));
    await sink.close();

    expect(await namesIn(directory)).toEqual(['log-2026-08-12-09-41-02.txt']);
  });

  it('honours a custom prefix and extension', async () => {
    const sink = new FileSink({ directory, prefix: 'audit', extension: 'ndjson', format: 'json', rotateInterval: 'off' });
    sink.write(at(2026, 8, 12, 9, 41, 2, 'first'));
    await sink.close();

    expect(await namesIn(directory)).toEqual(['audit-2026-08-12-09-41-02.ndjson']);
  });

  it('suffixes rather than appending to a file that already exists', async () => {
    await writeFile(join(directory, 'log-2026-08-12-09-41-02.txt'), 'from an earlier run\n');
    const sink = new FileSink({ directory, rotateInterval: 'off' });
    sink.write(at(2026, 8, 12, 9, 41, 2, 'from this run'));
    await sink.close();

    expect(await namesIn(directory)).toEqual([
      'log-2026-08-12-09-41-02-2.txt',
      'log-2026-08-12-09-41-02.txt',
    ]);
    expect(await contentOf(join(directory, 'log-2026-08-12-09-41-02.txt'))).toBe('from an earlier run\n');
  });

  it('writes the text format by default and NDJSON on request', async () => {
    const text = new FileSink({ directory, rotateInterval: 'off' });
    text.write(at(2026, 8, 12, 9, 41, 2, 'human'));
    await text.close();
    const textPath = join(directory, (await namesIn(directory))[0]!);
    expect(await contentOf(textPath)).toContain('] INFO  human');

    const jsonDirectory = await mkdtemp(join(tmpdir(), 'actor-ts-filesink-json-'));
    const json = new FileSink({ directory: jsonDirectory, format: 'json', rotateInterval: 'off' });
    json.write(at(2026, 8, 12, 9, 41, 2, 'machine'));
    await json.close();
    const jsonPath = join(jsonDirectory, (await namesIn(jsonDirectory))[0]!);
    expect(JSON.parse((await contentOf(jsonPath)).trim()).msg).toBe('machine');
  });
});

describe('FileSink rotation', () => {
  it('rolls over on size and keeps every line whole', async () => {
    // One line is ~60 bytes; cap at 200 so a five-record batch spans files.
    const sink = new FileSink({ directory, rotateInterval: 'off', maxFileBytes: 200, maxFiles: 0, maxAgeMs: 0 });
    for (let i = 0; i < 8; i += 1) {
      sink.write(at(2026, 8, 12, 9, 41, i, `record-${i}`));
    }
    await sink.close();

    const names = await namesIn(directory);
    expect(names.length).toBeGreaterThan(1);

    const lines: string[] = [];
    for (const name of names) {
      const body = await contentOf(join(directory, name));
      expect(body.endsWith('\n')).toBe(true);
      for (const line of body.split('\n').filter(Boolean)) {
        // A torn line would be missing its timestamp head or its message.
        expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] INFO {2}record-\d$/);
        lines.push(line);
      }
    }
    expect(lines).toHaveLength(8);
  });

  it('rolls over at the daily boundary, not 24 hours after startup', async () => {
    const sink = new FileSink({ directory, rotateInterval: 'daily', maxFiles: 0, maxAgeMs: 0 });
    sink.write(at(2026, 8, 12, 23, 59, 59, 'before midnight'));
    await sink.flush();
    sink.write(at(2026, 8, 13, 0, 0, 1, 'after midnight'));
    await sink.close();

    const names = await namesIn(directory);
    expect(names).toHaveLength(2);
    expect(names[0]).toStartWith('log-2026-08-12');
    expect(names[1]).toStartWith('log-2026-08-13');
    expect(await contentOf(join(directory, names[0]!))).toContain('before midnight');
    expect(await contentOf(join(directory, names[1]!))).toContain('after midnight');
  });

  it('rolls over hourly when asked', async () => {
    const sink = new FileSink({ directory, rotateInterval: 'hourly', maxFiles: 0, maxAgeMs: 0 });
    sink.write(at(2026, 8, 12, 9, 59, 0, 'in the ninth hour'));
    await sink.flush();
    sink.write(at(2026, 8, 12, 10, 0, 0, 'in the tenth'));
    await sink.close();

    expect(await namesIn(directory)).toHaveLength(2);
  });

  it('stays in one file when rotation is off and no size limit applies', async () => {
    const sink = new FileSink({ directory, rotateInterval: 'off', maxFileBytes: 0 });
    sink.write(at(2026, 8, 12, 9, 0, 0, 'a'));
    await sink.flush();
    sink.write(at(2027, 1, 1, 0, 0, 0, 'much later'));
    await sink.close();

    expect(await namesIn(directory)).toHaveLength(1);
  });
});

describe('FileSink retention', () => {
  it('keeps only the newest maxFiles rotated files', async () => {
    const sink = new FileSink({ directory, rotateInterval: 'daily', maxFiles: 2, maxAgeMs: 0 });
    for (const day of [10, 11, 12, 13, 14]) {
      sink.write(at(2026, 8, day, 12, 0, 0, `day-${day}`));
      await sink.flush();
    }
    await sink.close();

    const names = await namesIn(directory);
    expect(names).toEqual(['log-2026-08-13-12-00-00.txt', 'log-2026-08-14-12-00-00.txt']);
  });

  it('deletes rotated files older than maxAge', async () => {
    const now = Date.now();
    const sink = new FileSink({ directory, rotateInterval: 'hourly', maxFiles: 0, maxAgeMs: 60 * 60 * 1_000 });
    const old = new Date(now - 5 * 60 * 60 * 1_000);
    const recent = new Date(now - 10 * 60 * 1_000);
    sink.write({ timestampMs: old.getTime(), level: LogLevel.Info, message: 'old', fields: {} });
    await sink.flush();
    sink.write({ timestampMs: recent.getTime(), level: LogLevel.Info, message: 'recent', fields: {} });
    await sink.close();

    const names = await namesIn(directory);
    expect(names).toHaveLength(1);
    expect(await contentOf(join(directory, names[0]!))).toContain('recent');
  });

  it('never deletes a file it did not create', async () => {
    await writeFile(join(directory, 'important.txt'), 'keep me\n');
    await writeFile(join(directory, 'other-2020-01-01-00-00-00.txt'), 'another sink\n');
    const sink = new FileSink({ directory, rotateInterval: 'daily', maxFiles: 1, maxAgeMs: 0 });
    for (const day of [10, 11, 12]) {
      sink.write(at(2026, 8, day, 12, 0, 0, `day-${day}`));
      await sink.flush();
    }
    await sink.close();

    const names = await namesIn(directory);
    expect(names).toContain('important.txt');
    expect(names).toContain('other-2020-01-01-00-00-00.txt');
    expect(names.filter((name) => name.startsWith('log-'))).toHaveLength(1);
  });

  it('gzips rotated files and leaves the active one alone', async () => {
    const sink = new FileSink({ directory, rotateInterval: 'daily', compressRotated: true, maxFiles: 0, maxAgeMs: 0 });
    sink.write(at(2026, 8, 12, 12, 0, 0, 'first day'));
    await sink.flush();
    sink.write(at(2026, 8, 13, 12, 0, 0, 'second day'));
    await sink.close();

    const names = await namesIn(directory);
    expect(names).toEqual(['log-2026-08-12-12-00-00.txt.gz', 'log-2026-08-13-12-00-00.txt']);

    const unpacked = gunzipSync(await readFile(join(directory, names[0]!))).toString('utf8');
    expect(unpacked).toContain('first day');
  });
});

describe('FileSink resilience', () => {
  it('disables itself when the directory cannot be written, without throwing', async () => {
    // A path whose parent is a file, so mkdir cannot succeed.
    const blocker = join(directory, 'not-a-directory');
    await writeFile(blocker, 'x');
    const sink = new FileSink({ directory: join(blocker, 'logs') });

    expect(() => sink.write(at(2026, 8, 12, 9, 0, 0, 'nowhere to go'))).not.toThrow();
    await sink.close();

    expect(String(consoleErrors[0]?.[0])).toContain('file logging disabled');
  });

  it('reports the failure only once, not once per flush', async () => {
    const blocker = join(directory, 'blocked');
    await writeFile(blocker, 'x');
    const sink = new FileSink({ directory: join(blocker, 'logs') });

    for (let i = 0; i < 20; i += 1) {
      sink.write(at(2026, 8, 12, 9, 0, 0, `record-${i}`));
      await sink.flush();
    }
    await sink.close();

    expect(consoleErrors).toHaveLength(1);
  });

  it('closes cleanly when it never wrote anything', async () => {
    const sink = new FileSink({ directory });
    await expect(sink.close()).resolves.toBeUndefined();
    expect(await namesIn(directory)).toEqual([]);
  });
});

describe('FileSinkOptions', () => {
  it('accepts the fluent builder', () => {
    const options = FileSinkOptions.create()
      .withDirectory('/var/log/app')
      .withRotateInterval('hourly')
      .withMaxFiles(3);

    expect(new FileSink(options).minLevel).toBe(LogLevel.Info);
  });

  it('rejects a prefix containing a path separator', () => {
    expect(() => new FileSink({ directory, prefix: '../escape' })).toThrow(OptionsError);
  });

  it('rejects an extension containing a dot', () => {
    expect(() => new FileSink({ directory, extension: 'tar.gz' })).toThrow(OptionsError);
  });

  it('rejects an unknown rotate interval', () => {
    expect(() => new FileSink({ directory, rotateInterval: 'weekly' as 'daily' })).toThrow(OptionsError);
  });

  it('rejects a negative size limit', () => {
    expect(() => new FileSink({ directory, maxFileBytes: -1 })).toThrow(OptionsError);
  });

  it('validates the nested delivery block', () => {
    expect(() => new FileSink({ directory, delivery: { maxBatchSize: 0 } }))
      .toThrow(/delivery\.maxBatchSize/);
  });
});
