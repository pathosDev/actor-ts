/**
 * WorkerBroker tests — the broker is the main-thread routing layer
 * between workers in a multi-core cluster.  Each worker hosts its own
 * MessagePort; the broker forwards `BrokeredMessage` envelopes by
 * looking up `to` in its registry.  We exercise registration,
 * unregistration, message routing, and close semantics against the
 * `FakePort` shim — no real worker spawned.
 */
import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { BrokeredMessage } from '../../../src/cluster/transports/MessageChannelTransport.js';
import { WorkerBroker } from '../../../src/worker/WorkerBroker.js';
import { FakePort } from './__fixtures__/in-memory-worker-thread.js';

const addr = (port: number): NodeAddress => new NodeAddress('sys', 'host', port);

function envelope(from: NodeAddress, to: NodeAddress): BrokeredMessage {
  return {
    from: from.toJSON(),
    to: to.toJSON(),
    payload: { kind: 'ping' } as unknown as BrokeredMessage['payload'],
  };
}

describe('WorkerBroker — register / unregister', () => {
  test('register hooks the port and starts it', () => {
    const broker = new WorkerBroker();
    const port = new FakePort();
    broker.register(addr(1), port);
    expect(port.onmessage).toBeTypeOf('function');
    expect(port.started).toBe(true);
  });

  test('duplicate register throws', () => {
    const broker = new WorkerBroker();
    const address = addr(1);
    broker.register(address, new FakePort());
    expect(() => broker.register(address, new FakePort()))
      .toThrow(/already registered/);
  });

  test('unregister closes the port and clears the slot', () => {
    const broker = new WorkerBroker();
    const address = addr(1);
    const port = new FakePort();
    broker.register(address, port);
    broker.unregister(address);
    expect(port.closed).toBe(true);
    expect(port.onmessage).toBeNull();
    // After unregister: registered() should no longer include it.
    expect(broker.registered().map(x => x.toString())).not.toContain(address.toString());
  });

  test('unregister of unknown address is a no-op', () => {
    const broker = new WorkerBroker();
    expect(() => broker.unregister(addr(99))).not.toThrow();
  });

  test('registered() returns a snapshot of NodeAddress values', () => {
    const broker = new WorkerBroker();
    broker.register(addr(1), new FakePort());
    broker.register(addr(2), new FakePort());
    broker.register(addr(3), new FakePort());
    const out = broker.registered().map(address => address.toString()).sort();
    expect(out).toEqual(['sys@host:1', 'sys@host:2', 'sys@host:3']);
  });
});

describe('WorkerBroker — routing', () => {
  test('forwards messages to the registered destination port', () => {
    const broker = new WorkerBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    // Inject a message into aPort destined for addr(2).
    const env = envelope(addr(1), addr(2));
    aPort.inject(env);

    // Routed to bPort verbatim.
    expect(bPort.posted).toEqual([env]);
    // aPort doesn't receive its own message.
    expect(aPort.posted).toEqual([]);
  });

  test('drops messages destined for unknown addresses silently', () => {
    const broker = new WorkerBroker();
    const aPort = new FakePort();
    broker.register(addr(1), aPort);

    aPort.inject(envelope(addr(1), addr(999)));
    // Nothing crashed; the unknown destination has nowhere to forward
    // to.  The other workers (only addr(1) here) see nothing either.
    expect(aPort.posted).toEqual([]);
  });

  test('after close(), further messages are dropped', () => {
    const broker = new WorkerBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    broker.close();

    aPort.inject(envelope(addr(1), addr(2)));
    expect(aPort.closed).toBe(true);
    expect(bPort.closed).toBe(true);
    expect(bPort.posted).toEqual([]);
  });

  test('close() empties the registry', () => {
    const broker = new WorkerBroker();
    broker.register(addr(1), new FakePort());
    broker.register(addr(2), new FakePort());
    broker.close();
    expect(broker.registered()).toEqual([]);
  });

  test('messages route correctly across more than two workers', () => {
    const broker = new WorkerBroker();
    const p1 = new FakePort();
    const p2 = new FakePort();
    const p3 = new FakePort();
    broker.register(addr(1), p1);
    broker.register(addr(2), p2);
    broker.register(addr(3), p3);

    p1.inject(envelope(addr(1), addr(3)));
    p2.inject(envelope(addr(2), addr(1)));

    expect(p3.posted.length).toBe(1);
    expect((p3.posted[0] as BrokeredMessage).from.port).toBe(1);
    expect(p1.posted.length).toBe(1);
    expect((p1.posted[0] as BrokeredMessage).from.port).toBe(2);
    expect(p2.posted).toEqual([]);
  });
});
