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
    const a = newTransport(40001);
    const b = newTransport(40002);
    await a.start();
    await b.start();
    try {
      // Peer list excludes self — should be non-empty once both are up.
      expect(a.peers().some(p => p.port === 40002)).toBe(true);
      expect(b.peers().some(p => p.port === 40001)).toBe(true);
    } finally {
      await a.shutdown();
      await b.shutdown();
    }
  });

  test('send delivers to the registered peer handler', async () => {
    const a = newTransport(40101);
    const b = newTransport(40102);
    const receivedOnB: Array<{ from: NodeAddress; msg: WireMessage }> = [];
    b.setHandler((from, msg) => receivedOnB.push({ from, msg }));
    await a.start();
    await b.start();
    try {
      a.send(b.self, helloFrom(40101));
      await sleep(20);
      expect(receivedOnB.length).toBe(1);
      expect(receivedOnB[0]!.from.equals(a.self)).toBe(true);
      expect(receivedOnB[0]!.msg.t).toBe('hello');
    } finally {
      await a.shutdown(); await b.shutdown();
    }
  });

  test('send to a non-existent peer is silently dropped', async () => {
    const a = newTransport(40201);
    await a.start();
    try {
      expect(() => a.send(new NodeAddress('imt', 'localhost', 99999), helloFrom(40201))).not.toThrow();
    } finally {
      await a.shutdown();
    }
  });

  test('send from a stopped transport is a no-op', async () => {
    const a = newTransport(40301);
    const b = newTransport(40302);
    const seen: WireMessage[] = [];
    b.setHandler((_, m) => seen.push(m));
    await a.start();
    await b.start();
    await a.shutdown();
    a.send(b.self, helloFrom(40301));
    await sleep(20);
    expect(seen).toEqual([]);
    await b.shutdown();
  });

  test('messages are delivered asynchronously (queueMicrotask)', async () => {
    const a = newTransport(40401);
    const b = newTransport(40402);
    const seen: WireMessage[] = [];
    b.setHandler((_, m) => seen.push(m));
    await a.start();
    await b.start();
    a.send(b.self, helloFrom(40401));
    // Immediately after send, delivery has not happened yet — it's a microtask.
    expect(seen.length).toBe(0);
    await sleep(10);
    expect(seen.length).toBe(1);
    await a.shutdown(); await b.shutdown();
  });

  test('peers list is empty after shutdown', async () => {
    const a = newTransport(40501);
    await a.start();
    expect(a.peers()).toBeDefined();
    await a.shutdown();
    expect(a.peers()).toEqual([]);
  });
});
