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
    const b = new WorkerBroker();
    const p = new FakePort();
    b.register(addr(1), p);
    expect(p.onmessage).toBeTypeOf('function');
    expect(p.started).toBe(true);
  });

  test('duplicate register throws', () => {
    const b = new WorkerBroker();
    const a = addr(1);
    b.register(a, new FakePort());
    expect(() => b.register(a, new FakePort()))
      .toThrow(/already registered/);
  });

  test('unregister closes the port and clears the slot', () => {
    const b = new WorkerBroker();
    const a = addr(1);
    const p = new FakePort();
    b.register(a, p);
    b.unregister(a);
    expect(p.closed).toBe(true);
    expect(p.onmessage).toBeNull();
    // After unregister: registered() should no longer include it.
    expect(b.registered().map(x => x.toString())).not.toContain(a.toString());
  });

  test('unregister of unknown address is a no-op', () => {
    const b = new WorkerBroker();
    expect(() => b.unregister(addr(99))).not.toThrow();
  });

  test('registered() returns a snapshot of NodeAddress values', () => {
    const b = new WorkerBroker();
    b.register(addr(1), new FakePort());
    b.register(addr(2), new FakePort());
    b.register(addr(3), new FakePort());
    const out = b.registered().map(a => a.toString()).sort();
    expect(out).toEqual(['sys@host:1', 'sys@host:2', 'sys@host:3']);
  });
});

describe('WorkerBroker — routing', () => {
  test('forwards messages to the registered destination port', () => {
    const b = new WorkerBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    b.register(addr(1), aPort);
    b.register(addr(2), bPort);

    // Inject a message into aPort destined for addr(2).
    const env = envelope(addr(1), addr(2));
    aPort.inject(env);

    // Routed to bPort verbatim.
    expect(bPort.posted).toEqual([env]);
    // aPort doesn't receive its own message.
    expect(aPort.posted).toEqual([]);
  });

  test('drops messages destined for unknown addresses silently', () => {
    const b = new WorkerBroker();
    const aPort = new FakePort();
    b.register(addr(1), aPort);

    aPort.inject(envelope(addr(1), addr(999)));
    // Nothing crashed; the unknown destination has nowhere to forward
    // to.  The other workers (only addr(1) here) see nothing either.
    expect(aPort.posted).toEqual([]);
  });

  test('after close(), further messages are dropped', () => {
    const b = new WorkerBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    b.register(addr(1), aPort);
    b.register(addr(2), bPort);

    b.close();

    aPort.inject(envelope(addr(1), addr(2)));
    expect(aPort.closed).toBe(true);
    expect(bPort.closed).toBe(true);
    expect(bPort.posted).toEqual([]);
  });

  test('close() empties the registry', () => {
    const b = new WorkerBroker();
    b.register(addr(1), new FakePort());
    b.register(addr(2), new FakePort());
    b.close();
    expect(b.registered()).toEqual([]);
  });

  test('messages route correctly across more than two workers', () => {
    const b = new WorkerBroker();
    const p1 = new FakePort();
    const p2 = new FakePort();
    const p3 = new FakePort();
    b.register(addr(1), p1);
    b.register(addr(2), p2);
    b.register(addr(3), p3);

    p1.inject(envelope(addr(1), addr(3)));
    p2.inject(envelope(addr(2), addr(1)));

    expect(p3.posted.length).toBe(1);
    expect((p3.posted[0] as BrokeredMessage).from.port).toBe(1);
    expect(p1.posted.length).toBe(1);
    expect((p1.posted[0] as BrokeredMessage).from.port).toBe(2);
    expect(p2.posted).toEqual([]);
  });
});
