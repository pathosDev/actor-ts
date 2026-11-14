/**
 * #931 — a native Bun socket no longer drops what the kernel will not take.
 *
 * `Bun.Socket.write` answers with how many bytes the kernel took and keeps
 * none of the rest: on Bun 1.4.2 a socket whose peer was not reading took
 * seven 64 KiB writes and answered `0` to every one after, and `-1` once it
 * had closed.  `BunSocket` keeps the remainder, writes it on Bun's `drain`,
 * and queues every later write behind it.  Driven with a native stand-in whose
 * kernel takes a set number of bytes per call, so every byte that reaches the
 * "wire" can be compared with what was written.
 */
import { describe, expect, test } from 'bun:test';
import { BunSocket } from '../../../../src/runtime/tcp/BunTcpBackend.js';

type NativeStandIn = ConstructorParameters<typeof BunSocket>[0] & {
  /** Bytes the kernel will take on the next calls, shared across them. */
  room: number;
  closed: boolean;
  readonly wire: number[];
  ended: boolean;
  terminated: boolean;
};

function nativeStandIn(room: number): NativeStandIn {
  return {
    room,
    closed: false,
    wire: [],
    ended: false,
    terminated: false,
    write(data: Uint8Array | string): number {
      if (this.closed) return -1;
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const taken = Math.min(this.room, bytes.byteLength);
      for (let i = 0; i < taken; i++) this.wire.push(bytes[i]!);
      this.room -= taken;
      return taken;
    },
    end(): void { this.ended = true; },
    terminate(): void { this.terminated = true; },
  };
}

/** `count` bytes counting up from `start`, so a dropped or reordered byte shows. */
function run(start: number, count: number): Uint8Array {
  return Uint8Array.from({ length: count }, (_, i) => (start + i) % 256);
}

describe('BunSocket keeps what the kernel did not take (#931)', () => {
  test('a write the kernel takes whole answers true', () => {
    const native = nativeStandIn(100);
    const socket = new BunSocket(native);

    expect(socket.write(run(0, 40))).toBe(true);
    expect(native.wire).toEqual([...run(0, 40)]);
  });

  test('a partial write answers false and the remainder goes out on drain', () => {
    const native = nativeStandIn(10);
    const socket = new BunSocket(native);

    expect(socket.write(run(0, 40))).toBe(false);
    expect(native.wire).toHaveLength(10);

    native.room = 1_000;
    expect(socket.flushBacklog()).toBe(true);
    expect(native.wire).toEqual([...run(0, 40)]);
  });

  test('writes made while the backlog is held queue behind it, in order', () => {
    const native = nativeStandIn(5);
    const socket = new BunSocket(native);

    expect(socket.write(run(0, 20))).toBe(false);
    // The kernel has room again, but these must not overtake the backlog.
    native.room = 1_000;
    expect(socket.write(run(20, 20))).toBe(false);
    expect(socket.write(run(40, 20))).toBe(false);
    expect(native.wire).toHaveLength(5);

    expect(socket.flushBacklog()).toBe(true);
    expect(native.wire).toEqual([...run(0, 60)]);
    expect(socket.write(run(60, 5))).toBe(true);
    expect(native.wire).toEqual([...run(0, 65)]);
  });

  test('a drain the kernel only partly absorbs keeps the rest for the next one', () => {
    const native = nativeStandIn(0);
    const socket = new BunSocket(native);
    socket.write(run(0, 30));
    socket.write(run(30, 30));

    native.room = 25;
    expect(socket.flushBacklog()).toBe(false);
    native.room = 25;
    expect(socket.flushBacklog()).toBe(false);
    native.room = 25;
    expect(socket.flushBacklog()).toBe(true);
    expect(native.wire).toEqual([...run(0, 60)]);
  });

  test('the caller may reuse its buffer once write returns', () => {
    const native = nativeStandIn(4);
    const socket = new BunSocket(native);
    const buffer = run(0, 16);

    socket.write(buffer);
    buffer.fill(0xee);
    native.room = 1_000;
    socket.flushBacklog();

    expect(native.wire).toEqual([...run(0, 16)]);
  });

  test('end() waits for the backlog before it half-closes', () => {
    const native = nativeStandIn(4);
    const socket = new BunSocket(native);
    socket.write(run(0, 16));

    socket.end();
    expect(native.ended).toBe(false);
    expect(socket.write(run(16, 4))).toBe(false);

    native.room = 1_000;
    socket.flushBacklog();
    expect(native.ended).toBe(true);
    // A write after end() is refused, not appended after the FIN.
    expect(native.wire).toEqual([...run(0, 16)]);
  });

  test('a closed socket answers false and holds nothing', () => {
    const native = nativeStandIn(4);
    const socket = new BunSocket(native);
    socket.write(run(0, 16));

    native.closed = true;
    expect(socket.flushBacklog()).toBe(false);
    native.closed = false;
    native.room = 1_000;
    expect(socket.flushBacklog()).toBe(true);
    expect(native.wire).toHaveLength(4);
  });

  test('destroy() discards the backlog and terminates', () => {
    const native = nativeStandIn(4);
    const socket = new BunSocket(native);
    socket.write(run(0, 16));

    socket.destroy();
    native.room = 1_000;
    socket.flushBacklog();

    expect(native.terminated).toBe(true);
    expect(native.wire).toHaveLength(4);
  });
});
