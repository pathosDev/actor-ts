/**
 * #931 — `NodeTcpBackend` reports back-pressure and the drain that ends it.
 *
 * A Node socket always queued what the kernel would not take, but the adapter
 * threw away `write`'s answer and listened for no `drain`, so a caller had no
 * way to stop.  Run over real loopback sockets, on whatever `node:net` this
 * runtime provides (Bun's own under `bun test`): the accepted side writes
 * until a write answers `false`, the dialler is reading all along on the same
 * thread, and `onDrain` has to arrive — after which every byte written has.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { NodeTcpBackend } from '../../../../src/runtime/tcp/NodeTcpBackend.js';
import type { TcpListener, TcpSocketHandlers, TcpSocketLike } from '../../../../src/runtime/tcp/TcpBackend.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const CHUNK_BYTES = 64 * 1024;
/** A bound on the loop, far past any loopback buffer: reaching it means `write` never pushed back. */
const MAX_CHUNKS = 256;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function noHandlers(overrides: Partial<TcpSocketHandlers> = {}): TcpSocketHandlers {
  return { onOpen: () => {}, onData: () => {}, onClose: () => {}, onError: () => {}, ...overrides };
}

describe('NodeTcpBackend back-pressure (#931)', () => {
  test('write answers false past the high-water mark, and onDrain follows', async () => {
    const backend = new NodeTcpBackend();
    let accepted: TcpSocketLike | undefined;
    let drains = 0;
    const listener: TcpListener = await backend.listen({
      host: '127.0.0.1',
      port: 0,
      handlers: noHandlers({
        onOpen: (socket) => { accepted = socket; },
        onDrain: () => { drains += 1; },
      }),
    });
    cleanups.push(() => listener.close());

    let receivedBytes = 0;
    const dialled = await backend.connect({
      host: '127.0.0.1',
      port: listener.port,
      handlers: noHandlers({ onData: (_socket, chunk) => { receivedBytes += chunk.byteLength; } }),
    });
    cleanups.push(() => dialled.destroy?.());
    await awaitCondition(() => accepted !== undefined, { timeoutMs: 5_000, intervalMs: 5, label: 'the dial was accepted' });
    cleanups.push(() => accepted!.destroy?.());

    const chunk = new Uint8Array(CHUNK_BYTES).fill(7);
    let written = 0;
    let answer = true;
    while (answer && written < MAX_CHUNKS) {
      answer = accepted!.write(chunk);
      written += 1;
    }

    expect(answer).toBe(false);
    await awaitCondition(() => drains === 1, { timeoutMs: 10_000, intervalMs: 5, label: 'onDrain arrived' });
    await awaitCondition(() => receivedBytes === written * CHUNK_BYTES, {
      timeoutMs: 10_000, intervalMs: 5, label: 'every byte written arrived',
    });
  }, 30_000);

  test('a dialled socket reports its drain too', async () => {
    const backend = new NodeTcpBackend();
    let receivedBytes = 0;
    let accepted: TcpSocketLike | undefined;
    const listener: TcpListener = await backend.listen({
      host: '127.0.0.1',
      port: 0,
      handlers: noHandlers({
        onOpen: (socket) => { accepted = socket; },
        onData: (_socket, chunk) => { receivedBytes += chunk.byteLength; },
      }),
    });
    cleanups.push(() => listener.close());

    let drains = 0;
    const dialled = await backend.connect({
      host: '127.0.0.1',
      port: listener.port,
      handlers: noHandlers({ onDrain: () => { drains += 1; } }),
    });
    cleanups.push(() => dialled.destroy?.());
    await awaitCondition(() => accepted !== undefined, { timeoutMs: 5_000, intervalMs: 5, label: 'the dial was accepted' });
    cleanups.push(() => accepted!.destroy?.());

    const chunk = new Uint8Array(CHUNK_BYTES).fill(9);
    let written = 0;
    let answer = true;
    while (answer && written < MAX_CHUNKS) {
      answer = dialled.write(chunk);
      written += 1;
    }

    expect(answer).toBe(false);
    await awaitCondition(() => drains === 1, { timeoutMs: 10_000, intervalMs: 5, label: 'onDrain arrived' });
    await awaitCondition(() => receivedBytes === written * CHUNK_BYTES, {
      timeoutMs: 10_000, intervalMs: 5, label: 'every byte written arrived',
    });
  }, 30_000);
});
