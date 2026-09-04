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
import { hostileEnvelopes } from '../../util/HostileFrames.js';
import { FakePort } from './__fixtures__/InMemoryWorkerThread.js';

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

  test('register after close() is refused and does not repopulate the registry', () => {
    const broker = new WorkerBroker();
    broker.register(addr(1), new FakePort());
    broker.close();

    // A respawn that lost the race with shutdown.  Without the guard the port
    // is retained for the process lifetime while `onMessage` drops all of its
    // traffic — inert, and holding its worker alive (#735).
    const late = new FakePort();
    broker.register(addr(2), late);
    expect(broker.registered()).toEqual([]);
    expect(late.onmessage).toBeNull();
    expect(late.started).toBe(false);
    expect(late.closed).toBe(true);
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

/* ------------------------------------------------------------------------ */
/* #701 — a malformed frame must not reach `NodeAddress.fromJSON`            */
/* ------------------------------------------------------------------------ */

describe('WorkerBroker — malformed frames', () => {
  /**
   * Every case in {@link hostileEnvelopes} used to throw out of `onMessage`,
   * i.e. out of the host's worker `message` listener, where nothing catches it:
   * Node re-raises it as an `uncaughtException` and Bun exits 1.  One frame
   * from one worker took the whole process down.
   *
   * The table lives in `tests/util/HostileFrames.ts` because three suites need
   * exactly it — this one, the testkit broker fork's, and the transport
   * contract test #945 added — and the two that had it inline said so in a
   * comment while the third had no malformed case at all.
   */
  for (const [label, frame] of hostileEnvelopes) {
    test(`drops a frame with ${label} instead of throwing`, () => {
      const broker = new WorkerBroker();
      const aPort = new FakePort();
      const bPort = new FakePort();
      broker.register(addr(1), aPort);
      broker.register(addr(2), bPort);

      expect(() => aPort.inject(frame)).not.toThrow();
      expect(bPort.posted).toEqual([]);
      expect(aPort.posted).toEqual([]);
    });
  }

  test('a hostile frame does not stop the next well-formed one from routing', () => {
    const broker = new WorkerBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    aPort.inject({ from: addr(1).toJSON(), to: null });
    const good = envelope(addr(1), addr(2));
    aPort.inject(good);

    expect(bPort.posted).toEqual([good]);
  });
});

/* ------------------------------------------------------------------------ */
/* #774 — `from` names the port the frame arrived on, not what it claims     */
/* ------------------------------------------------------------------------ */

describe('WorkerBroker — sender identity comes from the channel', () => {
  /**
   * **Exploit walkthrough (pre-fix).**  `onMessage` took the registration key
   * as `_sourceKey`, marked it unused, and re-posted the frame verbatim.  The
   * receiving `MessageChannelTransport` builds its peer identity from
   * `env.from` and hands it to `Cluster.handleWire`, so a worker that wrote a
   * sibling's address into `from` refreshed that sibling's failure-detector
   * timer at every other node — a dead worker kept looking alive, blocking
   * singleton and shard failover — and had its envelopes attributed to the
   * sibling for reply routing and every `maySpeakFor` rule.  This is the
   * worker-mesh counterpart of `tests/multi-node/ClusterSecurity.test.ts`'s
   * "a heartbeat is credited to the connection, not to the address it names".
   */
  test('a forged `from` is rewritten to the sending port\'s registered address', () => {
    const broker = new WorkerBroker();
    const p1 = new FakePort();
    const p2 = new FakePort();
    const p3 = new FakePort();
    broker.register(addr(1), p1);
    broker.register(addr(2), p2);
    broker.register(addr(3), p3);

    // p1 is registered as addr(1) and claims to be addr(2).
    p1.inject(envelope(addr(2), addr(3)));

    expect(p3.posted.length).toBe(1);
    expect((p3.posted[0] as BrokeredMessage).from.port).toBe(1);
    // The impersonated worker learns nothing about the attempt either.
    expect(p2.posted).toEqual([]);
  });

  /**
   * The other half of the pair: a guard that rewrote every frame, or dropped
   * every frame, would satisfy the test above and be useless.  `toBe` and not
   * `toEqual` — an honest frame must come out as the *same object*, which is
   * what says the equality fast path took it rather than a rebuilt copy that
   * merely compares equal.
   */
  test('an honest frame is forwarded verbatim, not rebuilt', () => {
    const broker = new WorkerBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    const honest = envelope(addr(1), addr(2));
    aPort.inject(honest);

    expect(bPort.posted.length).toBe(1);
    expect(bPort.posted[0]).toBe(honest);
  });

  test('a `from` naming an address nobody registered is corrected too', () => {
    const broker = new WorkerBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    aPort.inject(envelope(addr(999), addr(2)));

    expect(bPort.posted.length).toBe(1);
    expect((bPort.posted[0] as BrokeredMessage).from.port).toBe(1);
  });

  /**
   * Pins the boundary the fix deliberately stops at.  `toString`, `equals` and
   * `compareTo` all exclude the incarnation, so the slot is the identity every
   * consumer keys on and the slot is what gets corrected; the incarnation
   * stays the sender's own claim while #940 keeps it carried-but-not-acted-on.
   * When a merge rule first keys on it, this test is the one that has to
   * change — deliberately, in that commit.
   */
  test('an incarnation on an otherwise-honest `from` is passed through (#940)', () => {
    const broker = new WorkerBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    const claimed = new NodeAddress('sys', 'host', 1, 'a-claimed-incarnation');
    aPort.inject(envelope(claimed, addr(2)));

    expect(bPort.posted.length).toBe(1);
    expect((bPort.posted[0] as BrokeredMessage).from.incarnation)
      .toBe('a-claimed-incarnation');
  });

  test('a forged frame for an unknown destination is still dropped', () => {
    const broker = new WorkerBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    aPort.inject(envelope(addr(2), addr(999)));

    expect(aPort.posted).toEqual([]);
    expect(bPort.posted).toEqual([]);
  });
});
