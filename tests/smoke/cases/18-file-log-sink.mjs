/**
 * Smoke case: the file log sink (#1153).
 *
 * This is the one sink whose correctness lives entirely in runtime
 * territory.  It holds a **long-lived append handle** — the first one in
 * the codebase — and reaches it through a lazy `node:fs/promises` import
 * rather than a per-runtime adapter, on the argument that Bun's and Deno's
 * Node compatibility layers both cover `open(path, 'a')`, the partial-write
 * loop, `readdir` and `unlink`.  That argument is exactly the kind that a
 * unit test on Bun cannot check: it is a claim about the other two
 * runtimes.
 *
 * The failure modes it guards are not type errors either.  A runtime whose
 * `FileHandle.write` reports bytes differently produces a torn line; one
 * that resolves `mkdir(recursive)` differently produces no file at all and
 * a sink that quietly disabled itself.  Both look like "the logs are just
 * missing" in production.
 *
 * So: write through a real `ActorSystem`, terminate it — which is also
 * what flushes the sink — and assert the file exists, is whole, and
 * contains what was logged.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const name = 'file log sink';
export const description = 'append handle + rotation naming + flush on terminate, on every runtime';

export async function run({ actorTs }) {
  const { ActorSystem, ActorSystemOptions, FileSink, FileSinkOptions, LogLevel } = actorTs;

  const directory = await mkdtemp(join(tmpdir(), 'actor-ts-smoke-log-'));
  try {
    const fileSinkOptions = FileSinkOptions.create()
      .withDirectory(directory)
      .withMinLevel(LogLevel.Debug)
      .withRotateInterval('off');
    const systemOptions = ActorSystemOptions.create()
      .withLogSinks([new FileSink(fileSinkOptions)])
      .withLogLevel(LogLevel.Debug);
    const system = ActorSystem.create('smoke-file-sink', systemOptions);

    system.log.info('first record');
    system.log.withSource('actor-ts://smoke/user/worker').warn('second record');

    // terminate() is the flush: nothing above was necessarily on disk yet.
    await system.terminate();

    const names = await readdir(directory);
    if (names.length !== 1) {
      throw new Error(`expected exactly one log file, got ${JSON.stringify(names)}`);
    }
    if (!/^log-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.txt$/.test(names[0])) {
      throw new Error(`log file name is not the stamped shape: ${names[0]}`);
    }

    const body = await readFile(join(directory, names[0]), 'utf8');
    for (const expected of ['first record', 'second record', 'actor-ts://smoke/user/worker']) {
      if (!body.includes(expected)) {
        throw new Error(`log file is missing ${JSON.stringify(expected)}: ${JSON.stringify(body)}`);
      }
    }

    const lines = body.split('\n').filter(Boolean);
    if (lines.length !== 2) {
      throw new Error(`expected 2 whole lines, got ${lines.length}: ${JSON.stringify(body)}`);
    }
    for (const line of lines) {
      // A partial write would leave a line without its timestamp head.
      if (!/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] (INFO |WARN )/.test(line)) {
        throw new Error(`torn or malformed log line: ${JSON.stringify(line)}`);
      }
    }
    if (!body.endsWith('\n')) {
      throw new Error('log file does not end with a newline — the last write was cut short');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
