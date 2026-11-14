/**
 * `ReadableStream` response bodies — what every backend must do with them,
 * succeeding or failing, is part of the shared HTTP backend contract suite
 * (`tests/integration/in-process/http/HttpBackendSuite.ts`, #990).
 *
 * What is left here is `HttpExtension`'s own half of #979: it wires a
 * backend's stream-failure hook to the system log, so a failure after the
 * response was committed — the one no error handler can answer any more — is
 * still seen by an operator.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { get } from '../../../src/http/Route.js';
import { Status } from '../../../src/http/Types.js';
import { LogLevel, type Logger } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const live: Array<{ binding: ServerBinding; system: ActorSystem }> = [];
afterEach(async () => {
  while (live.length) {
    const { binding, system } = live.shift()!;
    await binding.unbind();
    await system.terminate();
  }
});

/** One chunk, then a source that fails — `pull` runs a macrotask late, so the chunk is on the wire first. */
function failingAfterFirstChunk(first: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!sent) {
        sent = true;
        controller.enqueue(first);
        return;
      }
      throw new Error('upstream row cursor died');
    },
  });
}

/** Whether the response body completed cleanly; a response that never settles rethrows as the hang it is. */
async function completedCleanly(url: string): Promise<boolean> {
  const signal = AbortSignal.timeout(4_000);
  try {
    const response = await fetch(url, { signal });
    await response.text();
    return true;
  } catch (e) {
    if (signal.aborted) throw new Error(`no outcome within 4 s for ${url}: the response hung`, { cause: e });
    return false;
  }
}

describe('a committed stream failure reaches the system log (#979)', () => {
  test('a failure after the response was committed is logged once, with the error', async () => {
    const errors: Array<{ message: string; args: unknown[] }> = [];
    const recording: Logger = {
      level: LogLevel.Debug,
      debug() {}, info() {}, warn() {},
      error(message: string, ...args: unknown[]) { errors.push({ message, args }); },
      withSource() { return recording; },
      withFields() { return recording; },
    };
    const systemOptions = ActorSystemOptions.create().withLogger(recording).withLogLevel(LogLevel.Debug);
    const system = ActorSystem.create('http-stream-committed-failure', systemOptions);
    const encoder = new TextEncoder();
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new ExpressBackend())
      .bind(get(() => ({ status: Status.OK, body: failingAfterFirstChunk(encoder.encode('first chunk;')) })));
    live.push({ binding, system });
    expect(await completedCleanly(`http://${binding.host}:${binding.port}/`)).toBe(false);
    await awaitCondition(() => errors.length > 0, { timeoutMs: 2_000, label: 'the stream failure was logged' });
    const streamFailures = errors.filter((e) => e.message.includes('response body stream failed'));
    expect(streamFailures.length).toBe(1);
    expect(streamFailures[0]!.message).toContain('GET /:');
    expect((streamFailures[0]!.args[0] as Error).message).toBe('upstream row cursor died');
  });
});
