import { describe, expect, test } from 'bun:test';
import { InMemoryTransport } from '../../src/cluster/Transport.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import type { HelloMessage, WireMessage } from '../../src/cluster/Protocol.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

function newTransport(port: number): InMemoryTransport {
  return new InMemoryTransport(new NodeAddress('imt', 'localhost', port));
}

function helloFrom(port: number): HelloMessage {
  return { t: 'hello', self: new NodeAddress('imt', 'localhost', port).toJSON() };
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
    const receivedOnB: Array<{ from: NodeAddress; msg: WireMessage }> = [];
    transportB.setHandler((from, msg) => receivedOnB.push({ from, msg }));
    await transportA.start();
    await transportB.start();
    try {
      transportA.send(transportB.self, helloFrom(40101));
      await sleep(20);
      expect(receivedOnB.length).toBe(1);
      expect(receivedOnB[0]!.from.equals(transportA.self)).toBe(true);
      expect(receivedOnB[0]!.msg.t).toBe('hello');
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
    expect(seen.length).toBe(0);
    await sleep(10);
    expect(seen.length).toBe(1);
    await transportA.shutdown(); await transportB.shutdown();
  });

  test('peers list is empty after shutdown', async () => {
    const transportA = newTransport(40501);
    await transportA.start();
    expect(transportA.peers()).toBeDefined();
    await transportA.shutdown();
    expect(transportA.peers()).toEqual([]);
  });
});
