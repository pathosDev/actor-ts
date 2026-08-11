import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import {
  MessageChannelTransport,
  type BrokeredMessage,
  type PortLike,
} from '../../../../src/cluster/transports/MessageChannelTransport.js';
import type { WireMessage } from '../../../../src/cluster/Protocol.js';
import { WorkerBroker } from '../../../../src/worker/WorkerBroker.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/**
 * `MessagePort` delivery is a task, not a microtask, and under load the
 * scheduler is free to run it whenever — so a 10 ms budget is a bet, not
 * a bound.  The collector array is the delivery itself (#418).
 */
function awaitDelivered(collected: ReadonlyArray<unknown>, count: number, what: string): Promise<void> {
  return awaitCondition(() => collected.length === count, {
    timeoutMs: 4_000, label: `${what}: ${count} message(s) crossed the port`,
  });
}

/** Pair two in-process ports that pretend to be a MessageChannel. */
function makePair(): [PortLike, PortLike] {
  const ch = new MessageChannel();
  return [ch.port1 as unknown as PortLike, ch.port2 as unknown as PortLike];
}

describe('MessageChannelTransport', () => {
  test('posts framed BrokeredMessages containing from/to/payload', async () => {
    const nodeA = new NodeAddress('sys', 'worker', 1);
    const nodeB = new NodeAddress('sys', 'worker', 2);
    const [brokerPort, workerPort] = makePair();

    const transport = new MessageChannelTransport(nodeA, workerPort);
    await transport.start();

    const received: BrokeredMessage[] = [];
    brokerPort.onmessage = (e) => { received.push(e.data as BrokeredMessage); };
    brokerPort.start?.();

    const wire: WireMessage = { kind: 'heartbeat', from: nodeA.toJSON(), seq: 1, ts: 0 };
    transport.send(nodeB, wire);
    await awaitDelivered(received, 1, 'outbound framing');

    expect(received.length).toBe(1);
    const env = received[0]!;
    expect(env.from).toEqual(nodeA.toJSON());
    expect(env.to).toEqual(nodeB.toJSON());
    expect(env.payload).toEqual(wire);

    await transport.shutdown();
  });

  test('inbound BrokeredMessages are delivered to the handler', async () => {
    const self = new NodeAddress('sys', 'worker', 1);
    const peer = new NodeAddress('sys', 'worker', 2);
    const [brokerPort, workerPort] = makePair();

    const transport = new MessageChannelTransport(self, workerPort);
    const seen: Array<{ from: string; payload: WireMessage }> = [];
    transport.setHandler((from, payload) => seen.push({ from: from.toString(), payload }));
    await transport.start();

    const env: BrokeredMessage = {
      from: peer.toJSON(),
      to: self.toJSON(),
      payload: { kind: 'heartbeat', from: peer.toJSON(), seq: 42, ts: 0 },
    };
    brokerPort.postMessage(env);
    await awaitDelivered(seen, 1, 'inbound handler');

    expect(seen.length).toBe(1);
    expect(seen[0]!.from).toBe(peer.toString());
    expect(seen[0]!.payload.kind).toBe('heartbeat');

    await transport.shutdown();
  });

  test('send is a no-op after shutdown', async () => {
    const [brokerPort, workerPort] = makePair();
    const self = new NodeAddress('sys', 'h', 1);
    const transport = new MessageChannelTransport(self, workerPort);
    await transport.start();

    const captured: unknown[] = [];
    brokerPort.onmessage = (e) => captured.push(e.data);
    brokerPort.start?.();

    await transport.shutdown();

    transport.send(new NodeAddress('sys', 'h', 2), { kind: 'heartbeat', from: self.toJSON(), seq: 1, ts: 0 });
    // Fixed wait on purpose: the claim is that nothing crosses the port.
    await sleep(10);
    expect(captured.length).toBe(0);
  });

  test('peers() reflects addresses seen via inbound messages', async () => {
    const self = new NodeAddress('sys', 'h', 1);
    const peer1 = new NodeAddress('sys', 'h', 2);
    const peer2 = new NodeAddress('sys', 'h', 3);
    const [brokerPort, workerPort] = makePair();
    const transport = new MessageChannelTransport(self, workerPort);
    const handled: unknown[] = [];
    transport.setHandler(() => { handled.push(null); });
    await transport.start();

    brokerPort.postMessage({
      from: peer1.toJSON(), to: self.toJSON(),
      payload: { kind: 'heartbeat', from: peer1.toJSON(), seq: 1, ts: 0 },
    });
    brokerPort.postMessage({
      from: peer2.toJSON(), to: self.toJSON(),
      payload: { kind: 'heartbeat', from: peer2.toJSON(), seq: 2, ts: 0 },
    });
    await awaitDelivered(handled, 2, 'peer discovery');

    const peers = transport.peers().map(p => p.toString()).sort();
    expect(peers).toEqual([peer1.toString(), peer2.toString()].sort());

    await transport.shutdown();
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

    tA.send(addrB, { kind: 'heartbeat', from: addrA.toJSON(), seq: 7, ts: 0 });
    await awaitDelivered(seenB, 1, 'broker routing');

    expect(seenB.length).toBe(1);
    expect(seenB[0]!.kind).toBe('heartbeat');

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
      kind: 'heartbeat', from: addrA.toJSON(), seq: 1, ts: 0,
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
    tA.send(addrB, { kind: 'heartbeat', from: addrA.toJSON(), seq: 1, ts: 0 });
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
    for (const nodeA of addrs) {
      const [p] = makePair();
      broker.register(nodeA, p);
    }
    const reg = broker.registered().map(x => x.toString()).sort();
    expect(reg).toEqual(addrs.map(x => x.toString()).sort());
    broker.close();
  });
});
