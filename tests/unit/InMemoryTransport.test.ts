import { describe, expect, test } from 'bun:test';
import { InMemoryTransport } from '../../src/cluster/Transport.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import type { HelloMessage, WireMessage } from '../../src/cluster/Protocol.js';
import { awaitCondition, sleep } from '../util/AwaitCondition.js';

function newTransport(port: number): InMemoryTransport {
  return new InMemoryTransport(new NodeAddress('imt', 'localhost', port));
}

function helloFrom(port: number): HelloMessage {
  return { kind: 'hello', self: new NodeAddress('imt', 'localhost', port).toJSON() };
}

describe('InMemoryTransport', () => {
  test('start + shutdown registers / unregisters from the shared registry', async () => {
    const transportA = newTransport(40001);
    const transportB = newTransport(40002);
    await transportA.start();
    await transportB.start();
    try {
      // Peer list excludes self — should be non-empty once both are up.
      expect(transportA.peers().some(p => p.port === 40002)).toBe(true);
      expect(transportB.peers().some(p => p.port === 40001)).toBe(true);
    } finally {
      await transportA.shutdown();
      await transportB.shutdown();
    }
  });

  test('send delivers to the registered peer handler', async () => {
    const transportA = newTransport(40101);
    const transportB = newTransport(40102);
    const receivedOnB: Array<{ from: NodeAddress; message: WireMessage }> = [];
    transportB.setHandler((from, message) => receivedOnB.push({ from, message }));
    await transportA.start();
    await transportB.start();
    try {
      transportA.send(transportB.self, helloFrom(40101));
      await awaitCondition(() => receivedOnB.length === 1, {
        timeoutMs: 4_000,
        label: 'the peer handler received the frame',
      });
      expect(receivedOnB.length).toBe(1);
      expect(receivedOnB[0]!.from.equals(transportA.self)).toBe(true);
      expect(receivedOnB[0]!.message.kind).toBe('hello');
    } finally {
      await transportA.shutdown(); await transportB.shutdown();
    }
  });

  test('send to a non-existent peer is silently dropped', async () => {
    const transportA = newTransport(40201);
    await transportA.start();
    try {
      expect(() => transportA.send(new NodeAddress('imt', 'localhost', 99999), helloFrom(40201))).not.toThrow();
    } finally {
      await transportA.shutdown();
    }
  });

  test('send from a stopped transport is a no-op', async () => {
    const transportA = newTransport(40301);
    const transportB = newTransport(40302);
    const seen: WireMessage[] = [];
    transportB.setHandler((_, m) => seen.push(m));
    await transportA.start();
    await transportB.start();
    await transportA.shutdown();
    transportA.send(transportB.self, helloFrom(40301));
    await sleep(20);
    expect(seen).toEqual([]);
    await transportB.shutdown();
  });

  test('messages are delivered asynchronously (queueMicrotask)', async () => {
    const transportA = newTransport(40401);
    const transportB = newTransport(40402);
    const seen: WireMessage[] = [];
    transportB.setHandler((_, m) => seen.push(m));
    await transportA.start();
    await transportB.start();
    transportA.send(transportB.self, helloFrom(40401));
    // Immediately after send, delivery has not happened yet — it's a microtask.
    // That half is an absence, so it stays a synchronous read; the delivery
    // half waits on the array the assertion reads.
    expect(seen.length).toBe(0);
    await awaitCondition(() => seen.length === 1, { label: 'the microtask delivered the message' });
    expect(seen.length).toBe(1);
    await transportA.shutdown(); await transportB.shutdown();
  });

  /**
   * Read through B rather than through A's own `peers()`, and this is the whole
   * point of the test rather than a stylistic preference.
   *
   * `InMemoryTransport.registry` is a `private static Map` and `peers()` returns
   * every entry in it except self, so the previous form —
   * `expect(transportA.peers()).toEqual([])` after A's shutdown — asserted that
   * **no transport was registered anywhere in the process**.  `bun test` runs the
   * whole tree in one process and 75 test files construct one, so any suite that
   * left a registration behind falsified it.  That is why it passed alone and
   * failed only in a whole-suite run, with nothing in flight and no wait that
   * could have helped (#290).
   *
   * Narrowing it to the transition this test causes also makes it bind
   * `shutdown()`, which the old form did not.  Measured, by deleting the
   * `registry.delete(…)` line in `src/cluster/Transport.ts`: the old assertion
   * *alone in a fresh process* passes with the deletion and without it — it
   * cannot see A's own leftover registration, because `peers()` filters self out.
   * It did go red inside this file, but only because the tests above it leave
   * registrations behind, so what it detected was its siblings and not its own
   * subject.  The form below goes red on the mutation either way.
   */
  test('shutdown removes the transport from a live peer\'s view', async () => {
    const transportA = newTransport(40501);
    const transportB = newTransport(40502);
    await transportA.start();
    await transportB.start();
    try {
      expect(transportB.peers().some(p => p.port === 40501)).toBe(true);
      await transportA.shutdown();
      expect(transportB.peers().some(p => p.port === 40501)).toBe(false);
    } finally {
      await transportB.shutdown();
    }
  });
});
