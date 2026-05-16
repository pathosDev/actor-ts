import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import {
  MessageChannelTransport,
  type BrokeredMessage,
  type PortLike,
} from '../../../../src/cluster/transports/MessageChannelTransport.js';
import type { WireMessage } from '../../../../src/cluster/Protocol.js';
import { WorkerBroker } from '../../../../src/worker/WorkerBroker.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/** Pair two in-process ports that pretend to be a MessageChannel. */
function makePair(): [PortLike, PortLike] {
  const ch = new MessageChannel();
  return [ch.port1 as unknown as PortLike, ch.port2 as unknown as PortLike];
}

describe('MessageChannelTransport', () => {
  test('posts framed BrokeredMessages containing from/to/payload', async () => {
    const a = new NodeAddress('sys', 'worker', 1);
    const b = new NodeAddress('sys', 'worker', 2);
    const [brokerPort, workerPort] = makePair();

    const t = new MessageChannelTransport(a, workerPort);
    await t.start();

    const received: BrokeredMessage[] = [];
    brokerPort.onmessage = (e) => { received.push(e.data as BrokeredMessage); };
    brokerPort.start?.();

    const wire: WireMessage = { t: 'heartbeat', from: a.toJSON(), seq: 1, ts: 0 };
    t.send(b, wire);
    await sleep(10);

    expect(received.length).toBe(1);
    const env = received[0]!;
    expect(env.from).toEqual(a.toJSON());
    expect(env.to).toEqual(b.toJSON());
    expect(env.payload).toEqual(wire);

    await t.shutdown();
  });

  test('inbound BrokeredMessages are delivered to the handler', async () => {
    const self = new NodeAddress('sys', 'worker', 1);
    const peer = new NodeAddress('sys', 'worker', 2);
    const [brokerPort, workerPort] = makePair();

    const t = new MessageChannelTransport(self, workerPort);
    const seen: Array<{ from: string; payload: WireMessage }> = [];
    t.setHandler((from, payload) => seen.push({ from: from.toString(), payload }));
    await t.start();

    const env: BrokeredMessage = {
      from: peer.toJSON(),
      to: self.toJSON(),
      payload: { t: 'heartbeat', from: peer.toJSON(), seq: 42, ts: 0 },
    };
    brokerPort.postMessage(env);
    await sleep(10);

    expect(seen.length).toBe(1);
    expect(seen[0]!.from).toBe(peer.toString());
    expect(seen[0]!.payload.t).toBe('heartbeat');

    await t.shutdown();
  });

  test('send is a no-op after shutdown', async () => {
    const [brokerPort, workerPort] = makePair();
    const self = new NodeAddress('sys', 'h', 1);
    const t = new MessageChannelTransport(self, workerPort);
    await t.start();

    const captured: unknown[] = [];
    brokerPort.onmessage = (e) => captured.push(e.data);
    brokerPort.start?.();

    await t.shutdown();

    t.send(new NodeAddress('sys', 'h', 2), { t: 'heartbeat', from: self.toJSON(), seq: 1, ts: 0 });
    await sleep(10);
    expect(captured.length).toBe(0);
  });

  test('peers() reflects addresses seen via inbound messages', async () => {
    const self = new NodeAddress('sys', 'h', 1);
    const peer1 = new NodeAddress('sys', 'h', 2);
    const peer2 = new NodeAddress('sys', 'h', 3);
    const [brokerPort, workerPort] = makePair();
    const t = new MessageChannelTransport(self, workerPort);
    t.setHandler(() => {});
    await t.start();

    brokerPort.postMessage({
      from: peer1.toJSON(), to: self.toJSON(),
      payload: { t: 'heartbeat', from: peer1.toJSON(), seq: 1, ts: 0 },
    });
    brokerPort.postMessage({
      from: peer2.toJSON(), to: self.toJSON(),
      payload: { t: 'heartbeat', from: peer2.toJSON(), seq: 2, ts: 0 },
    });
    await sleep(10);

    const peers = t.peers().map(p => p.toString()).sort();
    expect(peers).toEqual([peer1.toString(), peer2.toString()].sort());

    await t.shutdown();
  });
});

describe('WorkerBroker', () => {
  test('routes a message from one transport to another', async () => {
    const broker = new WorkerBroker();

    const addrA = new NodeAddress('sys', 'w', 1);
    const addrB = new NodeAddress('sys', 'w', 2);

    const [bpA, wpA] = makePair();
    const [bpB, wpB] = makePair();
    broker.register(addrA, bpA);
    broker.register(addrB, bpB);

    const tA = new MessageChannelTransport(addrA, wpA);
    const tB = new MessageChannelTransport(addrB, wpB);

    const seenB: WireMessage[] = [];
    tB.setHandler((_from, m) => seenB.push(m));
    tA.setHandler(() => {});
    await tA.start(); await tB.start();

    tA.send(addrB, { t: 'heartbeat', from: addrA.toJSON(), seq: 7, ts: 0 });
    await sleep(15);

    expect(seenB.length).toBe(1);
    expect(seenB[0]!.t).toBe('heartbeat');

    await tA.shutdown(); await tB.shutdown();
    broker.close();
  });

  test('drops messages addressed to unregistered nodes', async () => {
    const broker = new WorkerBroker();
    const addrA = new NodeAddress('sys', 'w', 1);
    const [bpA, wpA] = makePair();
    broker.register(addrA, bpA);
    const tA = new MessageChannelTransport(addrA, wpA);
    await tA.start();
    expect(() => tA.send(new NodeAddress('sys', 'w', 99), {
      t: 'heartbeat', from: addrA.toJSON(), seq: 1, ts: 0,
    })).not.toThrow();
    await tA.shutdown();
    broker.close();
  });

  test('duplicate address registration is rejected', async () => {
    const broker = new WorkerBroker();
    const [p1] = makePair();
    const [p2] = makePair();
    const addr = new NodeAddress('sys', 'w', 1);
    broker.register(addr, p1);
    expect(() => broker.register(addr, p2)).toThrow(/already registered/);
    broker.close();
  });

  test('unregister removes the entry so it becomes unreachable', async () => {
    const broker = new WorkerBroker();
    const addrA = new NodeAddress('sys', 'w', 1);
    const addrB = new NodeAddress('sys', 'w', 2);
    const [bpA, wpA] = makePair();
    const [bpB, wpB] = makePair();
    broker.register(addrA, bpA);
    broker.register(addrB, bpB);

    const tA = new MessageChannelTransport(addrA, wpA);
    const tB = new MessageChannelTransport(addrB, wpB);
    const seen: WireMessage[] = [];
    tB.setHandler((_f, m) => seen.push(m));
    await tA.start(); await tB.start();

    broker.unregister(addrB);
    tA.send(addrB, { t: 'heartbeat', from: addrA.toJSON(), seq: 1, ts: 0 });
    await sleep(10);
    expect(seen.length).toBe(0);

    await tA.shutdown();
    broker.close();
  });

  test('registered() lists current members', async () => {
    const broker = new WorkerBroker();
    const addrs = [
      new NodeAddress('sys', 'w', 1),
      new NodeAddress('sys', 'w', 2),
      new NodeAddress('sys', 'w', 3),
    ];
    for (const a of addrs) {
      const [p] = makePair();
      broker.register(a, p);
    }
    const reg = broker.registered().map(x => x.toString()).sort();
    expect(reg).toEqual(addrs.map(x => x.toString()).sort());
    broker.close();
  });
});
