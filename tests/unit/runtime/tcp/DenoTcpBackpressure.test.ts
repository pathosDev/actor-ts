/**
 * #931 on Deno — the adapter's own back-pressure accounting, reached under
 * `bun test` through a stubbed `Deno` global.
 *
 * A `Deno.Conn`'s writer queues every write whatever its `desiredSize` says, so
 * `DenoTcpBackend` counts the queued bytes itself and answers `false` once they
 * reach a 64 KiB mark, then calls `onDrain` once they fall back under it.  The
 * smoke case (`tests/smoke/cases/60-tcp-transport-backpressure.mjs`) runs that
 * on real Deno, but writes 64 KiB chunks against the 64 KiB mark and only
 * counts that some drain arrived — so the boundary, a drain with no `false`
 * before it, a repeated drain and an answer that is falsy without being
 * `false` (which `Transport` reads with `=== false`) all pass it.  Here the
 * stand-in connection's writer settles each write when the test says so.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { DenoTcpBackend } from '../../../../src/runtime/tcp/DenoTcpBackend.js';
import type { TcpSocketLike } from '../../../../src/runtime/tcp/TcpBackend.js';

/** `DENO_WRITE_HIGH_WATER_MARK_BYTES`, module-private in the adapter. */
const MARK_BYTES = 64 * 1024;

/** One write the stand-in writer holds until the test releases it. */
type HeldWrite = { readonly bytes: number; release(): Promise<void> };

/** A `Deno.Conn` whose writer completes each write on demand; its readable yields nothing until closed. */
class HeldWriteConnection {
  readonly writes: HeldWrite[] = [];
  private finish: () => void = () => {};
  readonly readable = new ReadableStream<Uint8Array>({
    start: (controller) => { this.finish = () => controller.close(); },
  });
  readonly writable = {
    getWriter: () => ({
      write: (data: Uint8Array): Promise<void> => {
        let resolve: () => void = () => {};
        const written = new Promise<void>((settle) => { resolve = settle; });
        this.writes.push({
          bytes: data.byteLength,
          // Awaiting the promise itself runs the adapter's completion handler
          // first: it registered on the same promise, earlier.
          release: async () => { resolve(); await written; },
        });
        return written;
      },
      close: (): Promise<void> => Promise.resolve(),
    }),
  };
  readonly remoteAddr = { hostname: '127.0.0.1', port: 2_552 };

  close(): void { this.finish(); }
}

describe('DenoTcpBackend back-pressure accounting (#931)', () => {
  const realDeno = (globalThis as { Deno?: unknown }).Deno;
  const setDeno = (value: unknown): void => {
    Object.defineProperty(globalThis, 'Deno', { value, configurable: true, writable: true });
  };
  afterEach(() => { setDeno(realDeno); });

  async function dial(): Promise<{ socket: TcpSocketLike; connection: HeldWriteConnection; drains: () => number }> {
    const connection = new HeldWriteConnection();
    setDeno({ connect: async () => connection });
    let drains = 0;
    const socket = await new DenoTcpBackend().connect({
      host: '127.0.0.1',
      port: 2_552,
      handlers: {
        onOpen: () => {},
        onData: () => {},
        onClose: () => {},
        onError: () => {},
        onDrain: () => { drains += 1; },
      },
    });
    return { socket, connection, drains: () => drains };
  }

  test('a write below the mark answers true, and its completion calls no drain', async () => {
    const { socket, connection, drains } = await dial();

    expect(socket.write(new Uint8Array(1))).toBe(true);
    expect(socket.write(new Uint8Array(MARK_BYTES - 2))).toBe(true);
    await connection.writes[0]!.release();
    await connection.writes[1]!.release();

    // No `false` came before, so nobody is waiting to be told to resume.
    expect(drains()).toBe(0);
    socket.end();
  });

  test('the write that brings the queue to the mark answers exactly false', async () => {
    const { socket, connection } = await dial();

    expect(socket.write(new Uint8Array(MARK_BYTES - 1))).toBe(true);
    // `Transport` pauses on `=== false`: a falsy `undefined` would never stop it.
    expect(socket.write(new Uint8Array(1))).toBe(false);
    for (const write of connection.writes) await write.release();
    socket.end();
  });

  test('onDrain fires once, only after a false, and only below the mark', async () => {
    const { socket, connection, drains } = await dial();

    expect(socket.write(new Uint8Array(1))).toBe(true);
    expect(socket.write(new Uint8Array(MARK_BYTES))).toBe(false);

    // The queue is back to exactly the mark: still not below it.
    await connection.writes[0]!.release();
    expect(drains()).toBe(0);

    await connection.writes[1]!.release();
    expect(drains()).toBe(1);

    // Drained: a later write that completes under the mark owes nobody a drain.
    expect(socket.write(new Uint8Array(1))).toBe(true);
    await connection.writes[2]!.release();
    expect(drains()).toBe(1);
    socket.end();
  });

  test('a write after end() answers false, and an ended socket is not drained', async () => {
    const { socket, connection, drains } = await dial();

    expect(socket.write(new Uint8Array(MARK_BYTES))).toBe(false);
    socket.end();
    expect(socket.write(new Uint8Array(1))).toBe(false);

    await connection.writes[0]!.release();
    expect(connection.writes).toHaveLength(1);
    expect(drains()).toBe(0);
  });
});
